import { WebSocket } from 'ws'

const DEFAULT_WHISPER_SAMPLE_RATE = 16_000
const DEFAULT_WHISPER_MAX_MS = 30_000
const DEFAULT_FINALIZE_WAIT_MS = 2_500
const DEEPGRAM_LISTEN_URL = 'wss://api.deepgram.com/v1/listen'

export function createPlaygroundCallSupervision({
  createTranscriptionSocket = createDeepgramSocket,
  getDeepgramApiKey,
  onWhisperDelivered = () => undefined,
  sendInstruction,
  whisperFinalizeWaitMs = DEFAULT_FINALIZE_WAIT_MS,
  whisperMaxMs = Number(
    process.env.PLAYGROUND_AUDIO_WHISPER_MAX_MS || DEFAULT_WHISPER_MAX_MS,
  ),
} = {}) {
  if (typeof getDeepgramApiKey !== 'function') {
    throw new Error('Playground supervision requires a Deepgram secret resolver')
  }
  if (typeof sendInstruction !== 'function') {
    throw new Error('Playground supervision requires an instruction sender')
  }

  const clientsByState = new WeakMap()

  function isEligibleState(state) {
    return Boolean(
      state &&
        state.origin === 'playground_phone' &&
        state.callProvider === 'telnyx_texml' &&
        state.playgroundSupervisionToken &&
        !state.browserTest &&
        !state.personalPhoneInboundCorrelationId &&
        !state.ending &&
        state.streamId &&
        state.telnyxWs?.readyState === WebSocket.OPEN,
    )
  }

  function canAttach(state, token) {
    return Boolean(
      isEligibleState(state) && token === state.playgroundSupervisionToken,
    )
  }

  function attach(clientSocket, state, token) {
    if (!canAttach(state, token)) {
      clientSocket.close(1008, 'Playground Phone call is not available')
      return false
    }

    const client = {
      monitorEnabled: false,
      socket: clientSocket,
      state,
      token,
      whisper: null,
    }
    const clients = clientsByState.get(state) || new Set()
    clients.add(client)
    clientsByState.set(state, clients)

    sendClient(client, {
      type: 'ready',
      audioWhisperAvailable: Boolean(getDeepgramApiKey()),
      maxWhisperMs: boundedWhisperMaxMs(whisperMaxMs),
      spyAvailable: true,
    })

    clientSocket.on('message', (raw, isBinary) => {
      if (isBinary) {
        forwardWhisperAudio(client, Buffer.from(raw))
        return
      }
      void handleClientCommand(client, raw).catch((error) => {
        failWhisper(client, publicError(error, 'Phone supervision command failed'))
      })
    })
    clientSocket.on('close', () => {
      clients.delete(client)
      cancelWhisper(client)
    })
    clientSocket.on('error', () => {
      clients.delete(client)
      cancelWhisper(client)
    })
    return true
  }

  async function handleClientCommand(client, raw) {
    let message
    try {
      message = JSON.parse(String(raw || ''))
    } catch {
      sendClientError(client, 'command', 'Invalid supervision command')
      return
    }

    if (message.type === 'monitor.set') {
      if (!canAttach(client.state, client.token)) {
        sendClientError(client, 'monitor', 'Playground Phone call is no longer live')
        return
      }
      client.monitorEnabled = Boolean(message.enabled)
      sendClient(client, {
        type: 'monitor.updated',
        enabled: client.monitorEnabled,
      })
      return
    }

    if (message.type === 'whisper.start') {
      await startWhisper(client, message)
      return
    }

    if (message.type === 'whisper.stop') {
      stopWhisper(client, 'operator_stop')
      return
    }

    if (message.type === 'whisper.cancel') {
      cancelWhisper(client)
      sendClient(client, { type: 'whisper.cancelled' })
      return
    }

    sendClientError(client, 'command', 'Unsupported supervision command')
  }

  async function startWhisper(client, message) {
    if (!canAttach(client.state, client.token) || !client.state.chatId) {
      sendClientError(client, 'whisper', 'Speak voice session is not attached yet')
      return
    }
    if (client.state.takeover) {
      sendClientError(client, 'whisper', 'Release Barge before coaching the agent')
      return
    }
    if (client.whisper) {
      sendClientError(client, 'whisper', 'An audio whisper is already active')
      return
    }

    const apiKey = getDeepgramApiKey()
    if (!apiKey) {
      sendClientError(client, 'whisper', 'Audio Whisper transcription is not configured')
      return
    }

    const sampleRate = Number(message.sampleRate || DEFAULT_WHISPER_SAMPLE_RATE)
    if (sampleRate !== DEFAULT_WHISPER_SAMPLE_RATE) {
      sendClientError(client, 'whisper', 'Audio Whisper requires 16000 Hz PCM')
      return
    }

    const transcriptionSocket = createTranscriptionSocket({
      apiKey,
      sampleRate,
    })
    const whisper = {
      bytes: 0,
      client,
      connectTimer: null,
      delivered: false,
      finalSegments: [],
      finalizeTimer: null,
      maxTimer: null,
      sampleRate,
      socket: transcriptionSocket,
      started: false,
      stopping: false,
    }
    client.whisper = whisper
    whisper.connectTimer = setTimeout(() => {
      if (client.whisper === whisper && !whisper.started) {
        failWhisper(client, 'Audio Whisper transcription timed out')
      }
    }, 5_000)
    whisper.connectTimer.unref?.()

    transcriptionSocket.on('open', () => {
      if (client.whisper !== whisper) return
      if (whisper.connectTimer) clearTimeout(whisper.connectTimer)
      whisper.connectTimer = null
      whisper.started = true
      whisper.maxTimer = setTimeout(() => {
        if (client.whisper !== whisper || whisper.stopping) return
        sendClient(client, { type: 'whisper.limit' })
        stopWhisper(client, 'time_limit')
      }, boundedWhisperMaxMs(whisperMaxMs))
      whisper.maxTimer.unref?.()
      sendClient(client, {
        type: 'whisper.ready',
        maxWhisperMs: boundedWhisperMaxMs(whisperMaxMs),
      })
    })

    transcriptionSocket.on('message', (raw) => {
      handleTranscriptionMessage(whisper, raw)
    })

    transcriptionSocket.on('error', () => {
      if (client.whisper === whisper) {
        failWhisper(client, 'Audio Whisper transcription failed')
      }
    })

    transcriptionSocket.on('close', () => {
      if (client.whisper !== whisper || whisper.delivered) return
      if (whisper.stopping && whisper.finalSegments.length > 0) {
        void deliverWhisper(whisper)
        return
      }
      failWhisper(client, 'Audio Whisper transcription disconnected')
    })
  }

  function forwardWhisperAudio(client, pcm) {
    const whisper = client.whisper
    if (
      !whisper ||
      !whisper.started ||
      whisper.stopping ||
      whisper.socket.readyState !== WebSocket.OPEN ||
      !pcm.length
    ) {
      return
    }
    const maxBytes = Math.ceil(
      (whisper.sampleRate * 2 * boundedWhisperMaxMs(whisperMaxMs)) / 1000,
    )
    if (whisper.bytes + pcm.length > maxBytes) {
      sendClient(client, { type: 'whisper.limit' })
      stopWhisper(client, 'byte_limit')
      return
    }
    whisper.bytes += pcm.length
    whisper.socket.send(pcm)
  }

  function stopWhisper(client, reason) {
    const whisper = client.whisper
    if (!whisper || whisper.stopping) return
    whisper.stopping = true
    if (whisper.maxTimer) clearTimeout(whisper.maxTimer)
    whisper.maxTimer = null

    if (whisper.socket.readyState === WebSocket.OPEN) {
      whisper.socket.send(JSON.stringify({ type: 'Finalize' }))
      whisper.finalizeTimer = setTimeout(() => {
        if (client.whisper !== whisper || whisper.delivered) return
        if (whisper.finalSegments.length > 0) {
          void deliverWhisper(whisper)
        } else {
          failWhisper(client, 'No speech was detected in the audio whisper')
        }
      }, Math.max(250, Number(whisperFinalizeWaitMs) || DEFAULT_FINALIZE_WAIT_MS))
      whisper.finalizeTimer.unref?.()
      sendClient(client, { type: 'whisper.processing', reason })
      return
    }

    failWhisper(client, 'Audio Whisper transcription was not ready')
  }

  function handleTranscriptionMessage(whisper, raw) {
    if (whisper.client.whisper !== whisper || whisper.delivered) return
    let message
    try {
      message = JSON.parse(String(raw || ''))
    } catch {
      return
    }
    if (message.type === 'Error') {
      failWhisper(whisper.client, 'Audio Whisper transcription failed')
      return
    }
    if (message.type !== 'Results') return

    const transcript = String(
      message.channel?.alternatives?.[0]?.transcript || '',
    )
      .replace(/\s+/g, ' ')
      .trim()
    if (message.is_final && transcript) {
      const previous = whisper.finalSegments[whisper.finalSegments.length - 1]
      if (previous !== transcript) whisper.finalSegments.push(transcript)
    }
    if (transcript) {
      sendClient(whisper.client, {
        type: 'whisper.transcript',
        final: Boolean(message.is_final),
        transcript,
      })
    }
    if (whisper.stopping && message.from_finalize) {
      if (whisper.finalSegments.length > 0) {
        void deliverWhisper(whisper)
      } else {
        failWhisper(whisper.client, 'No speech was detected in the audio whisper')
      }
    }
  }

  async function deliverWhisper(whisper) {
    if (whisper.delivered || whisper.client.whisper !== whisper) return
    whisper.delivered = true
    clearWhisperTimers(whisper)
    const instruction = whisper.finalSegments.join(' ').replace(/\s+/g, ' ').trim()
    if (!instruction) {
      failWhisper(whisper.client, 'No speech was detected in the audio whisper')
      return
    }
    try {
      await sendInstruction(whisper.client.state, instruction)
      await onWhisperDelivered(whisper.client.state, instruction)
      sendClient(whisper.client, {
        type: 'whisper.delivered',
        transcript: instruction,
      })
      finishWhisper(whisper.client)
    } catch (error) {
      failWhisper(
        whisper.client,
        publicError(error, 'Audio Whisper delivery failed'),
      )
    }
  }

  function publishAudio(state, source, pcmLittleEndian, sampleRate) {
    if (!isEligibleState(state) || !pcmLittleEndian?.length) return 0
    if (source !== 'contact' && source !== 'agent') return 0
    const clients = clientsByState.get(state)
    if (!clients?.size) return 0
    const frame = JSON.stringify({
      type: 'audio',
      data: Buffer.from(pcmLittleEndian).toString('base64'),
      sampleRate: Number(sampleRate || state.sampleRate || DEFAULT_WHISPER_SAMPLE_RATE),
      source,
    })
    let sent = 0
    for (const client of clients) {
      if (!client.monitorEnabled || client.socket.readyState !== WebSocket.OPEN) continue
      client.socket.send(frame)
      sent += 1
    }
    return sent
  }

  function clearAudio(state, source = 'agent', reason = 'operator_clear') {
    const clients = clientsByState.get(state)
    if (!clients?.size) return
    for (const client of clients) {
      if (!client.monitorEnabled) continue
      sendClient(client, {
        type: 'audio.clear',
        reason: String(reason || 'operator_clear'),
        source,
      })
    }
  }

  function close(state, reason = 'call_closed') {
    const clients = clientsByState.get(state)
    if (!clients?.size) return
    for (const client of clients) {
      cancelWhisper(client)
      if (client.socket.readyState === WebSocket.OPEN) {
        client.socket.close(1000, reason)
      }
    }
    clients.clear()
  }

  function finishWhisper(client) {
    const whisper = client.whisper
    if (!whisper) return
    clearWhisperTimers(whisper)
    client.whisper = null
    closeTranscriptionSocket(whisper.socket)
  }

  function cancelWhisper(client) {
    const whisper = client.whisper
    if (!whisper) return
    clearWhisperTimers(whisper)
    client.whisper = null
    closeTranscriptionSocket(whisper.socket)
  }

  function failWhisper(client, error) {
    sendClientError(client, 'whisper', error)
    finishWhisper(client)
  }

  return {
    attach,
    canAttach,
    clearAudio,
    close,
    publishAudio,
  }
}

