import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { createServer as createViteServer } from 'vite'
import { recentCallSummaries, transcriptEntry } from '../server/call-history.mjs'
import * as transientWorkspaceLead from '../server/transient-workspace-lead.mjs'

const { isTransientWorkspaceLead } = transientWorkspaceLead

const rawArgs = process.argv.slice(2)
const options = Object.fromEntries(
  rawArgs
    .filter((arg) => arg.startsWith('--') && arg.includes('='))
    .map((arg) => {
      const [key, ...rest] = arg.slice(2).split('=')
      return [key, rest.join('=')]
    }),
)

const failures = []
const baseUrl = normalizeBaseUrl(
  options.baseUrl ||
    process.env.SPEAK_QA_TRANSCRIPT_BASE_URL ||
    '',
)

await checkCallHistoryTranscriptDedupe()
checkTransientPlaygroundLeadContract()
checkRenderingContracts()
const reactRuntime = await checkReactRuntimeBehavior()
const apiScan = baseUrl ? await scanApiTranscripts(baseUrl) : null

const payload = {
  ok: failures.length === 0,
  schemaVersion: 'speak.transcript-rendering-check.v1',
  fixture: 'inworld-duplicate-provider-event',
  apiScan,
  reactRuntime,
  failures,
}

if (!payload.ok) {
  console.error(JSON.stringify(payload, null, 2))
  process.exit(1)
}

console.log(JSON.stringify(payload, null, 2))

