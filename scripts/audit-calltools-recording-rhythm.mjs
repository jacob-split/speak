import 'dotenv/config'
import { callToolsRequest } from '../server/calltools-client.mjs'

const rawArgs = process.argv.slice(2)
const flags = new Set(rawArgs.filter((arg) => arg.startsWith('--') && !arg.includes('=')))
const options = Object.fromEntries(
  rawArgs
    .filter((arg) => arg.startsWith('--') && arg.includes('='))
    .map((arg) => {
      const [key, ...rest] = arg.slice(2).split('=')
      return [key, rest.join('=')]
    }),
)

const json = flags.has('--json')
const limit = positiveNumber(
  options.limit ||
    process.env.CALLTOOLS_RECORDING_RHYTHM_LIMIT,
  50,
)
const appUserId = safeText(
  options.appUserId ||
    process.env.CALLTOOLS_RECORDING_RHYTHM_APP_USER_ID ||
    process.env.CALLTOOLS_APP_USER_ID,
)
const destination = normalizePhone(
  options.destination ||
    options.to ||
    process.env.CALLTOOLS_RECORDING_RHYTHM_DESTINATION,
)
const startDate = safeText(
  options.date ||
    options.startDate ||
    process.env.CALLTOOLS_RECORDING_RHYTHM_DATE,
)
const dateRange = safeText(
  options.dateRange ||
    options.startDateRange ||
    process.env.CALLTOOLS_RECORDING_RHYTHM_DATE_RANGE,
)
const includeInternal = flags.has('--include-internal')

const calls = await readCalls()
const rows = calls.map((call) => summarizeCall(call))
const summarizedRows = includeInternal ? rows : rows.filter((row) => row.callType !== 'internal')
const report = buildReport(summarizedRows, calls)

if (json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  printReport(report)
}

if (report.failures.length) process.exitCode = 1

async function readCalls() {
  const query = cleanObject({
    app_user_id: appUserId,
    destination,
    start__date: startDate && !dateRange ? startDate : '',
    start__date__range: dateRange,
    ordering: '-start',
    page_size: Math.min(limit, 250),
  })
  const payload = await callToolsRequest('/calls/', { query })
  return collectionResults(payload).slice(0, limit)
}

function buildReport(rows = [], rawCalls = []) {
  const now = Date.now()
  const failures = []
  const recordedRows = rows.filter((row) => row.recordingReferenceAvailable)
  const missingRecordingRows = rows.filter((row) => !row.recordingReferenceAvailable)
  const oldMissingRecordingRows = missingRecordingRows.filter((row) => row.ageMinutes >= 60)
  const durationBuckets = bucketRows(rows, durationBucket)
  const ageBuckets = bucketRows(rows, ageBucket)
  const callRecordDelays = rows
    .map((row) => row.historicalCallRecordDelaySeconds)
    .filter((value) => Number.isFinite(value))
  const longestMissingRecording = [...missingRecordingRows].sort((a, b) => b.durationSeconds - a.durationSeconds)[0] || null
  const oldestMissingRecording = [...missingRecordingRows].sort((a, b) => b.ageMinutes - a.ageMinutes)[0] || null
  const newestRecording = [...recordedRows].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0] || null

  return {
    ok: true,
    checkedAt: new Date(now).toISOString(),
    source: {
      endpoint: '/calls/',
      filters: {
        appUserId: redactId(appUserId),
        destination: maskPhone(destination),
        startDate,
        dateRange,
        limit,
        includeInternal,
      },
    },
    totals: {
      calls: rows.length,
      rawCalls: rawCalls.length,
      recordedCalls: recordedRows.length,
      missingRecordingReference: missingRecordingRows.length,
      missingRecordingReferenceOlderThanOneHour: oldMissingRecordingRows.length,
    },
    observedBehavior: {
      medianHistoricalCallRecordDelaySeconds: median(callRecordDelays),
      maxHistoricalCallRecordDelaySeconds: max(callRecordDelays),
      recordingReferenceIsProviderAudioReadinessProof: recordedRows.length > 0,
      recordingMetadataMayLagAfterCallEnd: missingRecordingRows.length > 0,
    },
    durationBuckets,
    ageBuckets,
    examples: {
      newestRecordingReference: publicRow(newestRecording),
      longestMissingRecordingReference: publicRow(longestMissingRecording),
      oldestMissingRecordingReference: publicRow(oldestMissingRecording),
    },
    calls: rows.map(publicRow),
    failures,
  }
}

