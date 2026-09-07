#!/usr/bin/env node
import 'dotenv/config'
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { HUME_API_BASE, readJson } from '../server/provider-http.mjs'
import { normalizeEmotionScores } from '../server/hume-emotion-scores.mjs'
import { getHumeApiKey } from '../server/secrets.mjs'

const args = new Set(process.argv.slice(2))
const apply = args.has('--apply') || args.has('--write')
const callLogDir = optionValue('--dir') || path.resolve(process.cwd(), 'call-logs')
const fileLimit = Number(optionValue('--files') || 5)
const callLimit = Number(optionValue('--calls') || 200)
const runId = new Date().toISOString().replace(/[:.]/g, '-')

if (args.has('--help') || args.has('-h')) {
  console.log(`Usage: node scripts/backfill-transcript-emotions.mjs [options]

Hume-only maintenance utility for backfilling persisted call-log transcript
entries from retained Hume Chat History emotion_features.

Options:
  --dir=<path>     Call-log directory. Defaults to ./call-logs.
  --files=<n>      Number of newest events-YYYY-MM-DD.jsonl files to scan.
  --calls=<n>      Maximum Hume call groups to check.
  --apply          Write updated JSONL files after creating .bak-emotions-* backups.
  --write          Deprecated alias for --apply.
  --help           Show this help.
`)
  process.exit(0)
}

if (!existsSync(callLogDir)) {
  console.error(`Call log directory not found: ${callLogDir}`)
  process.exit(1)
}

const files = readdirSync(callLogDir)
  .filter((file) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
  .sort()
  .reverse()
  .slice(0, Number.isFinite(fileLimit) && fileLimit > 0 ? fileLimit : 5)
  .map((file) => path.join(callLogDir, file))

const filesByCall = new Map()
const recordsByFile = new Map()

files.forEach((file) => {
  const records = readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  recordsByFile.set(file, records)
  records.forEach((record) => {
    if (!record.callControlId) return
    const group =
      filesByCall.get(record.callControlId) || {
        callControlId: record.callControlId,
        chatId: '',
        records: [],
      }
    group.chatId =
      record.event?.patch?.chatId ||
      record.event?.chatId ||
      record.chatId ||
      group.chatId
    group.records.push({ file, record })
    filesByCall.set(record.callControlId, group)
  })
})

const allGroups = Array.from(filesByCall.values()).map((group) => ({
  ...group,
  runtimeProvider: groupRuntimeProvider(group),
  missingEmotionScoreTurns: countMissingEmotionScoreTurns(group.records),
}))
const allGroupsWithChatId = allGroups.filter((group) => group.chatId)
const skippedInworld = allGroupsWithChatId.filter((group) => group.runtimeProvider === 'inworld').length
const skippedNonHume = allGroupsWithChatId.filter(
  (group) => group.runtimeProvider && group.runtimeProvider !== 'hume' && group.runtimeProvider !== 'inworld',
).length
const candidates = allGroupsWithChatId
  .filter(isHumeBackfillCandidate)
  .filter((group) => group.missingEmotionScoreTurns > 0)
  .slice(0, Number.isFinite(callLimit) && callLimit > 0 ? callLimit : 200)

if (candidates.length > 0 && !getHumeApiKey()) {
  console.error('HUME_API_KEY is required for Hume transcript emotion backfill.')
  process.exit(1)
}

let callsChecked = 0
let callsUpdated = 0
let entriesUpdated = 0
const changedFiles = new Set()

for (const group of candidates) {
  callsChecked += 1
  const humeTurns = await fetchHumeTranscriptTurns(group.chatId)
  if (humeTurns.length === 0) continue

  const updated = patchGroupRecords(group, humeTurns)
  if (updated > 0) {
    callsUpdated += 1
    entriesUpdated += updated
    group.records.forEach(({ file }) => changedFiles.add(file))
  }
}

if (apply) {
  changedFiles.forEach((file) => {
    copyFileSync(file, `${file}.bak-emotions-${runId}`)
    const content = recordsByFile
      .get(file)
      .map((record) => JSON.stringify(record))
      .join('\n')
    writeFileSync(file, `${content}\n`)
  })
}

console.log(
  JSON.stringify(
    {
      mode: apply ? 'apply' : 'dry-run',
      files: files.length,
      changedFiles: changedFiles.size,
      humeCandidates: candidates.length,
      skippedInworld,
      skippedNonHume,
      callsChecked,
      callsUpdated,
      entriesUpdated,
    },
    null,
    2,
  ),
)

function optionValue(name) {
  const prefix = `${name}=`
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix))
  return match ? match.slice(prefix.length) : ''
}

