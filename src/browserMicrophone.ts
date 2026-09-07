import { createPcm16Packetizer } from './browserAudio'

const PCM_CAPTURE_PROCESSOR = 'speak-pcm-capture'
const DEFAULT_FRAME_DURATION_MS = 20

export interface BrowserPcmCapture {
  stop: () => void
}

interface StartBrowserPcmCaptureOptions {
  frameDurationMs?: number
  onFrame: (frame: ArrayBuffer) => void
  targetSampleRate: number
}

export async function startBrowserPcmCapture({
  frameDurationMs = DEFAULT_FRAME_DURATION_MS,
  onFrame,
  targetSampleRate,
}: StartBrowserPcmCaptureOptions): Promise<BrowserPcmCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      autoGainControl: true,
      echoCancellation: true,
      noiseSuppression: true,
    },
  })
  const context = new AudioContext()
  let source: MediaStreamAudioSourceNode | null = null
  let processor: AudioNode | null = null
  let stopped = false

  try {
    if (context.state !== 'running') await context.resume()
    source = context.createMediaStreamSource(stream)
    const packetizer = createPcm16Packetizer({
      frameDurationMs,
      inputSampleRate: context.sampleRate,
      onFrame: (frame) => {
        if (!stopped) onFrame(frame)
      },
      targetSampleRate,
    })

    try {
      if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
        throw new Error('AudioWorklet is unavailable')
      }
      const moduleUrl = URL.createObjectURL(
        new Blob([pcmCaptureProcessorSource()], { type: 'text/javascript' }),
      )
      try {
        await context.audioWorklet.addModule(moduleUrl)
      } finally {
        URL.revokeObjectURL(moduleUrl)
      }
      const worklet = new AudioWorkletNode(context, PCM_CAPTURE_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      })
      worklet.port.onmessage = (event) => {
        packetizer.push(new Float32Array(event.data))
      }
      processor = worklet
    } catch {
      const fallback = context.createScriptProcessor(1024, 1, 1)
      fallback.onaudioprocess = (event) => {
        event.outputBuffer.getChannelData(0).fill(0)
        packetizer.push(new Float32Array(event.inputBuffer.getChannelData(0)))
      }
      processor = fallback
    }

    source.connect(processor)
    processor.connect(context.destination)

    return {
      stop() {
        if (stopped) return
        stopped = true
        if (processor && 'port' in processor) {
          ;(processor as AudioWorkletNode).port.onmessage = null
        }
        processor?.disconnect()
        source?.disconnect()
        stream.getTracks().forEach((track) => track.stop())
        packetizer.reset()
        void context.close()
      },
    }
  } catch (error) {
    disconnectAudioNode(processor)
    source?.disconnect()
    stream.getTracks().forEach((track) => track.stop())
    void context.close()
    throw error
  }
}

function disconnectAudioNode(node: AudioNode | null) {
  node?.disconnect()
}

function pcmCaptureProcessorSource() {
  return `
    class SpeakPcmCapture extends AudioWorkletProcessor {
      process(inputs, outputs) {
        const input = inputs[0] && inputs[0][0];
        const output = outputs[0] && outputs[0][0];
        if (output) output.fill(0);
        if (input && input.length) {
          const copy = new Float32Array(input);
          this.port.postMessage(copy, [copy.buffer]);
        }
        return true;
      }
    }
    registerProcessor('${PCM_CAPTURE_PROCESSOR}', SpeakPcmCapture);
  `
}
