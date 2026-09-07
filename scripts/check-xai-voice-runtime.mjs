import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { WebSocket } from 'ws'
import { getXaiApiKey } from '../server/secrets.mjs'
import {
  ensureXaiRuntimeConfigReady,
  readXaiConfigOptions,
} from '../server/xai-configs.mjs'
import { normalizeCampaignConfig } from '../server/runtime-config.mjs'

const includeLive = process.argv.includes('--live')
const speakBaseUrl = String(
  process.argv.find((argument) => argument.startsWith('--speak-base-url='))
    ?.slice('--speak-base-url='.length) || '',
).replace(/\/+$/, '')
const serverSource = fs.readFileSync('server/index.mjs', 'utf8')
const settingsSource = fs.readFileSync('src/SpeakSettingsPanel.tsx', 'utf8')
const profileSource = fs.readFileSync('src/agentConfigs.ts', 'utf8')
const optionsSource = fs.readFileSync('server/xai-configs.mjs', 'utf8')
const transportSource = fs.readFileSync('server/transport-diagnostics.mjs', 'utf8')

for (const term of [
  'function connectXai',
  'export function buildXaiSession',
  'conversation.item.input_audio_transcription.updated',
  'response.function_call_arguments.done',
  'function flushXaiToolCalls',
  'function sendAudioToXai',
  "provider: 'xai'",
]) {
  assert.ok(serverSource.includes(term), `xAI runtime is missing ${term}`)
}
for (const term of [
  "selectVoiceRuntimeProvider('xai')",
  'xaiReasoningEffort',
  'xaiLanguageHint',
  'xaiKeyterms',
  'xaiVoiceSpeed',
  'xaiResumptionEnabled',
  'xaiToolCallingEnabled',
]) {
  assert.ok(settingsSource.includes(term), `xAI settings are missing ${term}`)
}
assert.ok(!/voiceRuntimeProvider === 'xai'[\s\S]{0,500}Codex auth/i.test(settingsSource))
assert.ok(settingsSource.includes("voiceRuntimeProvider !== 'xai' && ("), 'xAI must hide temperature')
assert.ok(settingsSource.includes("voiceRuntimeProvider === 'xai' && ("), 'xAI native settings block is missing')
assert.ok(settingsSource.includes('config.xaiVoiceId || config.xaiVoiceName || config.voice'))
for (const field of ['humeVoiceId', 'inworldVoiceId', 'xaiVoiceId']) {
  assert.ok(profileSource.includes(field), `per-runtime voice restoration is missing ${field}`)
}
assert.ok(optionsSource.includes("codexAuthModels: []"))
for (const timing of [
  'telnyxStreamToXaiOpen',
  'firstAssistantMessageToFirstXaiAudio',
  'firstXaiAudioToFirstTelnyxAudio',
  'calltoolsInviteToXaiOpen',
  'calltoolsAttachToXaiSession',
  'firstXaiAudioToFirstCallToolsAudio',
]) {
  assert.ok(transportSource.includes(timing), `xAI diagnostics are missing ${timing}`)
}

const options = await readXaiConfigOptions()
assert.deepEqual(
  options.languageModels.map((option) => option.modelResource),
  ['grok-voice-latest', 'grok-voice-think-fast-1.0'],
)
assert.ok(options.voices.length >= 6, 'xAI live voice catalog is unexpectedly small')
assert.ok(options.voices.every((voice) => voice.runtimeProvider === 'xai'))
assert.ok(options.voices.some((voice) => voice.id === 'eve'))

const validated = await ensureXaiRuntimeConfigReady(
  normalizeCampaignConfig({
    voiceRuntimeProvider: 'xai',
    languageModelMode: 'codex',
    xaiRealtimeModel: 'grok-voice-latest',
    voice: 'eve',
    xaiReasoningEffort: 'none',
  }),
  { allowStale: true },
)
assert.equal(validated.voiceRuntimeProvider, 'xai')
assert.equal(validated.languageModelMode, 'xai')
assert.equal(validated.languageModelProvider, 'XAI_VOICE')
assert.equal(validated.xaiRealtimeModel, 'grok-voice-latest')
assert.equal(validated.voice, 'eve')