function normalizeRuntimeProvider(value) {
  const provider = String(value || '').trim().toLowerCase()
  if (provider === 'hume' || provider === 'inworld') return provider
  return provider
}

function groupRuntimeProvider(group) {
  let hasHumeConfig = false
  let hasInworldConfig = false
  let hasHumeDiagnostic = false
  let hasInworldDiagnostic = false

  for (const { record } of group.records) {
    const provider = normalizeRuntimeProvider(
      record.agent?.voiceRuntimeProvider ||
        record.event?.voiceRuntimeProvider ||
        record.event?.communication?.runtimeProvider,
    )
    if (provider) return provider
    if (record.agent?.humeConfigId) hasHumeConfig = true
    if (record.agent?.inworldConfigId) hasInworldConfig = true
    if (record.event?.diagnostic?.hume) hasHumeDiagnostic = true
    if (record.event?.diagnostic?.inworld) hasInworldDiagnostic = true
  }

  if ((hasInworldConfig || hasInworldDiagnostic) && !hasHumeDiagnostic) return 'inworld'
  if (hasHumeConfig || hasHumeDiagnostic) return 'hume'
  return ''
}

function countMissingEmotionScoreTurns(records) {
  return records.filter(({ record }) => {
    const entry = record.event?.entry
    if (!entry || entry.tone === 'system') return false
    const speaker = entry.speaker === 'You' ? 'Lead' : entry.speaker
    if (!['Lead', 'AI'].includes(speaker)) return false
    return !normalizeEmotionScores(entry.emotionScores)
  }).length
}

function isHumeBackfillCandidate(group) {
  return group.runtimeProvider === 'hume'
}

async function fetchHumeTranscriptTurns(chatId) {
  const events = []
  let pageNumber = 0
  let totalPages = 1

  while (pageNumber < totalPages) {
    const url = new URL(`${HUME_API_BASE}/evi/chats/${encodeURIComponent(chatId)}`)
    url.searchParams.set('page_number', String(pageNumber))
    url.searchParams.set('page_size', '100')
    url.searchParams.set('ascending_order', 'true')
    const response = await fetch(url, {
      headers: { 'X-Hume-Api-Key': getHumeApiKey() },
    })
    const payload = await readJson(response)
    if (!response.ok) return []

    const pageEvents = Array.isArray(payload.events_page)
      ? payload.events_page
      : []
    events.push(...pageEvents)
    totalPages = Number(payload.total_pages || 1)
    pageNumber += 1
  }

  const assistantScores = new Map()
  events.forEach((event) => {
    if (event.type !== 'ASSISTANT_PROSODY' || !event.related_event_id) return
    const scores = normalizeEmotionScores(event.emotion_features)
    if (scores) assistantScores.set(event.related_event_id, scores)
  })

  return events.flatMap((event) => {
    if (event.type === 'USER_MESSAGE') {
      return [
        {
          providerEventId: event.id,
          speaker: 'Lead',
          text: event.message_text || '',
          emotionScores: normalizeEmotionScores(event.emotion_features),
        },
      ]
    }

    if (event.type === 'AGENT_MESSAGE') {
      return [
        {
          providerEventId: event.id,
          speaker: 'AI',
          text: event.message_text || '',
          emotionScores: assistantScores.get(event.id) || null,
        },
      ]
    }

    return []
  })
}

function patchGroupRecords(group, humeTurns) {
  let updated = 0
  let cursor = 0

  group.records.forEach(({ record }) => {
    const entry = record.event?.entry
    if (!entry || entry.tone === 'system') return
    const speaker = entry.speaker === 'You' ? 'Lead' : entry.speaker
    if (!['Lead', 'AI'].includes(speaker)) return
    if (normalizeEmotionScores(entry.emotionScores)) return

    const matchIndex = findMatchingTurn(humeTurns, cursor, speaker, entry.text)
    if (matchIndex < 0) return

    const match = humeTurns[matchIndex]
    cursor = matchIndex + 1
    if (!match.emotionScores) return

    entry.emotionScores = match.emotionScores
    entry.providerEventId = entry.providerEventId || match.providerEventId
    updated += 1
  })

  return updated
}

function findMatchingTurn(turns, startIndex, speaker, text) {
  const normalizedText = normalizeText(text)
  for (let index = startIndex; index < turns.length; index += 1) {
    const turn = turns[index]
    if (turn.speaker !== speaker) continue
    if (normalizeText(turn.text) === normalizedText) return index
  }
  return -1
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s*\.\.\.$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}
