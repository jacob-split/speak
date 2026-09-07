import 'dotenv/config'
import path from 'node:path'
import { recentCallSummaries } from '../server/call-history.mjs'
import {
  listCommunicationThreads,
  recordCommunicationCallSummary,
} from '../server/workspace-store.mjs'

const apply = process.argv.includes('--apply')
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='))
const limit = boundedNumber(
  limitArg?.split('=')[1] || process.env.SPEAK_COMMUNICATION_BACKFILL_LIMIT,
  5000,
  50000,
)
const callLogDir = path.resolve(process.env.SPEAK_CALL_LOG_DIR || 'call-logs')

const summaries = recentCallSummaries({
  callStates: [],
  callLogDir,
  limit,
  leadForState: () => ({}),
})
const eligible = summaries.filter(
  (summary) =>
    summary.callControlId &&
    Array.isArray(summary.transcript) &&
    summary.transcript.some((turn) => String(turn?.text || '').trim()),
)

let written = 0
if (apply) {
  for (const summary of eligible) {
    const result = await recordCommunicationCallSummary(summary)
    if (result?.message?.messageId) written += 1
  }
}

const threads = await listCommunicationThreads({ limit: 1 })
console.log(
  JSON.stringify(
    {
      ok: true,
      mode: apply ? 'apply' : 'dry-run',
      callLogDir,
      scanned: summaries.length,
      eligible: eligible.length,
      written,
      workspaceThreadTotal: threads.total,
    },
    null,
    2,
  ),
)

function boundedNumber(value, fallback, max) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(max, Math.floor(number))
}