function createDeepgramSocket({ apiKey, sampleRate }) {
  const url = new URL(DEEPGRAM_LISTEN_URL)
  url.searchParams.set('model', process.env.DEEPGRAM_STT_MODEL || 'nova-3')
  url.searchParams.set('language', process.env.DEEPGRAM_STT_LANGUAGE || 'en-US')
  url.searchParams.set('encoding', 'linear16')
  url.searchParams.set('sample_rate', String(sampleRate))
  url.searchParams.set('channels', '1')
  url.searchParams.set('interim_results', 'true')
  url.searchParams.set('punctuate', 'true')
  url.searchParams.set('smart_format', 'true')
  url.searchParams.set('vad_events', 'true')
  url.searchParams.set('endpointing', '300')
  return new WebSocket(url, {
    headers: { Authorization: `Token ${apiKey}` },
  })
}

function closeTranscriptionSocket(socket) {
  if (!socket) return
  try {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'CloseStream' }))
    }
    socket.close()
  } catch {
    // The provider socket may already be closing after finalization.
  }
}

function clearWhisperTimers(whisper) {
  if (whisper.connectTimer) clearTimeout(whisper.connectTimer)
  if (whisper.finalizeTimer) clearTimeout(whisper.finalizeTimer)
  if (whisper.maxTimer) clearTimeout(whisper.maxTimer)
  whisper.connectTimer = null
  whisper.finalizeTimer = null
  whisper.maxTimer = null
}

function boundedWhisperMaxMs(value) {
  return Math.min(60_000, Math.max(5_000, Number(value) || DEFAULT_WHISPER_MAX_MS))
}

function sendClient(client, message) {
  if (client.socket.readyState === WebSocket.OPEN) {
    client.socket.send(JSON.stringify(message))
  }
}

function sendClientError(client, operation, error) {
  sendClient(client, {
    type: 'error',
    operation,
    error: String(error || 'Phone supervision failed'),
  })
}

function publicError(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback
}
