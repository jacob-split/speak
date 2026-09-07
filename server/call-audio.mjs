import {
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import {
  bufferToInt16LE,
  int16ToBufferLE,
  resamplePcm16,
} from './audio.mjs'

const MAX_AUDIO_BYTES = Number(process.env.CALL_AUDIO_MAX_BYTES || 25_000_000)
const DIAGNOSTIC_STAGES = new Map([
  ['lead-hume-input', 'lead-hume-input.wav'],
  ['lead-calltools-input', 'lead-calltools-input.wav'],
  ['ai-hume-output', 'ai-hume-output.wav'],
  ['ai-telnyx-output', 'ai-telnyx-output.wav'],
  ['ai-calltools-output', 'ai-calltools-output.wav'],
  ['operator-calltools-output', 'operator-calltools-output.wav'],
  ['mixed-call', 'mixed-call.wav'],
])

export function recordCallAudioBuffer(
  state,
  { source = 'unknown', pcmLittleEndian, sampleRate },
) {
  if (!pcmLittleEndian?.length) return
  recordCallAudioSamples(state, {
    source,
    samples: bufferToInt16LE(pcmLittleEndian),
    sampleRate,
  })
}

export function recordCallAudioSamples(
  state,
  { source = 'unknown', samples, sampleRate },
) {
  if (!state || state.browserTest || !samples?.length) return

  const targetRate = Number(state.sampleRate || sampleRate || 8000)
  const normalizedSamples =
    sampleRate && sampleRate !== targetRate
      ? resamplePcm16(samples, sampleRate, targetRate)
      : samples
  const chunk = int16ToBufferLE(normalizedSamples)

  if (!state.audioRecordingChunks) {
    state.audioRecordingChunks = []
    state.audioRecordingBytes = 0
    state.audioRecordingSources = new Set()
  }

  if (state.audioRecordingBytes + chunk.length > MAX_AUDIO_BYTES) {
    state.audioRecordingOverflow = true
    return
  }

  state.audioRecordingChunks.push(chunk)
  state.audioRecordingBytes += chunk.length
  state.audioRecordingSources.add(source)
}

export function recordCallStageAudioBuffer(
  state,
  { stage, pcmLittleEndian, sampleRate },
) {
  if (!pcmLittleEndian?.length) return
  recordCallStageAudioSamples(state, {
    stage,
    samples: bufferToInt16LE(pcmLittleEndian),
    sampleRate,
  })
}

export function recordCallStageAudioSamples(
  state,
  { stage, samples, sampleRate },
) {
  if (!state || state.browserTest || !samples?.length) return
  if (!DIAGNOSTIC_STAGES.has(stage)) return

  state.stageAudioRecordings ||= {}
  const existing =
    state.stageAudioRecordings[stage] ||
    {
      chunks: [],
      bytes: 0,
      sampleRate: Number(sampleRate || state.sampleRate || 16000),
      overflow: false,
    }
  const targetRate = Number(existing.sampleRate || sampleRate || state.sampleRate || 16000)
  const normalizedSamples =
    sampleRate && sampleRate !== targetRate
      ? resamplePcm16(samples, sampleRate, targetRate)
      : samples
  const chunk = int16ToBufferLE(normalizedSamples)

  if (existing.bytes + chunk.length > MAX_AUDIO_BYTES) {
    existing.overflow = true
    state.stageAudioRecordings[stage] = existing
    return
  }

  existing.chunks.push(chunk)
  existing.bytes += chunk.length
  existing.sampleRate = targetRate
  state.stageAudioRecordings[stage] = existing
}

export function finalizeCallAudio(callAudioDir, state, basePath = '') {
  if (!state || state.browserTest) return null

  const existing = localCallAudioMetadata(callAudioDir, state.callControlId, basePath)
  if (existing) {
    return {
      ...existing,
      diagnostics: finalizeDiagnosticAudio(callAudioDir, state, basePath),
    }
  }

  const chunks = state.audioRecordingChunks || []
  if (chunks.length === 0) {
    const diagnostics = finalizeDiagnosticAudio(callAudioDir, state, basePath)
    return diagnostics ? { status: 'diagnostics-only', diagnostics } : null
  }

  mkdirSync(callAudioDir, { recursive: true })
  const sampleRate = Number(state.sampleRate || 8000)
  const pcm = Buffer.concat(chunks)
  const wav = writeWavPcm16Mono(pcm, sampleRate)
  const filePath = callAudioFilePath(callAudioDir, state.callControlId)
  writeFileSync(filePath, wav)
  recordCallStageAudioBuffer(state, {
    stage: 'mixed-call',
    pcmLittleEndian: pcm,
    sampleRate,
  })
  const diagnostics = finalizeDiagnosticAudio(callAudioDir, state, basePath)

  return localCallAudioMetadata(callAudioDir, state.callControlId, basePath, {
    durationSeconds: durationSeconds(pcm.length, sampleRate),
    sources: Array.from(state.audioRecordingSources || []),
    diagnostics,
  })
}

export function callAudioFilePath(callAudioDir, callControlId) {
  return path.join(callAudioDir, `${safeAudioId(callControlId)}.wav`)
}

export function callAudioDiagnosticFilePath(callAudioDir, callControlId, stage) {
  const fileName = DIAGNOSTIC_STAGES.get(stage)
  if (!fileName) return ''
  return path.join(callAudioDir, safeAudioId(callControlId), fileName)
}

export function localCallAudioMetadata(
  callAudioDir,
  callControlId,
  basePath = '',
  extras = {},
) {
  const filePath = callAudioFilePath(callAudioDir, callControlId)
  if (!existsSync(filePath)) return null

  const stats = statSync(filePath)
  if (stats.size <= 44) return null

  return {
    status: 'ready',
    source: 'local',
    contentType: 'audio/wav',
    bytes: stats.size,
    url: `${basePath}/api/calls/${encodeURIComponent(callControlId)}/audio`,
    ...extras,
  }
}

function safeAudioId(callControlId) {
  return String(callControlId || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_')
}

function finalizeDiagnosticAudio(callAudioDir, state, basePath = '') {
  if (!state?.stageAudioRecordings) return null

  const diagnostics = {}
  for (const [stage, fileName] of DIAGNOSTIC_STAGES.entries()) {
    const recording = state.stageAudioRecordings[stage]
    if (!recording?.chunks?.length) continue

    const dir = path.join(callAudioDir, safeAudioId(state.callControlId))
    mkdirSync(dir, { recursive: true })
    const pcm = Buffer.concat(recording.chunks)
    const wav = writeWavPcm16Mono(pcm, recording.sampleRate)
    const filePath = path.join(dir, fileName)
    if (!existsSync(filePath)) {
      writeFileSync(filePath, wav)
    }

    diagnostics[stage] = {
      status: 'ready',
      contentType: 'audio/wav',
      bytes: statSync(filePath).size,
      sampleRate: recording.sampleRate,
      durationSeconds: durationSeconds(pcm.length, recording.sampleRate),
      overflow: Boolean(recording.overflow),
      url: `${basePath}/api/calls/${encodeURIComponent(
        state.callControlId,
      )}/audio/diagnostics/${stage}`,
    }
  }

  return Object.keys(diagnostics).length > 0 ? diagnostics : null
}

function writeWavPcm16Mono(pcm, sampleRate) {
  const header = Buffer.alloc(44)
  const dataSize = pcm.length
  const byteRate = sampleRate * 2

  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)

  return Buffer.concat([header, pcm])
}

function durationSeconds(byteLength, sampleRate) {
  return Math.round((byteLength / 2 / sampleRate) * 10) / 10
}
