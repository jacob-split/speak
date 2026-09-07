export function downsampleToInt16(
  samples: Float32Array,
  inputSampleRate: number,
  targetSampleRate: number,
) {
  const ratio = inputSampleRate / targetSampleRate
  const outputLength = Math.max(1, Math.floor(samples.length / ratio))
  const buffer = new ArrayBuffer(outputLength * 2)
  const view = new DataView(buffer)

  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor(index * ratio)
    const end = Math.min(Math.floor((index + 1) * ratio), samples.length)
    let sum = 0
    const count = Math.max(1, end - start)

    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      sum += samples[sampleIndex]
    }

    const sample = Math.max(-1, Math.min(1, sum / count))
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }

  return buffer
}

interface Pcm16PacketizerOptions {
  inputSampleRate: number
  targetSampleRate: number
  frameDurationMs: number
  onFrame: (frame: ArrayBuffer) => void
}

export function createPcm16Packetizer({
  inputSampleRate,
  targetSampleRate,
  frameDurationMs,
  onFrame,
}: Pcm16PacketizerOptions) {
  const safeInputRate = Math.max(1, Number(inputSampleRate || targetSampleRate || 16000))
  const safeTargetRate = Math.max(1, Number(targetSampleRate || 16000))
  const frameSampleCount = Math.max(
    1,
    Math.round((safeTargetRate * Math.max(1, frameDurationMs)) / 1000),
  )
  const sourceStep = safeInputRate / safeTargetRate
  let sourceBuffer = new Float32Array(0)
  let readIndex = 0
  let frame = new Uint8Array(frameSampleCount * 2)
  let frameView = new DataView(frame.buffer)
  let frameOffset = 0

  return {
    push(input: Float32Array) {
      if (!input.length) return
      sourceBuffer = appendFloat32(sourceBuffer, input)
      while (readIndex + 1 < sourceBuffer.length) {
        const lower = Math.floor(readIndex)
        const upper = Math.min(sourceBuffer.length - 1, lower + 1)
        const fraction = readIndex - lower
        const sample =
          (sourceBuffer[lower] || 0) * (1 - fraction) +
          (sourceBuffer[upper] || 0) * fraction
        writePcm16Sample(frameView, frameOffset, sample)
        frameOffset += 1
        if (frameOffset >= frameSampleCount) emitFrame()
        readIndex += sourceStep
      }
      dropConsumedSamples()
    },
    reset() {
      sourceBuffer = new Float32Array(0)
      readIndex = 0
      frame = new Uint8Array(frameSampleCount * 2)
      frameView = new DataView(frame.buffer)
      frameOffset = 0
    },
  }

  function emitFrame() {
    onFrame(frame.buffer as ArrayBuffer)
    frame = new Uint8Array(frameSampleCount * 2)
    frameView = new DataView(frame.buffer)
    frameOffset = 0
  }

  function dropConsumedSamples() {
    const consumed = Math.max(0, Math.floor(readIndex) - 1)
    if (!consumed) return
    sourceBuffer = sourceBuffer.slice(consumed)
    readIndex -= consumed
  }
}

function appendFloat32(left: Float32Array, right: Float32Array) {
  if (!left.length) return new Float32Array(right)
  const next = new Float32Array(left.length + right.length)
  next.set(left)
  next.set(right, left.length)
  return next
}

function writePcm16Sample(view: DataView, sampleIndex: number, value: number) {
  const clamped = Math.max(-1, Math.min(1, value || 0))
  view.setInt16(
    sampleIndex * 2,
    clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
    true,
  )
}
