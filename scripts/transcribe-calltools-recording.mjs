import 'dotenv/config'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getInworldApiKey } from '../server/secrets.mjs'
import { INWORLD_API_BASE, providerError, readJson } from '../server/provider-http.mjs'
import { DEFAULT_INWORLD_STT_MODEL } from '../server/runtime-config.mjs'

const DEFAULT_LANGUAGE = 'en-US'

export async function transcribeAudioWithInworldStt({
  filePath,
  modelId = process.env.CALLTOOLS_RECORDING_STT_MODEL || DEFAULT_INWORLD_STT_MODEL,
  language = process.env.CALLTOOLS_RECORDING_STT_LANGUAGE || DEFAULT_LANGUAGE,
  audioEncoding,
} = {}) {
  const cleanPath = safeText(filePath)
  if (!cleanPath) {
    throw Object.assign(new Error('A recording file path is required.'), {
      code: 'recording_file_required',
    })
  }
  if (!existsSync(cleanPath)) {
    throw Object.assign(new Error(`Recording file was not found: ${cleanPath}`), {
      code: 'recording_file_missing',
    })
  }
  const apiKey = getInworldApiKey()
  if (!apiKey) {
    throw Object.assign(new Error('INWORLD_API_KEY is required for Speak-generated recording-derived transcription.'), {
      code: 'inworld_api_key_missing',
    })
  }

  const audioBase64 = readFileSync(cleanPath).toString('base64')
  const encoding = normalizeAudioEncoding(audioEncoding || inferAudioEncoding(cleanPath))
  const requestBody = {
    transcribeConfig: {
      modelId,
      audioEncoding: encoding,
      language,
    },
    audioData: {
      content: audioBase64,
    },
  }
  const response = await fetch(`${INWORLD_API_BASE}/stt/v1/transcribe`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Basic ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  })
  const payload = await readJson(response)
  if (!response.ok) {
    throw Object.assign(
      new Error(providerError('Inworld STT recording-derived transcription failed', payload)),
      {
        status: response.status,
        code: 'inworld_stt_failed',
        payload,
      },
    )
  }

  const text = firstText(
    payload.text,
    payload.transcript,
    payload.transcription?.transcript,
    payload.transcription?.text,
    payload.transcription,
    payload.result?.text,
    payload.result?.transcript,
    payload.results?.[0]?.text,
    payload.results?.[0]?.transcript,
  )

  return {
    ok: Boolean(text),
    source: 'inworld_stt',
    filePath: cleanPath,
    modelId,
    language,
    audioEncoding: encoding,
    text,
    payload,
  }
}

async function main() {
  const { flags, options } = parseArgs(process.argv.slice(2))
  const filePath = safeText(options.recordingFile || options.file || options.input)
  const json = flags.has('--json')
  try {
    const result = await transcribeAudioWithInworldStt({
      filePath,
      modelId: options.sttModel || options.model,
      language: options.language,
      audioEncoding: options.audioEncoding,
    })
    if (json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(`CallTools recording-derived transcript: ${result.ok ? 'available' : 'empty'}`)
      console.log(`Source: ${result.source} ${result.modelId}`)
      if (result.text) console.log(result.text)
    }
    process.exit(result.ok ? 0 : 2)
  } catch (error) {
    const payload = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: error?.code || 'provider_recording_transcription_failed',
      status: error?.status,
    }
    if (json) {
      console.log(JSON.stringify(payload, null, 2))
    } else {
      console.error(`${payload.code}: ${payload.error}`)
    }
    process.exit(2)
  }
}

function parseArgs(args = []) {
  const flags = new Set(args.filter((arg) => arg.startsWith('--') && !arg.includes('=')))
  const options = Object.fromEntries(
    args
      .filter((arg) => arg.startsWith('--') && arg.includes('='))
      .map((arg) => {
        const [key, ...rest] = arg.slice(2).split('=')
        return [key, rest.join('=')]
      }),
  )
  return { flags, options }
}

function normalizeAudioEncoding(value = '') {
  const encoding = safeText(value).toUpperCase()
  return ['AUTO_DETECT', 'LINEAR16', 'MP3', 'OGG_OPUS', 'FLAC'].includes(encoding)
    ? encoding
    : 'AUTO_DETECT'
}

function inferAudioEncoding(filePath = '') {
  const lower = safeText(filePath).toLowerCase()
  if (lower.endsWith('.wav')) return 'AUTO_DETECT'
  if (lower.endsWith('.mp3')) return 'MP3'
  if (lower.endsWith('.opus') || lower.endsWith('.ogg')) return 'OGG_OPUS'
  if (lower.endsWith('.flac')) return 'FLAC'
  return 'AUTO_DETECT'
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' || typeof value === 'number') {
      const text = safeText(value)
      if (text) return text
    }
  }
  return ''
}

function safeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
