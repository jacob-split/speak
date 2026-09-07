import { WebSocket } from 'ws'
import {
  decodeTelnyxPayload,
  encodePcm16LeToUlaw,
  normalizeAudioCodec,
} from './audio.mjs'
import {
  addTransportCounter,
  recordTransportMilestone,
} from './transport-diagnostics.mjs'

export const TELNYX_FRAME_MS = Number(process.env.TELNYX_FRAME_MS || 20)
export const TELNYX_MAX_QUEUE_MS = Number(process.env.TELNYX_MAX_QUEUE_MS || 30_000)

export function samplesPerTelnyxFrame(state) {
  return Math.round(Number(state?.sampleRate || 16000) * TELNYX_FRAME_MS / 1000)
}

export function queueTelnyxPcmFrames(state, pcmLittleEndian) {
  if (!state || !pcmLittleEndian?.length) return []

  const frameSamples = samplesPerTelnyxFrame(state)
  const frameBytes = frameSamples * 2
  const merged = Buffer.concat([
    state.telnyxOutboundRemainder || Buffer.alloc(0),
    pcmLittleEndian,
  ])
  const payloads = []
  let offset = 0

  while (offset + frameBytes <= merged.length) {
    const framePcm = merged.subarray(offset, offset + frameBytes)
    const payload =
      normalizeAudioCodec(state.telnyxCodec) === 'PCMU'
        ? encodePcm16LeToUlaw(framePcm)
        : framePcm
    payloads.push(payload)
    offset += frameBytes
  }

  state.telnyxOutboundRemainder = merged.subarray(offset)
  return payloads
}

export function enqueuePcmToTelnyx(
  state,
  pcmLittleEndian,
  { onFrameSent } = {},
) {
  if (!state?.telnyxWs || state.telnyxWs.readyState !== WebSocket.OPEN) return
  if (typeof onFrameSent === 'function') {
    state.telnyxOutboundFrameObserver = onFrameSent
  }

  state.telnyxOutboundQueue ||= []
  const payloads = queueTelnyxPcmFrames(state, pcmLittleEndian)
  addTransportCounter(state, 'telnyxPcmOutBytes', payloads.length * samplesPerTelnyxFrame(state) * 2)
  state.telnyxOutboundQueue.push(
    ...payloads.map((payload) => payload.toString('base64')),
  )
  trimTelnyxOutboundQueue(state)
  updateQueueQuality(state)
  startTelnyxOutboundPump(state)
}

export function flushTelnyxOutboundRemainder(state) {
  if (!state?.telnyxOutboundRemainder?.length) return

  const frameBytes = samplesPerTelnyxFrame(state) * 2
  const padded = Buffer.alloc(frameBytes)
  state.telnyxOutboundRemainder.copy(padded)
  state.telnyxOutboundRemainder = Buffer.alloc(0)

  state.telnyxOutboundQueue ||= []
  const payload =
    normalizeAudioCodec(state.telnyxCodec) === 'PCMU'
      ? encodePcm16LeToUlaw(padded)
      : padded
  addTransportCounter(state, 'telnyxPcmOutBytes', padded.length)
  state.telnyxOutboundQueue.push(payload.toString('base64'))
  trimTelnyxOutboundQueue(state)
  updateQueueQuality(state)
  startTelnyxOutboundPump(state)
}

export function clearTelnyxOutboundQueue(state, { sendClear = true } = {}) {
  if (!state) return
  state.telnyxOutboundQueue = []
  state.telnyxOutboundRemainder = Buffer.alloc(0)

  if (state.telnyxOutboundTimer) {
    clearTimeout(state.telnyxOutboundTimer)
    state.telnyxOutboundTimer = null
  }

  updateQueueQuality(state)

  if (sendClear && state.telnyxWs?.readyState === WebSocket.OPEN) {
    state.telnyxWs.send(JSON.stringify({ event: 'clear' }))
  }
}

function startTelnyxOutboundPump(state) {
  if (state.telnyxOutboundTimer) return

  const pump = () => {
    state.telnyxOutboundTimer = null

    if (!state?.telnyxWs || state.telnyxWs.readyState !== WebSocket.OPEN) return

    const payload = state.telnyxOutboundQueue?.shift()
    if (!payload) {
      updateQueueQuality(state)
      return
    }

    const payloadBuffer = Buffer.from(payload, 'base64')
    state.telnyxWs.send(
      JSON.stringify({
        event: 'media',
        media: { payload },
      }),
    )
    addTransportCounter(state, 'telnyxMediaOutPackets')
    addTransportCounter(state, 'telnyxMediaOutBytes', payloadBuffer.length)
    if (typeof state.telnyxOutboundFrameObserver === 'function') {
      state.telnyxOutboundFrameObserver(
        decodeTelnyxPayload(payloadBuffer, state.telnyxCodec),
        state.sampleRate,
      )
    }
    recordTransportMilestone(state, 'first_telnyx_media_out', {
      codec: state.telnyxCodec,
      sampleRate: state.sampleRate,
    })
    updateQueueQuality(state)
    state.telnyxOutboundTimer = setTimeout(pump, TELNYX_FRAME_MS)
  }

  state.telnyxOutboundTimer = setTimeout(pump, 0)
}

function trimTelnyxOutboundQueue(state) {
  const maxFrames = Math.ceil(TELNYX_MAX_QUEUE_MS / TELNYX_FRAME_MS)
  const queue = state.telnyxOutboundQueue || []
  if (queue.length <= maxFrames) return

  const overflow = queue.length - maxFrames
  // Preserve chronological speech under backpressure. Dropping the oldest
  // frames jumps the caller into the middle or tail of a sentence when a TTS
  // provider produces audio faster than realtime playback. Barge-in already
  // clears the whole queue, so retain the earliest unsent audio and discard
  // only overflow beyond the bounded spoken-turn window.
  queue.splice(maxFrames, overflow)
  state.telnyxDroppedOutboundFrames =
    (state.telnyxDroppedOutboundFrames || 0) + overflow
}

function updateQueueQuality(state) {
  if (!state?.audioQuality?.queue) return

  const queue = state.telnyxOutboundQueue || []
  state.audioQuality.queue.maxFrames = Math.max(
    state.audioQuality.queue.maxFrames || 0,
    queue.length,
  )
  state.audioQuality.queue.maxMs = Math.max(
    state.audioQuality.queue.maxMs || 0,
    queue.length * TELNYX_FRAME_MS,
  )
  state.audioQuality.queue.droppedFrames = state.telnyxDroppedOutboundFrames || 0
}
