import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { getInworldApiKey } from '../server/secrets.mjs'

const argumentsList = process.argv.slice(2)
const argumentValue = (name) =>
  argumentsList.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3) || ''
const model =
  argumentValue('model') ||
  process.env.INWORLD_TOOL_CAPABILITY_MODEL ||
  'google-ai-studio/gemini-3.5-flash'
const audioSmoke = process.argv.includes('--audio-smoke')
const omitReasoning = process.argv.includes('--omit-reasoning')
const fastMode = process.argv.includes('--fast-mode')
const conversational = process.argv.includes('--conversational') && !fastMode
const voice = argumentValue('voice') || process.env.INWORLD_VOICE_ID || 'Sarah'
const requestedReasoningEffort = argumentValue('reasoning-effort').toUpperCase()
const reasoningEffort = ['NONE', 'MINIMAL', 'LOW', 'MEDIUM', 'HIGH', 'XHIGH'].includes(
  requestedReasoningEffort,
)
  ? requestedReasoningEffort
  : 'NONE'
const timeoutMs = Math.max(
  3_000,
  Number(
    argumentValue('timeout-ms') || (audioSmoke ? 30_000 : 12_000),
  ),
)
const apiKey = getInworldApiKey()

if (!apiKey) {
  console.error(JSON.stringify({ ok: false, error: 'INWORLD_API_KEY is required' }))
  process.exit(1)
}

const url = new URL('wss://api.inworld.ai/api/v1/realtime/session')
url.searchParams.set('key', `speak-tool-capability-${randomUUID()}`)
url.searchParams.set('protocol', 'realtime')

const result = await new Promise((resolve) => {
  const socket = new WebSocket(url, {
    headers: { Authorization: `Basic ${apiKey}` },
  })
  let settled = false
  let inputSent = false
  let audioBytes = 0
  let firstAudioMs = null
  const startedAt = Date.now()

  function finish(value) {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    socket.close(1000, 'Capability probe complete')
    resolve(value)
  }

  const timeout = setTimeout(() => {
    finish({
      ok: false,
      model,
      voice,
      audioSmoke,
      audioBytes,
      error: audioSmoke
        ? 'Timed out waiting for Inworld audio smoke proof'
        : 'Timed out waiting for session.updated',
    })
  }, timeoutMs)

  socket.on('message', (raw) => {
    let message
    try {
      message = JSON.parse(raw.toString())
    } catch {
      finish({ ok: false, model, error: 'Inworld returned invalid JSON' })
      return
    }

    if (message.type === 'session.created') {
      socket.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          model,
          instructions: audioSmoke
            ? 'Capability and audio smoke probe only. Reply with exactly: Ready.'
            : 'Capability probe only. Do not generate a response.',
          output_modalities: ['audio', 'text'],
          text_generation_config: omitReasoning
            ? undefined
            : {
                reasoning: { effort: reasoningEffort },
              },
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 16000 },
              transcription: { model: 'inworld/inworld-stt-1', language: 'en' },
              turn_detection: {
                type: 'semantic_vad',
                eagerness: 'high',
                create_response: true,
                interrupt_response: true,
              },
            },
            output: {
              format: { type: 'audio/pcm', rate: 16000 },
              voice,
              model: 'inworld-tts-2',
              speed: 1,
            },
          },
          tools: [{
            type: 'function',
            name: 'get_contact_context',
            description: 'Return contact context. Capability schema only; never invoked by this probe.',
            parameters: { type: 'object', properties: {}, required: [] },
          }],
          tool_choice: 'auto',
          providerData: {
            stt: { voice_profile: true },
            tts: {
              segmenter_strategy: fastMode
                ? 'fast_start'
                : conversational
                  ? 'full_turn'
                  : 'full_turn',
              steering_handling: 'emit_once',
              language: 'en-US',
              delivery_mode: 'CREATIVE',
              conversational,
              user_turn_mode: 'both',
            },
            responsiveness: { enabled: false },
          },
        },
      }))
      return
    }

    if (message.type === 'session.updated') {
      if (audioSmoke && !inputSent) {
        inputSent = true
        socket.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Say ready.' }],
          },
        }))
        socket.send(JSON.stringify({
          type: 'response.create',
          response: { output_modalities: ['audio', 'text'] },
        }))
        return
      }
      finish({
        ok: true,
        model,
        voice,
        toolCallingEnabled: true,
        proof: 'session.updated',
        generatedResponse: false,
      })
      return
    }

    if (audioSmoke && message.type === 'response.output_audio.delta') {
      const bytes = Buffer.from(String(message.delta || ''), 'base64').length
      if (bytes > 0 && firstAudioMs === null) firstAudioMs = Date.now() - startedAt
      audioBytes += bytes
      return
    }

    if (audioSmoke && message.type === 'response.done') {
      const responseStatus = String(message.response?.status || 'completed')
      finish({
        ok: audioBytes > 0 && responseStatus !== 'failed',
        model,
        voice,
        reasoningEffort,
        omitReasoning,
        fastMode,
        conversational,
        toolCallingEnabled: true,
        proof: audioBytes > 0 ? 'response.output_audio.delta' : 'response.done_without_audio',
        generatedResponse: true,
        audioBytes,
        firstAudioMs,
        responseStatus,
        elapsedMs: Date.now() - startedAt,
        ...(audioBytes > 0 ? {} : { error: 'Inworld response completed without audio' }),
      })
      return
    }

    if (message.type === 'error') {
      finish({
        ok: false,
        model,
        voice,
        audioSmoke,
        audioBytes,
        code: String(message.error?.code || ''),
        param: String(message.error?.param || ''),
        error: String(message.error?.message || message.message || 'Inworld realtime error'),
      })
    }
  })

  socket.on('error', (error) => {
    finish({ ok: false, model, error: error.message || 'Inworld WebSocket failed' })
  })

  socket.on('close', (code) => {
    if (!settled) finish({ ok: false, model, error: `Inworld closed before proof (code ${code})` })
  })
})

console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1
