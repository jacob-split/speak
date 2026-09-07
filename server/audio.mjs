const DEFAULT_SAMPLE_RATE = 16000

export function normalizeAudioCodec(value) {
  const codec = String(value || '').trim().toUpperCase()
  if (['PCMU', 'MULAW', 'MU-LAW', 'ULAW', 'G711_ULAW'].includes(codec)) {
    return 'PCMU'
  }
  if (['L16', 'LINEAR16', 'PCM16', 'PCM_S16LE', 'S16LE'].includes(codec)) {
    return 'L16'
  }
  return ''
}

export function decodeTelnyxPayload(payload, codec) {
  const normalized = normalizeAudioCodec(codec)

  if (normalized === 'PCMU') {
    return decodeUlawToPcm16Le(payload)
  }

  if (normalized === 'L16') {
    if (payload.length % 2 !== 0) {
      throw new Error(`Invalid L16 payload byte length: ${payload.length}`)
    }

    // Phone L16 WebSocket payloads on this call-control path are observed little-endian.
    return payload
  }

  throw new Error(`Unsupported phone media codec: ${codec || 'missing'}`)
}

export function analyzePcm16(samples) {
  let peak = 0
  let sumSquares = 0
  let clipped = 0

  for (const sample of samples || []) {
    const abs = Math.abs(sample)
    peak = Math.max(peak, abs)
    sumSquares += sample * sample
    if (abs >= 32760) clipped += 1
  }

  const sampleCount = Math.max(1, samples?.length || 0)
  return {
    peak,
    peakRatio: peak / 32767,
    rms: Math.sqrt(sumSquares / sampleCount),
    clipped,
    clippedRatio: clipped / sampleCount,
  }
}

export function pcm16IsAudible(
  samples,
  { minimumPeak = 512, minimumRmsDbfs = -60 } = {},
) {
  if (!samples?.length) return false
  const stats = analyzePcm16(samples)
  const minimumRms = 32767 * 10 ** (Number(minimumRmsDbfs) / 20)
  return stats.peak >= Math.max(1, Number(minimumPeak) || 0) && stats.rms > minimumRms
}

export function decodeWavPcm16(buffer, fallbackSampleRate = DEFAULT_SAMPLE_RATE) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') {
    return {
      samples: bufferToInt16LE(buffer),
      sampleRate: fallbackSampleRate,
    }
  }

  let offset = 12
  let channels = 1
  let sampleRate = fallbackSampleRate
  let bitsPerSample = 16
  let dataStart = -1
  let dataSize = 0

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    const chunkStart = offset + 8

    if (chunkId === 'fmt ') {
      channels = buffer.readUInt16LE(chunkStart + 2)
      sampleRate = buffer.readUInt32LE(chunkStart + 4)
      bitsPerSample = buffer.readUInt16LE(chunkStart + 14)
    }

    if (chunkId === 'data') {
      dataStart = chunkStart
      dataSize = chunkSize
      break
    }

    offset = chunkStart + chunkSize + (chunkSize % 2)
  }

  if (dataStart < 0 || bitsPerSample !== 16) {
    return {
      samples: bufferToInt16LE(buffer),
      sampleRate,
    }
  }

  const raw = buffer.subarray(dataStart, dataStart + dataSize)
  const samples = bufferToInt16LE(raw)

  if (channels === 1) {
    return { samples, sampleRate }
  }

  const mono = new Int16Array(Math.floor(samples.length / channels))
  for (let index = 0; index < mono.length; index += 1) {
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) {
      sum += samples[index * channels + channel]
    }
    mono[index] = clampInt16(sum / channels)
  }

  return { samples: mono, sampleRate }
}

export function resamplePcm16(samples, inputRate, outputRate) {
  if (inputRate === outputRate) return samples

  const ratio = inputRate / outputRate
  const outputLength = Math.max(1, Math.floor(samples.length / ratio))
  const output = new Int16Array(outputLength)

  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio
    const left = Math.floor(sourceIndex)
    const right = Math.min(samples.length - 1, left + 1)
    const weight = sourceIndex - left
    output[index] = clampInt16(samples[left] * (1 - weight) + samples[right] * weight)
  }

  return output
}

export function levelPcm16ForPhone(samples, options = {}) {
  const gain = clampNumber(options.gain, 0.1, 1.25, 0.72)
  const peakRatio = clampNumber(options.peakRatio, 0.25, 0.95, 0.58)
  const peak = peakRatio * 32767
  const kneeStart = peak * 0.78
  const kneeRange = Math.max(1, peak - kneeStart)
  const output = new Int16Array(samples.length)

  for (let index = 0; index < samples.length; index += 1) {
    const scaled = samples[index] * gain
    const sign = scaled < 0 ? -1 : 1
    const magnitude = Math.abs(scaled)

    if (magnitude <= kneeStart) {
      output[index] = clampInt16(scaled)
      continue
    }

    const overKnee = Math.min(1, Math.max(0, (magnitude - kneeStart) / (32767 - kneeStart)))
    const eased = 1 - Math.exp(-4 * overKnee)
    output[index] = clampInt16(sign * (kneeStart + kneeRange * eased))
  }

  return output
}

export function bufferToInt16LE(buffer) {
  const samples = new Int16Array(Math.floor(buffer.length / 2))
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = buffer.readInt16LE(index * 2)
  }
  return samples
}

export function int16ToBufferLE(samples) {
  const buffer = Buffer.alloc(samples.length * 2)
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(samples[index], index * 2)
  }
  return buffer
}

export function decodeUlawToPcm16Le(buffer) {
  const output = Buffer.alloc(buffer.length * 2)
  for (let index = 0; index < buffer.length; index += 1) {
    output.writeInt16LE(ulawDecode(buffer[index]), index * 2)
  }
  return output
}

export function encodePcm16LeToUlaw(buffer) {
  const output = Buffer.alloc(Math.floor(buffer.length / 2))
  for (let index = 0; index < output.length; index += 1) {
    output[index] = ulawEncode(buffer.readInt16LE(index * 2))
  }
  return output
}

export function clampInt16(value) {
  return Math.max(-32768, Math.min(32767, Math.round(value)))
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function ulawDecode(byte) {
  const value = ~byte & 0xff
  const sign = value & 0x80
  const exponent = (value >> 4) & 0x07
  const mantissa = value & 0x0f
  let sample = ((mantissa << 3) + 0x84) << exponent
  sample -= 0x84
  return sign ? -sample : sample
}

function ulawEncode(sample) {
  const BIAS = 0x84
  const CLIP = 32635
  let sign = 0
  let pcm = Math.trunc(sample)

  if (pcm < 0) {
    pcm = -pcm
    sign = 0x80
  }

  pcm = Math.min(CLIP, pcm) + BIAS
  let exponent = 7
  for (let mask = 0x4000; (pcm & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent -= 1
  }
  const mantissa = (pcm >> (exponent + 3)) & 0x0f
  return ~(sign | (exponent << 4) | mantissa) & 0xff
}