const live = includeLive ? await verifyLiveRealtimeSession() : null
const speak = speakBaseUrl ? await verifySpeakBrowserSession(speakBaseUrl) : null

console.log(JSON.stringify({
  ok: true,
  live,
  speak,
  models: options.languageModels.map((option) => option.modelResource),
  voiceCount: options.voices.length,
  customVoiceCount: options.voices.filter((voice) => voice.provider === 'XAI_CUSTOM').length,
  codec: 'pcm16le',
  sampleRate: validated.xaiOutputSampleRate,
  codexAuthExposed: false,
}, null, 2))

async function verifySpeakBrowserSession(baseUrl) {
  assert.match(baseUrl, /^https?:\/\//, '--speak-base-url must be an HTTP(S) URL')
  const startedAt = Date.now()
  const startRequestId = randomUUID()
  const expectedPhrase = 'Speak xAI production ready'
  const startPayload = await requestJson(`${baseUrl}/api/config-tests/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startRequestId,
      productionContext: false,
      config: {
        voiceRuntimeProvider: 'xai',
        languageModelMode: 'xai',
        languageModelProvider: 'XAI_VOICE',
        languageModelResource: 'grok-voice-latest',
        xaiRealtimeModel: 'grok-voice-latest',
        xaiConfigId: 'xai-realtime',
        speakConfigId: 'xai-realtime',
        voice: 'eve',
        xaiVoiceId: 'eve',
        xaiVoiceName: 'Eve',
        xaiVoiceProvider: 'XAI_BUILTIN',
        xaiReasoningEffort: 'none',
        xaiLanguageHint: 'en',
        xaiVoiceSpeed: 1,
        xaiResumptionEnabled: true,
        xaiToolCallingEnabled: true,
        xaiOutputSampleRate: 16000,
        turnDetectionEnabled: true,
        interruptionEnabled: true,
        endOfTurnSilenceMs: 500,
        sampleRate: 16000,
        verboseTranscription: true,
        useConfigPrompt: true,
        useConfigTools: true,
        instructions:
          `This is a no-phone production verification. Respond in one short sentence and include exactly: ${expectedPhrase}.`,
      },
      lead: {
        id: `xai-production-probe-${startRequestId}`,
        firstName: 'xAI',
        name: 'xAI production probe',
        status: 'ready',
      },
    }),
  })
  const testId = String(startPayload.testId || startPayload.callControlId || '')
  assert.ok(testId, 'Speak did not return a Browser Playground session ID')

  let ended = false
  try {
    await sendSpeakMessageWhenReady(
      `${baseUrl}/api/config-tests/${encodeURIComponent(testId)}/message`,
      'Run the production verification now.',
    )
    const assistantTranscript = await waitForSpeakAssistantTranscript(
      baseUrl,
      testId,
      expectedPhrase,
    )
    await requestJson(`${baseUrl}/api/config-tests/${encodeURIComponent(testId)}/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    ended = true
    const summary = await waitForSpeakSummary(baseUrl, testId)
    const xaiAudioOutputBytes = Number(summary?.diagnostics?.counters?.xaiAudioOutputBytes || 0)
    assert.ok(xaiAudioOutputBytes > 0, 'Speak recorded no xAI audio output bytes')
    assert.equal(summary?.agent?.voiceRuntimeProvider, 'xai')
    return {
      ok: true,
      sessionId: testId,
      elapsedMs: Date.now() - startedAt,
      assistantTranscriptMatched: assistantTranscript.includes(expectedPhrase),
      xaiAudioOutputBytes,
      phoneCallPlaced: false,
    }
  } finally {
    if (!ended) {
      await fetch(`${baseUrl}/api/config-tests/${encodeURIComponent(testId)}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined)
    }
  }
}

async function sendSpeakMessageWhenReady(url, text) {
  let lastError = null
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5_000),
    })
    const payload = await response.json().catch(() => ({}))
    if (response.ok) return payload
    lastError = new Error(payload.error || `Speak message failed with HTTP ${response.status}`)
    if (response.status !== 409) break
    await wait(250)
  }
  throw lastError || new Error('Speak Browser Playground did not become ready')
}

async function waitForSpeakAssistantTranscript(baseUrl, testId, expectedPhrase) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const payload = await requestJson(`${baseUrl}/api/calls/recent?limit=100`)
    const summary = payload.calls?.find((call) => call.callControlId === testId)
    const assistantTranscript = summary?.transcript?.find(
      (entry) =>
        ['AI', 'Speak', 'Assistant'].includes(String(entry.speaker || '')) &&
        String(entry.text || '').includes(expectedPhrase),
    )
    if (assistantTranscript) return String(assistantTranscript.text)
    if (summary?.phase === 'ended') {
      throw new Error('Speak Browser Playground ended before the xAI response arrived')
    }
    await wait(250)
  }
  throw new Error('Speak returned no matching xAI assistant transcript within 30 seconds')
}

async function waitForSpeakSummary(baseUrl, testId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const payload = await requestJson(`${baseUrl}/api/calls/recent?limit=100`)
    const summary = payload.calls?.find((call) => call.callControlId === testId)
    if (summary?.phase === 'ended' && summary?.diagnostics) return summary
    await wait(250)
  }
  throw new Error('Speak did not persist terminal xAI diagnostics')
}

async function requestJson(url, init) {
  const response = await fetch(url, {
    ...init,
    signal: init?.signal || AbortSignal.timeout(15_000),
  })
  const payload = await response.json().catch(() => ({}))
  assert.ok(response.ok, payload.error || `${url} failed with HTTP ${response.status}`)
  return payload
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function verifyLiveRealtimeSession() {
  const apiKey = getXaiApiKey()
  assert.ok(apiKey, 'XAI_API_KEY is required for --live')
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      'wss://api.x.ai/v1/realtime?model=grok-voice-latest',
      { headers: { Authorization: `Bearer ${apiKey}` } },
    )
    let audioBytes = 0
    let assistantTranscript = ''
    let conversationId = ''
    let sessionUpdated = false
    const eventTypes = new Set()
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error('xAI live realtime verification timed out'))
    }, 30_000)

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          instructions:
            'You are a production voice-agent verification probe. Reply with exactly: Speak xAI runtime ready.',
          reasoning: { effort: 'none' },
          voice: 'eve',
          resumption: { enabled: true },
          turn_detection: { type: 'server_vad' },
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 16000 },
              transcription: { model: 'grok-transcribe', language_hint: 'en' },
            },
            output: {
              format: { type: 'audio/pcm', rate: 16000 },
              speed: 1,
            },
          },
        },
      }))
      ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Run the verification now.' }],
        },
      }))
      ws.send(JSON.stringify({ type: 'response.create' }))
    })

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        audioBytes += raw.length
        return
      }
      const event = JSON.parse(raw.toString())
      eventTypes.add(event.type)
      if (event.type === 'conversation.created') {
        conversationId = String(event.conversation?.id || '')
      }
      if (event.type === 'session.updated') sessionUpdated = true
      if (event.type === 'response.output_audio.delta' || event.type === 'response.audio.delta') {
        audioBytes += Buffer.from(event.delta || event.audio || '', 'base64').length
      }
      if (event.type === 'response.output_audio_transcript.delta') {
        assistantTranscript += event.delta || ''
      }
      if (event.type === 'response.output_audio_transcript.done') {
        assistantTranscript = event.transcript || assistantTranscript
      }
      if (event.type === 'error') {
        clearTimeout(timeout)
        ws.close()
        reject(new Error(event.error?.message || event.message || 'xAI realtime error'))
      }
      if (event.type === 'response.done') {
        clearTimeout(timeout)
        ws.close(1000, 'verification complete')
        try {
          assert.ok(sessionUpdated, 'xAI did not acknowledge session.update')
          assert.ok(conversationId, 'xAI did not issue a resumable conversation ID')
          assert.ok(audioBytes > 0, 'xAI returned no realtime audio')
          assert.match(assistantTranscript.toLowerCase(), /speak.*xai.*runtime.*ready/)
          resolve({
            ok: true,
            audioBytes,
            elapsedMs: Date.now() - startedAt,
            eventTypes: [...eventTypes].sort(),
            resumptionIdReceived: true,
            transcriptMatchedInstruction: true,
          })
        } catch (error) {
          reject(error)
        }
      }
    })
    ws.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}
