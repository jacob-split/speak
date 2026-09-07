export const HUME_AUDIO_ENCODING = 'linear16'
export const HUME_AUDIO_CHANNELS = 1
export const HUME_DEFAULT_SAMPLE_RATE = 16000
export const HUME_INPUT_PRIMER_CHUNK_MS = 100

export function applyHumeHandshakeSessionSettings(url, settings = {}) {
  const systemPrompt = String(settings?.system_prompt || '')
  const customSessionId = String(settings?.custom_session_id || '')

  if (systemPrompt.trim()) {
    url.searchParams.set('session_settings[system_prompt]', systemPrompt)
  }
  if (customSessionId.trim()) {
    url.searchParams.set('session_settings[custom_session_id]', customSessionId)
  }

  return url
}

export function buildHumeCodexPromptContext(systemPrompt, context) {
  const prompt = String(systemPrompt || '').trim()
  const runtimeContext = String(context || '').trim()

  return [
    prompt
      ? [
          '<active_profile_instructions>',
          'These are the exact active Speak agent instructions. Follow them for every response, including a quick response.',
          prompt,
          '</active_profile_instructions>',
        ].join('\n')
      : '',
    runtimeContext,
  ]
    .filter(Boolean)
    .join('\n')
}

export function stripHumeCodexPromptContext(value) {
  return String(value || '')
    .replace(
      /<active_profile_instructions>[\s\S]*?<\/active_profile_instructions>\s*/g,
      '',
    )
    .trim()
}

export function humeAudioSessionSettings(sampleRate) {
  const normalizedSampleRate = Number(sampleRate)

  return {
    encoding: HUME_AUDIO_ENCODING,
    sample_rate:
      Number.isFinite(normalizedSampleRate) && normalizedSampleRate > 0
        ? Math.round(normalizedSampleRate)
        : HUME_DEFAULT_SAMPLE_RATE,
    channels: HUME_AUDIO_CHANNELS,
  }
}

export function humeInputPrimerFrame(
  sampleRate,
  chunkMs = HUME_INPUT_PRIMER_CHUNK_MS,
) {
  const normalizedSampleRate = Number(sampleRate)
  const normalizedChunkMs = Number(chunkMs)
  const samplesPerSecond =
    Number.isFinite(normalizedSampleRate) && normalizedSampleRate > 0
      ? Math.round(normalizedSampleRate)
      : HUME_DEFAULT_SAMPLE_RATE
  const durationMs =
    Number.isFinite(normalizedChunkMs) && normalizedChunkMs > 0
      ? normalizedChunkMs
      : HUME_INPUT_PRIMER_CHUNK_MS
  const byteLength = Math.max(
    2,
    Math.round((samplesPerSecond * 2 * durationMs) / 1_000 / 2) * 2,
  )
  return Buffer.alloc(byteLength)
}
