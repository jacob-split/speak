import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const scriptPath = 'scripts/backfill-transcript-emotions.mjs'
const source = readFileSync(scriptPath, 'utf8')
const scripts = packageJson.scripts || {}
const failures = []

try {
  assert.equal(
    scripts['qa:transcript-emotions'],
    'node scripts/check-transcript-emotions.mjs',
    'package script qa:transcript-emotions must run this verifier',
  )
  assert.equal(
    scripts['backfill:transcript-emotions'],
    'node scripts/backfill-transcript-emotions.mjs',
    'package script backfill:transcript-emotions must be dry-run by default',
  )
  assert.equal(
    scripts['backfill:transcript-emotions:apply'],
    'node scripts/backfill-transcript-emotions.mjs --apply',
    'package script backfill:transcript-emotions:apply must require --apply',
  )

  ;[
    'Hume-only maintenance utility',
    'HUME_API_KEY is required for Hume transcript emotion backfill.',
    'getHumeApiKey',
    'isHumeBackfillCandidate',
    "group.runtimeProvider === 'hume'",
    "group.runtimeProvider === 'inworld'",
    'skippedInworld',
    'ASSISTANT_PROSODY',
    'USER_MESSAGE',
    'AGENT_MESSAGE',
    'event.emotion_features',
    'normalizeEmotionScores(entry.emotionScores)',
  ].forEach((needle) => {
    assert(
      source.includes(needle),
      `backfill transcript emotion source missing ${needle}`,
    )
  })

  runFixtureChecks()
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
}

const payload = {
  ok: failures.length === 0,
  schemaVersion: 'speak.transcript-emotions-check.v1',
  script: scriptPath,
  failures,
}

console.log(JSON.stringify(payload, null, 2))
if (!payload.ok) process.exit(1)

function runFixtureChecks() {
  const dir = mkdtempSync(path.join(tmpdir(), 'speak-transcript-emotions-'))
  try {
    writeJsonl(path.join(dir, 'events-2026-07-05.jsonl'), [
      {
        at: '2026-07-05T00:00:00.000Z',
        callControlId: 'inworld-call',
        agent: {
          voiceRuntimeProvider: 'inworld',
          humeConfigId: 'legacy-hume-id',
          inworldConfigId: 'inworld-realtime',
        },
        event: {
          patch: { chatId: 'inworld-chat-id' },
          entry: {
            id: 'inworld-turn',
            speaker: 'Lead',
            text: 'Inworld turn should not be sent to Hume.',
          },
        },
      },
    ])

    const inworldOnly = runBackfill([`--dir=${dir}`, '--files=1', '--calls=10'])
    assert.equal(inworldOnly.status, 0, inworldOnly.stderr || inworldOnly.stdout)
    const inworldPayload = JSON.parse(inworldOnly.stdout)
    assert.equal(inworldPayload.humeCandidates, 0)
    assert.equal(inworldPayload.skippedInworld, 1)
    assert.equal(inworldPayload.callsChecked, 0)

    writeJsonl(path.join(dir, 'events-2026-07-05.jsonl'), [
      {
        at: '2026-07-05T00:01:00.000Z',
        callControlId: 'hume-call',
        agent: {
          voiceRuntimeProvider: 'hume',
          humeConfigId: 'hume-config-id',
        },
        event: {
          patch: { chatId: 'hume-chat-id' },
          entry: {
            id: 'hume-turn',
            speaker: 'Lead',
            text: 'Hume turn needs emotion backfill.',
          },
        },
      },
    ])

    const humeWithoutKey = runBackfill([`--dir=${dir}`, '--files=1', '--calls=10'])
    assert.notEqual(humeWithoutKey.status, 0)
    assert.match(
      humeWithoutKey.stderr,
      /HUME_API_KEY is required for Hume transcript emotion backfill\./,
    )

    const help = runBackfill(['--help'])
    assert.equal(help.status, 0)
    assert.match(help.stdout, /Hume-only maintenance utility/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function runBackfill(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HUME_API_KEY: '',
      PATH: '',
      USER: '__speak-no-keychain-user__',
    },
  })
}

function writeJsonl(file, rows) {
  writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
}
