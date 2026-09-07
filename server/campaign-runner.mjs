import { open, readFile, unlink } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { runInNewContext } from 'node:vm'

const apiBase = process.env.DIALER_API || 'http://127.0.0.1:8791/speak/api'
const leadFile = new URL('../src/demoLeads.ts', import.meta.url)
const lockPath = process.env.DIALER_RUNNER_LOCK || '/tmp/speak-campaign-runner.lock'
const workedOutcomes = new Set([
  'completed',
  'no-answer',
  'voicemail',
  'not-interested',
  'do-not-call',
  'skipped',
  'operator-ended',
  'failed',
])

function log(message, extra = {}) {
  const suffix = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ''
  console.log(`${new Date().toISOString()} ${message}${suffix}`)
}

function isPidRunning(pid) {
  if (!pid || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function acquireRunnerLock() {
  try {
    const handle = await open(lockPath, 'wx')
    await handle.writeFile(`${process.pid}\n`)
    return handle
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error

    const existingPid = Number((await readFile(lockPath, 'utf8').catch(() => '')).trim())
    if (isPidRunning(existingPid)) {
      log('campaign runner already active; exiting', { existingPid })
      return null
    }

    await unlink(lockPath).catch(() => {})
    const handle = await open(lockPath, 'wx')
    await handle.writeFile(`${process.pid}\n`)
    return handle
  }
}

async function releaseRunnerLock(handle) {
  if (!handle) return
  await handle.close().catch(() => {})
  await unlink(lockPath).catch(() => {})
}

async function apiJson(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })
  const payload = await response.json().catch(() => ({}))
  return { response, payload }
}

async function loadLeads() {
  const source = await readFile(leadFile, 'utf8')
  const exportIndex = source.indexOf('export const demoLeads')
  const assignmentIndex = source.indexOf('= [', exportIndex)
  const start = assignmentIndex < 0 ? -1 : assignmentIndex + 2
  const end = source.lastIndexOf(']')
  if (exportIndex < 0 || assignmentIndex < 0 || start < 0 || end <= start) {
    throw new Error(`Could not parse leads from ${leadFile.pathname}`)
  }
  const leads = runInNewContext(`(${source.slice(start, end + 1)})`, {}, { timeout: 1000 })
  if (!Array.isArray(leads)) {
    throw new Error(`Parsed lead export is not an array: ${leadFile.pathname}`)
  }
  return leads
}

async function recentCalls() {
  const { response, payload } = await apiJson('/calls/recent?limit=500')
  if (!response.ok) {
    throw new Error(payload.error || `recent calls returned ${response.status}`)
  }
  return payload.calls || []
}

function leadIdFromCall(call) {
  return call?.lead?.id || ''
}

function buildWorkedLeadSet(calls) {
  const worked = new Set()
  calls.forEach((call) => {
    const outcome = call.outcome || ''
    const leadId = leadIdFromCall(call)
    if (leadId && workedOutcomes.has(outcome)) {
      worked.add(leadId)
    }
  })
  return worked
}

function activeCall(calls) {
  return calls.find(
    (call) =>
      call.callControlId &&
      !call.outcome &&
      call.phase &&
      !['idle', 'ended'].includes(call.phase),
  )
}

function isDialable(lead) {
  return (
    lead?.status === 'ready' &&
    typeof lead.phone === 'string' &&
    /^\+[1-9]\d{7,14}$/.test(lead.phone.trim())
  )
}

async function waitForCall(callControlId, lead) {
  log('waiting for active call outcome', {
    callControlId,
    lead: lead.name,
    phone: lead.phone,
  })

  while (true) {
    await delay(3000)
    const calls = await recentCalls()
    const summary = calls.find((call) => call.callControlId === callControlId)
    if (!summary) continue

    if (summary.outcome || ['idle', 'ended'].includes(summary.phase)) {
      log('call finished', {
        callControlId,
        lead: lead.name,
        outcome: summary.outcome || '',
        phase: summary.phase || '',
      })
      return summary
    }
  }
}

async function startLead(lead) {
  log('dialing lead', {
    id: lead.id,
    name: lead.name,
    company: lead.company,
    phone: lead.phone,
  })

  const { response, payload } = await apiJson('/calls/start', {
    method: 'POST',
    body: JSON.stringify({ lead, config: {} }),
  })

  if (!response.ok) {
    log('dial start rejected', {
      id: lead.id,
      name: lead.name,
      status: response.status,
      error: payload.error || 'Call request failed',
      callControlId: payload.callControlId || '',
    })
    return null
  }

  log('dial start accepted', {
    id: lead.id,
    name: lead.name,
    callControlId: payload.callControlId,
  })
  return payload.callControlId
}

async function main() {
  const lockHandle = await acquireRunnerLock()
  if (!lockHandle) return

  const releaseAndExit = () => {
    void releaseRunnerLock(lockHandle).finally(() => process.exit(0))
  }
  process.once('SIGINT', releaseAndExit)
  process.once('SIGTERM', releaseAndExit)

  const leads = await loadLeads()
  try {
    log('campaign runner started', { leadCount: leads.length, apiBase })

    while (true) {
      const calls = await recentCalls()
      const active = activeCall(calls)
      if (active) {
        log('existing active call detected; waiting', {
          callControlId: active.callControlId,
          lead: active.lead?.name || active.lead?.first_name || '',
          phase: active.phase,
        })
        await waitForCall(active.callControlId, {
          id: active.lead?.id || '',
          name: active.lead?.name || active.lead?.first_name || 'Unknown lead',
          phone: active.lead?.phone_on_file || '',
        })
        continue
      }

      const worked = buildWorkedLeadSet(calls)
      const nextLead = leads.find((lead) => isDialable(lead) && !worked.has(lead.id))
      if (!nextLead) {
        log('campaign runner finished; no unworked dialable leads remain')
        return
      }

      const callControlId = await startLead(nextLead)
      if (callControlId) {
        await waitForCall(callControlId, nextLead)
      }
      await delay(2000)
    }
  } finally {
    await releaseRunnerLock(lockHandle)
  }
}

if (process.argv.includes('--check-leads')) {
  loadLeads()
    .then((leads) => log('lead parse ok', { leadCount: leads.length }))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
} else {
  main().catch((error) => {
  console.error(
    `${new Date().toISOString()} campaign runner crashed: ${
      error instanceof Error ? error.stack || error.message : String(error)
    }`,
  )
  process.exitCode = 1
  })
}