async function checkCallHistoryTranscriptDedupe() {
  const dir = mkdtempSync(path.join(tmpdir(), 'speak-transcript-rendering-'))
  try {
    const callControlId = 'calltools-recording-dedupe-check'
    const events = [
      eventRecord(callControlId, '2026-07-03T10:00:00.000Z', finalEntry('Lead', 'Hello.', '10:00:00 AM', 'user-turn-1')),
      eventRecord(callControlId, '2026-07-03T10:00:00.001Z', finalEntry('Lead', 'Hello.', '10:00:00 AM', 'user-turn-1')),
      eventRecord(callControlId, '2026-07-03T10:00:00.002Z', finalEntry('Lead', 'Hello.', '10:00:00 AM', 'user-turn-1')),
      eventRecord(callControlId, '2026-07-03T10:00:02.000Z', finalEntry('AI', 'Hi, how can I help?', '10:00:02 AM', 'assistant-turn-1')),
      eventRecord(callControlId, '2026-07-03T10:00:05.000Z', finalEntry('Lead', 'Fallback duplicate.', '10:00:05 AM')),
      eventRecord(callControlId, '2026-07-03T10:00:05.001Z', finalEntry('Lead', 'Fallback duplicate.', '10:00:05 AM')),
      eventRecord(callControlId, '2026-07-03T10:00:10.000Z', finalEntry('Lead', 'Repeatable.', '10:00:10 AM')),
      eventRecord(callControlId, '2026-07-03T10:00:20.000Z', finalEntry('Lead', 'Repeatable.', '10:00:20 AM')),
    ]
    writeFileSync(
      path.join(dir, 'events-2026-07-03.jsonl'),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    )
    const [summary] = recentCallSummaries({
      callStates: [],
      callLogDir: dir,
      limit: 10,
      leadForState: () => null,
    }).filter((call) => call.callControlId === callControlId)
    if (!summary) {
      failures.push('call-history fixture did not produce a recent call summary')
      return
    }
    const duplicateGroups = duplicateTranscriptGroups(summary.transcript || [])
    if (duplicateGroups.length) {
      failures.push(`call-history transcript still contains duplicate rendered turns: ${JSON.stringify(duplicateGroups)}`)
    }
    assertCount(summary.transcript, 'Lead', 'Hello.', 1, 'providerEventId duplicate final user turn')
    assertCount(summary.transcript, 'Lead', 'Fallback duplicate.', 1, 'same timestamp/text fallback duplicate turn')
    assertCount(summary.transcript, 'Lead', 'Repeatable.', 2, 'same text at different timestamps must stay separate')
    assertCount(summary.transcript, 'AI', 'Hi, how can I help?', 1, 'assistant turn')
    if (summary.origin !== 'playground_phone') {
      failures.push(`call-history must retain Playground Phone origin, got ${summary.origin || 'empty'}`)
    }
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}

function checkTransientPlaygroundLeadContract() {
  if (!isTransientWorkspaceLead({ id: 'config-phone-test-ad-hoc' })) {
    failures.push('ad-hoc Playground Phone contacts must be transient')
  }
  if (isTransientWorkspaceLead({ id: 'saved-workspace-contact' })) {
    failures.push('saved Playground Phone contacts must retain normal workspace identity')
  }
  if (
    transientWorkspaceLead.conversationMemoryContactIdForLead?.({
      id: 'config-phone-test-ad-hoc',
    }) !== ''
  ) {
    failures.push('ad-hoc Playground contacts must not inherit shared conversation memory')
  }
  if (
    transientWorkspaceLead.conversationMemoryContactIdForLead?.({
      id: 'saved-workspace-contact',
    }) !== 'saved-workspace-contact'
  ) {
    failures.push('saved contacts must retain their conversation-memory identity')
  }
}

function checkRenderingContracts() {
  const callHistory = readFile('server/call-history.mjs')
  const serverIndex = readFile('server/index.mjs')
  const voiceTurnTransport = readFile('server/voice-turn-transport.mjs')
  const calls = readFile('src/calls.ts')
  const communicationThreadMessages = readFile('src/CommunicationThreadMessages.tsx')
  const communicationThreadMessageUtils = readFile('src/communicationThreadMessageUtils.ts')
  const fullAudit = readFile('scripts/check-full-e2e-audit.mjs')

  if (!/indexByProviderEventId/.test(callHistory) || !/normalizeTranscriptText/.test(callHistory)) {
    failures.push('call-history summaries must dedupe transcript turns by provider event id and text identity key')
  }
  if (
    !/shouldEmitFinalUserTranscript/.test(serverIndex) ||
    !/shouldEmitFinalUserTranscript/.test(voiceTurnTransport) ||
    !/finalUserTranscriptDedupe/.test(voiceTurnTransport)
  ) {
    failures.push('live final user transcript emission must dedupe repeated provider events before SSE/UI rendering')
  }
  if (
    !/config-tests\/:testId\/end[\s\S]{0,1000}persistedSummary = findCallSummary[\s\S]{0,1000}isBrowserConfigTestSummary\(persistedSummary\)[\s\S]{0,1200}recoveredPersisted: true/.test(
      serverIndex,
    )
  ) {
    failures.push('Playground end must reconcile persisted live Browser sessions after backend restart')
  }
  if (
    !/origin:\s*'playground_phone'/.test(readFile('src/useConfigurationTestSession.ts')) ||
    !/function isPlaygroundTestSummary[\s\S]{0,300}playground_phone/.test(serverIndex) ||
    !/id === 'config-phone-test-ad-hoc'/.test(
      readFile('server/transient-workspace-lead.mjs'),
    )
  ) {
    failures.push(
      'Playground Phone calls must persist their origin and keep ad-hoc test contacts transient',
    )
  }
  if (!/incoming\.providerEventId/.test(calls) || !/existingProviderIndex/.test(calls)) {
    failures.push('active transcript append must merge incoming entries by providerEventId')
  }
  if (!/mergeCommunicationMessages\(fallbackMessages, messages\)/.test(communicationThreadMessages)) {
    failures.push('source-history renderer must merge legacy transcript rows with durable thread messages before rendering')
  }
  if (!/providerSourceId = providerEventId \|\| sourceEventId \|\| providerMessageId/.test(communicationThreadMessageUtils)) {
    failures.push('communication message dedupe must prioritize provider/source message identity')
  }
  const providerSourceDedupeBlock = /if \(providerSourceId\) \{([\s\S]*?)\n  \}/.exec(communicationThreadMessageUtils)?.[1] || ''
  const providerKeyIndex = providerSourceDedupeBlock.indexOf('const providerKey = [')
  const callProviderKeyIndex = providerSourceDedupeBlock.indexOf('const callProviderKey = [')
  if (
    !providerSourceDedupeBlock ||
    providerKeyIndex === -1 ||
    providerSourceDedupeBlock.indexOf('message.threadId', providerKeyIndex) === -1 ||
    providerSourceDedupeBlock.indexOf('callControlId', providerKeyIndex) === -1 ||
    providerSourceDedupeBlock.indexOf('providerSourceId', providerKeyIndex) === -1 ||
    !providerSourceDedupeBlock.includes('keys.push(providerKey)')
  ) {
    failures.push('communication message provider dedupe key must include threadId and callControlId so repeated provider turn ids from separate calls do not collapse')
  }
  if (
    callProviderKeyIndex === -1 ||
    providerSourceDedupeBlock.indexOf('message.threadId', callProviderKeyIndex) === -1 ||
    providerSourceDedupeBlock.indexOf('callControlId', callProviderKeyIndex) === -1 ||
    providerSourceDedupeBlock.indexOf('providerSourceId', callProviderKeyIndex) === -1 ||
    !providerSourceDedupeBlock.includes('if (callControlId) keys.push(callProviderKey)')
  ) {
    failures.push('communication message call-provider dedupe key must include threadId, callControlId, and provider source identity')
  }
  if (!/qa:transcript-rendering/.test(fullAudit)) {
    failures.push('full E2E audit must include transcript rendering duplicate coverage')
  }
}

async function checkReactRuntimeBehavior() {
  let browser
  let vite
  const failureCountBefore = failures.length

  try {
    vite = await createViteServer({
      appType: 'custom',
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'speak-transcript-runtime-check',
          resolveId(id) {
            if (id === 'virtual:speak-transcript-runtime-check') {
              return '\0virtual:speak-transcript-runtime-check'
            }
            return null
          },
          load(id) {
            if (id !== '\0virtual:speak-transcript-runtime-check') return null
            return `
              import React from 'react'
              import * as ReactDOM from 'react-dom/client'
              import { useActiveCallTranscript } from '/src/useActiveCallTranscript.ts'
              import { useConfigurationTestSession } from '/src/useConfigurationTestSession.ts'
              import { useDialerReadModel } from '/src/useDialerReadModel.ts'

              export {
                React,
                ReactDOM,
                useActiveCallTranscript,
                useConfigurationTestSession,
                useDialerReadModel,
              }
            `
          },
          configureServer(server) {
            server.middlewares.use((request, response, next) => {
              if (String(request.url || '').split('?')[0] !== '/__speak_runtime_check__') {
                next()
                return
              }
              response.statusCode = 200
              response.setHeader('Content-Type', 'text/html; charset=utf-8')
              response.end('<!doctype html><html><body><div id="root"></div></body></html>')
            })
          },
        },
      ],
      root: process.cwd(),
      server: {
        host: '127.0.0.1',
        port: 0,
        strictPort: false,
      },
    })
    await vite.listen()
    const address = vite.httpServer?.address()
    if (!address || typeof address === 'string') {
      throw new Error('temporary Vite server did not expose a local port')
    }

    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${address.port}/__speak_runtime_check__`, {
      waitUntil: 'domcontentloaded',
    })

    const dialerReadModel = await checkDialerReadModelBehavior(page)
    const activeCallTranscript = await checkActiveCallTranscriptBehavior(page)
    const configurationTestSession = await checkConfigurationTestSessionBehavior(page)

    assertStringList(
      dialerReadModel.liveCallIds,
      ['call-old'],
      'Dialer selected-call history must exclude the active live call',
    )
    assertStringList(
      dialerReadModel.endedCallIds,
      ['call-old', 'call-live'],
      'Dialer selected-call history must restore the call after it is no longer live',
    )
    assertStringList(
      activeCallTranscript.sameCallTexts,
      ['Call A turn'],
      'Active transcript must survive rerenders for the same call id',
    )
    assertStringList(
      activeCallTranscript.afterSwitchTexts,
      [],
      'Active transcript must reset when a different call id attaches',
    )
    assertStringList(
      activeCallTranscript.nextCallTexts,
      ['Call B turn'],
      'New active-call turns must not retain turns from the prior call id',
    )
    assertSessionCleanupCalls(configurationTestSession.endCalls)
    if (
      configurationTestSession.endingWhilePhoneEndPending !== true ||
      configurationTestSession.endingAfterPhoneEnd !== false ||
      configurationTestSession.phoneStartOverlapBlocked !== true
    ) {
      failures.push(
        `Playground Phone must block a second start until delayed backend end settles: ${JSON.stringify(configurationTestSession)}`,
      )
    }
    if (configurationTestSession.lateStartOverlapBlocked !== true) {
      failures.push(
        `Playground must block a new start while a canceled late start is being cleaned up: ${JSON.stringify(configurationTestSession)}`,
      )
    }

    return {
      ok: failures.length === failureCountBefore,
      activeCallTranscript,
      configurationTestSession,
      dialerReadModel,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    failures.push(`React runtime behavior check failed: ${message}`)
    return {
      ok: false,
      error: message,
    }
  } finally {
    await browser?.close().catch(() => undefined)
    await vite?.close().catch(() => undefined)
  }
}

async function checkDialerReadModelBehavior(page) {
  return page.evaluate(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const {
      React,
      ReactDOM,
      useDialerReadModel,
    } = await import('/@id/__x00__virtual:speak-transcript-runtime-check')
    const host = document.createElement('div')
    document.body.append(host)

    const lead = {
      id: 'lead-1',
      name: 'Ada Lovelace',
      company: 'Analytical Engines',
      phone: '+15555550101',
      email: 'ada@example.com',
      state: 'CA',
      tags: [],
      score: 10,
      status: 'ready',
      lastCall: 'Never',
      notes: '',
      source: 'calltools',
      sourceId: 'campaign:1',
    }
    const activeCall = {
      leadId: lead.id,
      callControlId: 'call-live',
      phase: 'live',
      startedAt: Date.now(),
      takeover: false,
    }
    const recentCalls = [
      {
        callControlId: 'call-live',
        phase: 'live',
        createdAt: '2026-07-14T12:00:00.000Z',
        updatedAt: '2026-07-14T12:00:01.000Z',
        lead: {
          id: lead.id,
          name: lead.name,
          business_name: lead.company,
        },
        transcript: [{ speaker: 'Lead', text: 'Live duplicate.' }],
      },
      {
        callControlId: 'call-old',
        phase: 'ended',
        createdAt: '2026-07-14T11:00:00.000Z',
        updatedAt: '2026-07-14T11:01:00.000Z',
        lead: {
          id: lead.id,
          name: lead.name,
          business_name: lead.company,
        },
        transcript: [{ speaker: 'Lead', text: 'Historical turn.' }],
      },
      {
        callControlId: 'other-contact',
        phase: 'ended',
        createdAt: '2026-07-14T10:00:00.000Z',
        lead: {
          id: 'lead-2',
          name: 'Grace Hopper',
          business_name: 'Compiler Co',
        },
        transcript: [],
      },
    ]
    let current
    let options = {
      leads: [lead],
      activeAgentName: 'Speak QA Agent',
      activeCall,
      campaignQueueIds: [lead.id],
      activeSmartViewId: '',
      query: '',
      recentCalls,
      scoreFilter: 'all',
      selectedIds: new Set(),
      selectedLeadId: lead.id,
      sortDirection: 'desc',
      sortField: 'score',
      sourceKey: 'calltools::campaign%3A1',
      stateFilter: 'all',
      statusFilter: 'all',
      transcript: [],
    }

    function Harness() {
      current = useDialerReadModel(options)
      return null
    }

    const root = ReactDOM.createRoot(host)
    await React.act(async () => {
      root.render(React.createElement(Harness))
    })
    const liveCallIds = current.selectedLeadCalls.map((call) => call.callControlId)

    options = {
      ...options,
      activeCall: {
        ...activeCall,
        phase: 'ended',
      },
    }
    await React.act(async () => {
      root.render(React.createElement(Harness))
    })
    const endedCallIds = current.selectedLeadCalls.map((call) => call.callControlId)

    await React.act(async () => {
      root.unmount()
    })
    host.remove()
    return { endedCallIds, liveCallIds }
  })
}

async function checkActiveCallTranscriptBehavior(page) {
  return page.evaluate(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const {
      React,
      ReactDOM,
      useActiveCallTranscript,
    } = await import('/@id/__x00__virtual:speak-transcript-runtime-check')
    const host = document.createElement('div')
    document.body.append(host)

    let activeCallControlId = 'call-a'
    let currentTranscript = []
    let updateTranscript = () => undefined

    function Harness() {
      const [transcript, setTranscript] = React.useState([])
      useActiveCallTranscript(activeCallControlId, setTranscript)
      currentTranscript = transcript
      updateTranscript = setTranscript
      return null
    }

    const root = ReactDOM.createRoot(host)
    await React.act(async () => {
      root.render(React.createElement(Harness))
    })
    await React.act(async () => {
      updateTranscript([
        {
          at: '12:00:00 PM',
          speaker: 'Lead',
          text: 'Call A turn',
          tone: 'neutral',
        },
      ])
    })
    await React.act(async () => {
      root.render(React.createElement(Harness))
    })
    const sameCallTexts = currentTranscript.map((entry) => entry.text)

    activeCallControlId = 'call-b'
    await React.act(async () => {
      root.render(React.createElement(Harness))
    })
    const afterSwitchTexts = currentTranscript.map((entry) => entry.text)

    await React.act(async () => {
      updateTranscript([
        {
          at: '12:01:00 PM',
          speaker: 'AI',
          text: 'Call B turn',
          tone: 'neutral',
        },
      ])
    })
    const nextCallTexts = currentTranscript.map((entry) => entry.text)

    await React.act(async () => {
      root.unmount()
    })
    host.remove()
    return { afterSwitchTexts, nextCallTexts, sameCallTexts }
  })
}

async function checkConfigurationTestSessionBehavior(page) {
  return page.evaluate(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const {
      React,
      ReactDOM,
      useConfigurationTestSession,
    } = await import('/@id/__x00__virtual:speak-transcript-runtime-check')
    const originalFetch = globalThis.fetch
    const OriginalEventSource = globalThis.EventSource
    const requests = []
    const pendingStarts = []
    const pendingPhoneEnds = []

    globalThis.fetch = (input, init = {}) => {
      const url = String(input)
      requests.push({
        keepalive: init.keepalive === true,
        method: init.method || 'GET',
        url,
      })
      if (/\/config-tests\/start$/.test(url)) {
        return new Promise((resolve) => {
          pendingStarts.push(resolve)
        })
      }
      if (/\/calls\/start$/.test(url)) {
        return Promise.resolve(
          new Response(JSON.stringify({ callControlId: 'phone-session' }), {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          }),
        )
      }
      if (/\/calls\/phone-session\/end$/.test(url)) {
        return new Promise((resolve) => {
          pendingPhoneEnds.push(resolve)
        })
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      )
    }
    globalThis.EventSource = class {
      close() {}
    }

    const resolveStart = (testId) => {
      const resolve = pendingStarts.shift()
      if (!resolve) throw new Error(`No pending Playground start for ${testId}`)
      resolve(
        new Response(JSON.stringify({ testId }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      )
    }
    const resolvePhoneEnd = () => {
      const resolve = pendingPhoneEnds.shift()
      if (!resolve) throw new Error('No pending Playground phone end')
      resolve(
        new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      )
    }
    const host = document.createElement('div')
    document.body.append(host)
    let session

    function Harness() {
      session = useConfigurationTestSession({
        buildStartPayload: () => ({
          config: { sampleRate: 16_000 },
          testVariableKeys: [],
          testVariables: {},
        }),
      })
      return null
    }

    try {
      const root = ReactDOM.createRoot(host)
      await React.act(async () => {
        root.render(React.createElement(Harness))
      })

      let resetStart
      await React.act(async () => {
        resetStart = session.start({ microphone: false })
        await Promise.resolve()
      })
      resolveStart('reset-session')
      await React.act(async () => {
        await resetStart
      })
      await React.act(async () => {
        session.reset()
        await Promise.resolve()
      })

      await React.act(async () => {
        await session.startPhone({
          config: { sampleRate: 16_000 },
          lead: { id: 'phone-test-lead', name: 'Phone test', phone: '+15555550123' },
        })
      })
      let phoneEnd
      await React.act(async () => {
        phoneEnd = session.end()
        await Promise.resolve()
      })
      const endingWhilePhoneEndPending = session.ending
      let overlappingPhoneStart
      await React.act(async () => {
        overlappingPhoneStart = await session.startPhone({
          config: { sampleRate: 16_000 },
          lead: { id: 'overlap-test-lead', name: 'Overlap test', phone: '+15555550124' },
        })
      })
      const phoneStartCountWhileEnding = requests.filter(
        (request) => /\/calls\/start$/.test(request.url),
      ).length
      resolvePhoneEnd()
      await React.act(async () => {
        await phoneEnd
      })
      const endingAfterPhoneEnd = session.ending

      let unmountStart
      await React.act(async () => {
        unmountStart = session.start({ microphone: false })
        await Promise.resolve()
      })
      resolveStart('unmount-session')
      await React.act(async () => {
        await unmountStart
      })
      await React.act(async () => {
        root.unmount()
      })
      host.remove()

      const lateHost = document.createElement('div')
      document.body.append(lateHost)
      const lateRoot = ReactDOM.createRoot(lateHost)
      await React.act(async () => {
        lateRoot.render(React.createElement(Harness))
      })
      let lateStart
      await React.act(async () => {
        lateStart = session.start({ microphone: false })
        await Promise.resolve()
      })
      await React.act(async () => {
        session.reset()
        await Promise.resolve()
      })
      let overlappingLateStart
      await React.act(async () => {
        overlappingLateStart = await session.start({ microphone: false })
      })
      const pendingBrowserStartsAfterReset = pendingStarts.length
      resolveStart('late-session')
      await React.act(async () => {
        await lateStart
      })
      await React.act(async () => {
        lateRoot.unmount()
      })
      lateHost.remove()

      return {
        endingAfterPhoneEnd,
        endingWhilePhoneEndPending,
        endCalls: requests
          .filter((request) => /\/config-tests\/[^/]+\/end$/.test(request.url))
          .map((request) => ({
            id: decodeURIComponent(request.url.split('/').at(-2) || ''),
            keepalive: request.keepalive,
            method: request.method,
          })),
        lateStartOverlapBlocked:
          overlappingLateStart === null && pendingBrowserStartsAfterReset === 1,
        phoneStartOverlapBlocked:
          overlappingPhoneStart === null && phoneStartCountWhileEnding === 1,
      }
    } finally {
      globalThis.fetch = originalFetch
      globalThis.EventSource = OriginalEventSource
      host.remove()
    }
  })
}

function assertStringList(actual, expected, label) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assertSessionCleanupCalls(endCalls) {
  const expected = [
    { id: 'reset-session', keepalive: false, method: 'POST' },
    { id: 'unmount-session', keepalive: true, method: 'POST' },
    { id: 'late-session', keepalive: true, method: 'POST' },
  ]
  if (
    !Array.isArray(endCalls) ||
    endCalls.length !== expected.length ||
    endCalls.some((call, index) =>
      call.id !== expected[index].id ||
      call.keepalive !== expected[index].keepalive ||
      call.method !== expected[index].method,
    )
  ) {
    failures.push(
      `Playground Browser session cleanup expected ${JSON.stringify(expected)}, got ${JSON.stringify(endCalls)}`,
    )
  }
}

async function scanApiTranscripts(base) {
  const url = `${base}/api/calls/recent?limit=${encodeURIComponent(String(options.limit || 100))}`
  const response = await fetch(url)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    failures.push(`transcript API scan failed at ${url}: ${response.status}`)
    return { url, ok: false, status: response.status, scannedCalls: 0, duplicateGroups: [] }
  }
  const calls = Array.isArray(payload.calls) ? payload.calls : []
  const duplicateGroups = calls.flatMap((call) =>
    duplicateTranscriptGroups(call.transcript || []).map((group) => ({
      callControlId: call.callControlId,
      ...group,
    })),
  )
  if (duplicateGroups.length) {
    failures.push(`transcript API scan found duplicate rendered turns: ${JSON.stringify(duplicateGroups.slice(0, 8))}`)
  }
  return {
    url,
    ok: duplicateGroups.length === 0,
    scannedCalls: calls.length,
    duplicateGroups,
  }
}

function eventRecord(callControlId, at, entry) {
  return {
    at,
    callControlId,
    origin: 'playground_phone',
    lead: {
      id: 'lead-transcript-dedupe-check',
      name: 'Transcript QA',
      business_name: 'Speak QA',
    },
    agent: {
      id: 'agent-config-calltools-default',
      name: 'calltools.default',
      voiceRuntimeProvider: 'inworld',
    },
    event: { entry },
  }
}

function finalEntry(speaker, text, at, providerEventId = '') {
  const entry = transcriptEntry(speaker, text, 'neutral', {
    providerEventId,
  })
  entry.at = at
  return entry
}

function duplicateTranscriptGroups(transcript = []) {
  const groups = new Map()
  transcript.forEach((turn, index) => {
    const key = transcriptTurnKey(turn)
    if (!key) return
    const group = groups.get(key) || {
      key,
      indexes: [],
      speaker: turn.speaker || '',
      at: turn.at || '',
      text: turn.text || '',
      providerEventId: turn.providerEventId || '',
    }
    group.indexes.push(index)
    groups.set(key, group)
  })
  return Array.from(groups.values()).filter((group) => group.indexes.length > 1)
}

function transcriptTurnKey(turn = {}) {
  const text = normalizeText(turn.text)
  if (!text) return ''
  const providerEventId = String(turn.providerEventId || '').trim()
  if (providerEventId) return `provider:${turn.speaker || ''}:${providerEventId}`
  return [
    'fallback',
    turn.speaker || '',
    turn.at || '',
    text,
  ].join('|')
}

function assertCount(transcript = [], speaker, text, expected, label) {
  const count = transcript.filter(
    (turn) => turn.speaker === speaker && normalizeText(turn.text) === normalizeText(text),
  ).length
  if (count !== expected) {
    failures.push(`${label}: expected ${expected} rendered turn(s), got ${count}`)
  }
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function readFile(file) {
  return readFileSync(file, 'utf8')
}

function normalizeBaseUrl(value = '') {
  return String(value || '').trim().replace(/\/$/, '')
}
