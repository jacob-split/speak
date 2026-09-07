import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

export const CALLTOOLS_AUDIO_STAGES = {
  'lead-calltools-input': 'lead-calltools-input.wav',
  'ai-calltools-output': 'ai-calltools-output.wav',
  'operator-calltools-output': 'operator-calltools-output.wav',
  'mixed-call': 'mixed-call.wav',
}

export function readCallToolsAudioEvidence({ callControlId, callAudioDir = 'call-audio' } = {}) {
  const id = safeAudioId(callControlId)
  if (!id) {
    return {
      callControlId: '',
      callAudioDir,
      diagnostics: {},
      mixed: null,
    }
  }

  const mixedPath = path.join(callAudioDir, `${id}.wav`)
  const diagnosticDir = path.join(callAudioDir, id)
  const diagnostics = {}
  for (const [stage, fileName] of Object.entries(CALLTOOLS_AUDIO_STAGES)) {
    const filePath = path.join(diagnosticDir, fileName)
    diagnostics[stage] = existsSync(filePath) ? analyzeWavFile(filePath) : null
  }

  return {
    callControlId,
    callAudioDir,
    mixed: existsSync(mixedPath) ? analyzeWavFile(mixedPath) : null,
    diagnostics,
  }
}

export function analyzeWavFile(filePath) {
  try {
    const buffer = readFileSync(filePath)
    const stat = statSync(filePath)
    const parsed = parseWav(buffer)
    if (!parsed.ok) {
      return {
        path: filePath,
        exists: true,
        bytes: stat.size,
        ok: false,
        error: parsed.error,
        audible: false,
        silent: true,
      }
    }

    const stats = pcm16Stats(parsed.data, {
      channels: parsed.channels,
      sampleRate: parsed.sampleRate,
    })
    return {
      path: filePath,
      exists: true,
      bytes: stat.size,
      ok: true,
      format: {
        audioFormat: parsed.audioFormat,
        channels: parsed.channels,
        sampleRate: parsed.sampleRate,
        bitsPerSample: parsed.bitsPerSample,
      },
      durationSeconds: round(stats.durationSeconds, 3),
      samples: stats.samples,
      peak: stats.peak,
      peakDbfs: stats.peakDbfs,
      rms: stats.rms,
      rmsDbfs: stats.rmsDbfs,
      nonzeroRatio: stats.nonzeroRatio,
      activeRatio: stats.activeRatio,
      audible: stats.audible,
      silent: !stats.audible,
    }
  } catch (error) {
    return {
      path: filePath,
      exists: false,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      audible: false,
      silent: true,
    }
  }
}

export function audioStatsSummary(stats) {
  if (!stats) return null
  if (!stats.ok) {
    return {
      ok: false,
      error: stats.error || 'missing',
      bytes: stats.bytes || 0,
      audible: false,
      silent: true,
    }
  }
  return {
    ok: true,
    bytes: stats.bytes,
    durationSeconds: stats.durationSeconds,
    peak: stats.peak,
    peakDbfs: stats.peakDbfs,
    rmsDbfs: stats.rmsDbfs,
    nonzeroRatio: stats.nonzeroRatio,
    activeRatio: stats.activeRatio,
    audible: stats.audible,
    silent: stats.silent,
  }
}

function parseWav(buffer) {
  if (buffer.length < 44) return { ok: false, error: 'wav_too_small' }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false, error: 'not_wav' }
  }

  let offset = 12
  let fmt = null
  let data = null
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const start = offset + 8
    const end = Math.min(start + size, buffer.length)
    if (chunkId === 'fmt ') {
      if (size < 16) return { ok: false, error: 'wav_fmt_chunk_too_small' }
      fmt = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      }
    } else if (chunkId === 'data') {
      data = buffer.subarray(start, end)
    }
    offset = end + (size % 2)
  }

  if (!fmt) return { ok: false, error: 'wav_fmt_chunk_missing' }
  if (!data) return { ok: false, error: 'wav_data_chunk_missing' }
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) {
    return { ok: false, error: `unsupported_wav_format_${fmt.audioFormat}_${fmt.bitsPerSample}` }
  }

  return {
    ok: true,
    ...fmt,
    data,
  }
}

function pcm16Stats(data, { channels = 1, sampleRate = 16000 } = {}) {
  const sampleCount = Math.floor(data.length / 2)
  let peak = 0
  let sumSquares = 0
  let nonzero = 0
  let active = 0
  for (let offset = 0; offset + 1 < data.length; offset += 2) {
    const value = data.readInt16LE(offset)
    const abs = Math.abs(value)
    if (abs > peak) peak = abs
    if (abs !== 0) nonzero += 1
    if (abs > 128) active += 1
    sumSquares += value * value
  }
  const rms = sampleCount ? Math.sqrt(sumSquares / sampleCount) : 0
  const durationSeconds = sampleRate && channels
    ? sampleCount / channels / sampleRate
    : 0
  const nonzeroRatio = sampleCount ? nonzero / sampleCount : 0
  const activeRatio = sampleCount ? active / sampleCount : 0
  const peakDbfs = peak ? 20 * Math.log10(peak / 32767) : null
  const rmsDbfs = rms ? 20 * Math.log10(rms / 32767) : null
  const audible = Boolean(
    peak >= 512 &&
      rmsDbfs !== null &&
      rmsDbfs > -60 &&
      activeRatio >= 0.001,
  )

  return {
    samples: sampleCount,
    durationSeconds,
    peak,
    peakDbfs: peakDbfs === null ? null : round(peakDbfs, 2),
    rms: round(rms, 2),
    rmsDbfs: rmsDbfs === null ? null : round(rmsDbfs, 2),
    nonzeroRatio: round(nonzeroRatio, 6),
    activeRatio: round(activeRatio, 6),
    audible,
  }
}

function safeAudioId(callControlId) {
  return String(callControlId || '').replace(/[^a-zA-Z0-9._-]/g, '_')
}

function round(value, places = 2) {
  const multiplier = 10 ** places
  return Math.round(Number(value || 0) * multiplier) / multiplier
}