function summarizeCall(call = {}) {
  const startedAt = safeText(call.start)
  const endedAt = safeText(call.end)
  const createdOn = safeText(call.created_on)
  const endMs = Date.parse(endedAt)
  const createdMs = Date.parse(createdOn)
  const ageMinutes = Number.isFinite(endMs)
    ? Math.round((Date.now() - endMs) / 60000)
    : null
  const historicalDelay = Number.isFinite(endMs) && Number.isFinite(createdMs)
    ? Math.round((createdMs - endMs) / 1000)
    : null
  return {
    id: String(call.id || ''),
    uuid: safeText(call.uuid),
    startedAt,
    endedAt,
    historicalCallCreatedOn: createdOn,
    historicalCallRecordDelaySeconds: historicalDelay,
    ageMinutes,
    callType: safeText(call.call_type),
    systemDisposition: safeText(call.system_disposition),
    durationSeconds: numberOrZero(call.duration),
    billsec: numberOrZero(call.billsec),
    destination: normalizePhone(call.destination),
    source: normalizePhone(call.source),
    contactId: call.contact ? String(call.contact) : '',
    campaignId: call.campaign ? String(call.campaign) : '',
    queueId: call.queue ? String(call.queue) : '',
    recordingReferenceAvailable: Boolean(call.call_recording_fsfile_id),
    recordingFileId: call.call_recording_fsfile_id ? String(call.call_recording_fsfile_id) : '',
  }
}

function publicRow(row) {
  if (!row) return null
  return {
    id: row.id,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    ageMinutes: row.ageMinutes,
    callType: row.callType,
    systemDisposition: row.systemDisposition,
    durationSeconds: row.durationSeconds,
    billsec: row.billsec,
    destination: maskPhone(row.destination),
    source: maskPhone(row.source),
    campaignId: row.campaignId,
    recordingReferenceAvailable: row.recordingReferenceAvailable,
    recordingFileId: row.recordingFileId ? '<present>' : '',
    historicalCallRecordDelaySeconds: row.historicalCallRecordDelaySeconds,
  }
}

function bucketRows(rows = [], bucketer) {
  const buckets = new Map()
  for (const row of rows) {
    const name = bucketer(row)
    const bucket = buckets.get(name) || {
      bucket: name,
      calls: 0,
      recordedCalls: 0,
      missingRecordingReference: 0,
    }
    bucket.calls += 1
    if (row.recordingReferenceAvailable) bucket.recordedCalls += 1
    if (!row.recordingReferenceAvailable) bucket.missingRecordingReference += 1
    buckets.set(name, bucket)
  }
  return [...buckets.values()]
}

function durationBucket(row) {
  const seconds = row.durationSeconds
  if (seconds < 30) return '<30s'
  if (seconds < 60) return '30-59s'
  if (seconds < 120) return '60-119s'
  return '>=120s'
}

function ageBucket(row) {
  const minutes = row.ageMinutes
  if (!Number.isFinite(minutes)) return 'unknown'
  if (minutes < 60) return '<1h'
  if (minutes < 240) return '1-4h'
  return '>=4h'
}

function printReport(report) {
  console.log('CallTools recording metadata rhythm audit')
  console.log(`Checked: ${report.checkedAt}`)
  console.log(`Calls analyzed: ${report.totals.calls}`)
  console.log(`Recorded calls: ${report.totals.recordedCalls}`)
  console.log(`Calls missing recording reference: ${report.totals.missingRecordingReference}`)
  console.log(`Calls missing recording reference older than 1h: ${report.totals.missingRecordingReferenceOlderThanOneHour}`)
  console.log('')
  console.log('Observed behavior:')
  console.log(`- median historical call-row delay after end: ${report.observedBehavior.medianHistoricalCallRecordDelaySeconds}s`)
  console.log(`- recording reference is provider-audio readiness proof: ${report.observedBehavior.recordingReferenceIsProviderAudioReadinessProof}`)
  console.log(`- recording metadata may lag after call end: ${report.observedBehavior.recordingMetadataMayLagAfterCallEnd}`)
  console.log('')
  console.log('Duration buckets:')
  for (const bucket of report.durationBuckets) {
    console.log(`- ${bucket.bucket}: ${bucket.recordedCalls}/${bucket.calls} recording references, ${bucket.missingRecordingReference} missing`)
  }
  console.log('')
  console.log('Age buckets:')
  for (const bucket of report.ageBuckets) {
    console.log(`- ${bucket.bucket}: ${bucket.recordedCalls}/${bucket.calls} recording references, ${bucket.missingRecordingReference} missing`)
  }
  if (report.examples.longestMissingRecordingReference) {
    console.log('')
    console.log('Longest call missing recording reference:')
    console.log(JSON.stringify(report.examples.longestMissingRecordingReference, null, 2))
  }
}

function collectionResults(payload) {
  if (Array.isArray(payload?.results)) return payload.results
  if (Array.isArray(payload?.data?.results)) return payload.data.results
  if (Array.isArray(payload)) return payload
  return []
}

function cleanObject(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''),
  )
}

function safeText(value) {
  return String(value ?? '').trim()
}

function numberOrZero(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function normalizePhone(value = '') {
  return safeText(value).replace(/[^\d+]/g, '')
}

function maskPhone(value = '') {
  const text = normalizePhone(value)
  if (!text) return ''
  const digits = text.replace(/\D/g, '')
  if (digits.length <= 4) return text
  return `${text.startsWith('+') ? '+' : ''}***${digits.slice(-4)}`
}

function redactId(value = '') {
  const text = safeText(value)
  if (!text) return ''
  return `${text.slice(0, 8)}...`
}

function median(values = []) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2) return sorted[middle]
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

function max(values = []) {
  return values.length ? Math.max(...values) : null
}
