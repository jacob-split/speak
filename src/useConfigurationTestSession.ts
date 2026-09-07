import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { AgentTestVariables } from './agentConfigs'
import { apiUrl, makeConfigTestAudioSocketUrl } from './api'
import { createPcm16Packetizer } from './browserAudio'
import { appendTranscriptEntry } from './calls'
import type { ActiveCall, CampaignConfig, Lead, TranscriptEntry } from './types'

interface ConfigurationTestStartPayload {
  config: CampaignConfig
  lead?: Lead
  productionContext?: boolean
  testVariableKeys: Array<keyof AgentTestVariables>
  testVariables: Partial<AgentTestVariables>
}

interface ConfigurationTestSessionOptions {
  buildStartPayload: () => ConfigurationTestStartPayload
  onPhoneEnded?: () => void
}

interface ConfigurationTestStartOptions {
  microphone?: boolean
}

interface ConfigurationPhoneTestStartPayload {
  config: CampaignConfig
  lead: Lead
}

export type ConfigurationTestMode = 'idle' | 'browser' | 'phone'

interface StoppedSession {
  id: string
  mode: ConfigurationTestMode
}

interface PendingStartRequest {
  id: string
  mode: Exclude<ConfigurationTestMode, 'idle'>
}

const PLAYGROUND_INPUT_FRAME_MS = 20
const PLAYGROUND_CAPTURE_PROCESSOR = 'speak-playground-recorder'

function wait(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

function phoneLeadLabel(lead: Lead) {
  return lead.company || lead.name || lead.phone || 'Test contact'
}

function createPlaygroundStartRequestId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `playground-${globalThis.crypto.randomUUID()}`
  }
  return `playground-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function useConfigurationTestSession({
  buildStartPayload,
  onPhoneEnded,
}: ConfigurationTestSessionOptions) {
  const socketRef = useRef<WebSocket | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const playbackContextRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<AudioNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const playbackSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set())
  const runTokenRef = useRef(0)
  const sessionIdRef = useRef('')
  const modeRef = useRef<ConfigurationTestMode>('idle')
  const startingRef = useRef(false)
  const startRequestPendingRef = useRef(false)
  const pendingStartRequestRef = useRef<PendingStartRequest | null>(null)
  const backendEndCountRef = useRef(0)
  const endingRef = useRef(false)
  const activeCallRef = useRef<ActiveCall | null>(null)
  const onPhoneEndedRef = useRef(onPhoneEnded)
  const playbackCursorRef = useRef(0)
  const [mode, setMode] = useState<ConfigurationTestMode>('idle')
  const [status, setStatus] = useState('Test idle')
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [sessionId, setSessionId] = useState('')
  const [attemptId, setAttemptId] = useState('')
  const [startedAt, setStartedAt] = useState('')
  const [leadLabel, setLeadLabel] = useState('')
  const [activeCall, setActiveCallState] = useState<ActiveCall | null>(null)
  const [starting, setStarting] = useState(false)
  const [ending, setEnding] = useState(false)
  const [running, setRunning] = useState(false)
  const [messageSending, setMessageSending] = useState(false)

  useEffect(() => {
    onPhoneEndedRef.current = onPhoneEnded
  }, [onPhoneEnded])

  const setActiveCall: Dispatch<SetStateAction<ActiveCall | null>> = useCallback(
    (nextValue) => {
      setActiveCallState((current) => {
        const next =
          typeof nextValue === 'function'
            ? nextValue(current)
            : nextValue
        activeCallRef.current = next
        return next
      })
    },
    [],
  )

  const clearPlaybackQueue = useCallback(() => {
    playbackSourcesRef.current.forEach((source) => {
      try {
        source.stop()
      } catch {
        // Already stopped sources throw; closing the context below completes cleanup.
      }
      source.disconnect()
    })
    playbackSourcesRef.current.clear()
    playbackCursorRef.current = playbackContextRef.current?.currentTime || 0
  }, [])

  const clearLocalTransports = useCallback(() => {
    clearPlaybackQueue()
    if (processorRef.current && 'port' in processorRef.current) {
      ;(processorRef.current as AudioWorkletNode).port.onmessage = null
    }
    processorRef.current?.disconnect()
    sourceRef.current?.disconnect()
    socketRef.current?.close()
    streamRef.current?.getTracks().forEach((track) => track.stop())
    eventSourceRef.current?.close()
    void audioContextRef.current?.close()
    void playbackContextRef.current?.close()

    processorRef.current = null
    sourceRef.current = null
    socketRef.current = null
    streamRef.current = null
    eventSourceRef.current = null
    audioContextRef.current = null
    playbackContextRef.current = null
    playbackCursorRef.current = 0
  }, [clearPlaybackQueue])

  const endBackendSession = useCallback(async (
    stopped: StoppedSession,
    keepalive = false,
  ) => {
    if (!stopped.id || stopped.mode === 'idle') return
    const phone = stopped.mode === 'phone'
    const maxAttempts = phone && !keepalive ? 60 : 1
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const response = await fetch(
        apiUrl(
          phone
            ? `/calls/${encodeURIComponent(stopped.id)}/end`
            : `/config-tests/${encodeURIComponent(stopped.id)}/end`,
        ),
        {
          method: 'POST',
          headers: phone ? { 'Content-Type': 'application/json' } : undefined,
          body: phone ? JSON.stringify({ outcome: 'operator-ended' }) : undefined,
          keepalive,
        },
      )
      if (response.ok) return
      const payload = await response.json().catch(() => ({})) as { error?: string }
      const hangupPending =
        response.status === 409 && /hangup.*(waiting|pending)|already.*hangup/i.test(
          payload.error || '',
        )
      if (hangupPending && attempt + 1 < maxAttempts) {
        await wait(250)
        continue
      }
      throw new Error(
        payload.error || (phone ? 'Phone test end failed' : 'Playground test end failed'),
      )
    }
  }, [])

  const beginEnding = useCallback(() => {
    endingRef.current = true
    setEnding(true)
  }, [])

  const clearEndingIfSettled = useCallback(() => {
    if (startRequestPendingRef.current || backendEndCountRef.current > 0) return
    endingRef.current = false
    setEnding(false)
  }, [])

  const endBackendSessionTracked = useCallback(async (
    stopped: StoppedSession,
    keepalive = false,
  ) => {
    if (!stopped.id || stopped.mode === 'idle') return
    backendEndCountRef.current += 1
    beginEnding()
    try {
      await endBackendSession(stopped, keepalive)
    } finally {
      backendEndCountRef.current = Math.max(0, backendEndCountRef.current - 1)
      clearEndingIfSettled()
    }
  }, [beginEnding, clearEndingIfSettled, endBackendSession])

  const cancelPendingStartRequest = useCallback((keepalive = false) => {
    const pending = pendingStartRequestRef.current
    if (!pending) return
    pendingStartRequestRef.current = null

    const url = apiUrl(
      `/playground-starts/${encodeURIComponent(pending.id)}/cancel`,
    )
    const body = JSON.stringify({
      mode: pending.mode,
      reason: 'client_cancelled',
    })
    if (keepalive && typeof navigator.sendBeacon === 'function') {
      try {
        if (navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) {
          return
        }
      } catch {
        // Fall through to a keepalive fetch when Beacon is unavailable or rejected.
      }
    }
    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => undefined)
  }, [])

  const stopLocal = useCallback((
    nextStatus?: string,
    keepalive = false,
  ): StoppedSession => {
    const wasStarting = startingRef.current || startRequestPendingRef.current
    const stopped = {
      id: sessionIdRef.current,
      mode: modeRef.current,
    }
    runTokenRef.current += 1
    startingRef.current = false
    cancelPendingStartRequest(keepalive)
    clearLocalTransports()
    sessionIdRef.current = ''
    activeCallRef.current = null
    setSessionId('')
    setActiveCallState(null)
    setStarting(false)
    setRunning(false)
    if (wasStarting) beginEnding()
    if (nextStatus) setStatus(nextStatus)
    return stopped
  }, [beginEnding, cancelPendingStartRequest, clearLocalTransports])

  const reset = useCallback(() => {
    if (sessionIdRef.current || startingRef.current || startRequestPendingRef.current) {
      beginEnding()
    }
    const stopped = stopLocal('Test idle')
    if (stopped.id) {
      void endBackendSessionTracked(stopped).catch(() => undefined)
    } else {
      clearEndingIfSettled()
    }
    modeRef.current = 'idle'
    setMode('idle')
    setTranscript([])
    setAttemptId('')
    setStartedAt('')
    setLeadLabel('')
    setMessageSending(false)
  }, [beginEnding, clearEndingIfSettled, endBackendSessionTracked, stopLocal])

  useEffect(() => {
    return () => {
      const stopped = stopLocal(undefined, true)
      if (stopped.id) {
        void endBackendSession(stopped, true).catch(() => undefined)
      }
    }
  }, [endBackendSession, stopLocal])

  const playAudio = useCallback(
    async (base64Audio: string, sampleRate: number, runToken: number) => {
      if (runToken !== runTokenRef.current) return
      const audioContext = playbackContextRef.current || new AudioContext()
      playbackContextRef.current = audioContext
      if (audioContext.state !== 'running') await audioContext.resume()
      if (runToken !== runTokenRef.current) return

      const bytes = Uint8Array.from(atob(base64Audio), (char) => char.charCodeAt(0))
      const view = new DataView(bytes.buffer)
      const sampleCount = Math.floor(bytes.byteLength / 2)
      const buffer = audioContext.createBuffer(1, sampleCount, sampleRate)
      const channel = buffer.getChannelData(0)

      for (let index = 0; index < sampleCount; index += 1) {
        channel[index] = view.getInt16(index * 2, true) / 32768
      }

      const source = audioContext.createBufferSource()
      source.buffer = buffer
      source.connect(audioContext.destination)
      source.onended = () => {
        playbackSourcesRef.current.delete(source)
      }
      const startAt = Math.max(audioContext.currentTime, playbackCursorRef.current)
      playbackSourcesRef.current.add(source)
      source.start(startAt)
      playbackCursorRef.current = startAt + buffer.duration
    },
    [],
  )

  const openEventStream = useCallback((
    nextMode: Exclude<ConfigurationTestMode, 'idle'>,
    nextSessionId: string,
    runToken: number,
  ) => {
    const events = new EventSource(
      apiUrl(`/calls/${encodeURIComponent(nextSessionId)}/events`),
    )
    events.onmessage = (event) => {
      if (runToken !== runTokenRef.current) return
      let eventPayload: {
        entry?: TranscriptEntry
        notice?: string
        patch?: Partial<ActiveCall>
      }
      try {
        eventPayload = JSON.parse(event.data)
      } catch {
        setStatus(`${nextMode === 'phone' ? 'Phone' : 'Browser'} test event was invalid`)
        return
      }
      if (eventPayload.entry) {
        setTranscript((current) =>
          appendTranscriptEntry(current, eventPayload.entry as TranscriptEntry),
        )
      }
      if (eventPayload.notice) setStatus(eventPayload.notice)
      if (nextMode === 'phone' && eventPayload.patch) {
        setActiveCall((current) =>
          current ? { ...current, ...eventPayload.patch } : current,
        )
      }
      if (eventPayload.patch?.phase === 'ended') {
        stopLocal()
        setStatus(
          eventPayload.notice ||
            (nextMode === 'phone' ? 'Phone test ended' : 'Playground test ended'),
        )
        if (nextMode === 'phone') onPhoneEndedRef.current?.()
      }
    }
    events.onerror = () => {
      if (
        runToken === runTokenRef.current &&
        sessionIdRef.current === nextSessionId
      ) {
        setStatus(
          `${nextMode === 'phone' ? 'Phone' : 'Browser'} test transcript reconnecting`,
        )
      }
    }
    eventSourceRef.current = events
    return events
  }, [setActiveCall, stopLocal])

  const start = useCallback(async (options: ConfigurationTestStartOptions = {}) => {
    if (
      sessionIdRef.current ||
      startingRef.current ||
      startRequestPendingRef.current ||
      endingRef.current
    ) return null
    const withMicrophone = options.microphone !== false

    const priorSession = stopLocal()
    if (priorSession.id) {
      await endBackendSessionTracked(priorSession).catch(() => undefined)
    }
    startRequestPendingRef.current = true
    const runToken = runTokenRef.current + 1
    runTokenRef.current = runToken
    startingRef.current = true
    modeRef.current = 'browser'
    setMode('browser')
    setStarting(true)
    setRunning(false)
    setStatus('Starting Playground test...')
    setTranscript([])
    setAttemptId('')
    setStartedAt('')
    setActiveCallState(null)
    const startRequestId = createPlaygroundStartRequestId()
    pendingStartRequestRef.current = { id: startRequestId, mode: 'browser' }
    try {
      const startPayload = buildStartPayload()
      setLeadLabel(startPayload.lead ? phoneLeadLabel(startPayload.lead) : 'Test contact')
      const response = await fetch(apiUrl('/config-tests/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...startPayload, startRequestId }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        if (pendingStartRequestRef.current?.id === startRequestId) {
          pendingStartRequestRef.current = null
        }
        throw new Error(payload.error || 'Playground test failed to start')
      }

      const testId = String(payload.testId || payload.callControlId)
      if (!testId) throw new Error('Playground test failed to return a session')
      if (runToken !== runTokenRef.current) {
        await endBackendSessionTracked({ id: testId, mode: 'browser' }, true).catch(
          () => undefined,
        )
        return null
      }
      if (pendingStartRequestRef.current?.id === startRequestId) {
        pendingStartRequestRef.current = null
      }
      sessionIdRef.current = testId
      setSessionId(testId)
      setAttemptId(testId)
      setStartedAt(new Date().toISOString())
      openEventStream('browser', testId, runToken)

      if (!withMicrophone) {
        startingRef.current = false
        setStarting(false)
        setRunning(true)
        setStatus('Playground chat live')
        return testId
      }

      const socket = new WebSocket(makeConfigTestAudioSocketUrl(testId))
      socket.binaryType = 'arraybuffer'
      socket.onmessage = (event) => {
        if (runToken !== runTokenRef.current) return
        const message = JSON.parse(String(event.data)) as {
          type?: string
          data?: string
          sampleRate?: number
        }
        if (message.type === 'audio' && message.data) {
          void playAudio(
            message.data,
            message.sampleRate || startPayload.config.sampleRate,
            runToken,
          )
        }
        if (message.type === 'audio_clear') clearPlaybackQueue()
      }
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve()
        socket.onerror = () => reject(new Error('Playground test audio failed'))
      })
      if (runToken !== runTokenRef.current) {
        socket.close()
        return null
      }
      socketRef.current = socket

      const audioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
      })
      if (runToken !== runTokenRef.current) {
        audioStream.getTracks().forEach((track) => track.stop())
        socket.close()
        return null
      }
      streamRef.current = audioStream

      const audioContext = new AudioContext()
      if (audioContext.state !== 'running') await audioContext.resume()
      if (runToken !== runTokenRef.current) {
        await audioContext.close().catch(() => undefined)
        audioStream.getTracks().forEach((track) => track.stop())
        socket.close()
        return null
      }
      const source = audioContext.createMediaStreamSource(audioStream)
      const packetizer = createPcm16Packetizer({
        inputSampleRate: audioContext.sampleRate,
        targetSampleRate: startPayload.config.sampleRate,
        frameDurationMs: PLAYGROUND_INPUT_FRAME_MS,
        onFrame: (frame) => {
          if (runToken !== runTokenRef.current) return
          if (socket.readyState !== WebSocket.OPEN) return
          socket.send(frame)
        },
      })
      let processor: AudioNode
      try {
        if (!audioContext.audioWorklet || typeof AudioWorkletNode === 'undefined') {
          throw new Error('AudioWorklet is unavailable')
        }
        const moduleUrl = URL.createObjectURL(
          new Blob([playgroundRecorderProcessorSource()], {
            type: 'text/javascript',
          }),
        )
        try {
          await audioContext.audioWorklet.addModule(moduleUrl)
        } finally {
          URL.revokeObjectURL(moduleUrl)
        }
        const worklet = new AudioWorkletNode(
          audioContext,
          PLAYGROUND_CAPTURE_PROCESSOR,
          {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions: {
              frameDurationMs: PLAYGROUND_INPUT_FRAME_MS,
            },
          },
        )
        worklet.port.onmessage = (event) => {
          packetizer.push(new Float32Array(event.data))
        }
        processor = worklet
      } catch {
        const fallback = audioContext.createScriptProcessor(1024, 1, 1)
        fallback.onaudioprocess = (event) => {
          event.outputBuffer.getChannelData(0).fill(0)
          packetizer.push(
            new Float32Array(event.inputBuffer.getChannelData(0)),
          )
        }
        processor = fallback
      }
      if (runToken !== runTokenRef.current) {
        if ('port' in processor) {
          ;(processor as AudioWorkletNode).port.onmessage = null
        }
        processor.disconnect()
        await audioContext.close().catch(() => undefined)
        audioStream.getTracks().forEach((track) => track.stop())
        socket.close()
        return null
      }
      source.connect(processor)
      processor.connect(audioContext.destination)

      audioContextRef.current = audioContext
      processorRef.current = processor
      sourceRef.current = source
      playbackCursorRef.current = 0
      startingRef.current = false
      setStarting(false)
      setRunning(true)
      setStatus('Playground voice live')
      return testId
    } catch (error) {
      const staleRun = runToken !== runTokenRef.current
      const orphanedSession = stopLocal()
      if (orphanedSession.id) {
        await endBackendSessionTracked(orphanedSession).catch(() => undefined)
      }
      if (!staleRun) {
        setStatus(error instanceof Error ? error.message : 'Playground test failed')
      }
      return null
    } finally {
      if (pendingStartRequestRef.current?.id === startRequestId) {
        pendingStartRequestRef.current = null
      }
      startRequestPendingRef.current = false
      clearEndingIfSettled()
    }
  }, [
    buildStartPayload,
    clearPlaybackQueue,
    clearEndingIfSettled,
    endBackendSessionTracked,
    openEventStream,
    playAudio,
    stopLocal,
  ])

  const startPhone = useCallback(async ({
    config,
    lead,
  }: ConfigurationPhoneTestStartPayload) => {
    if (
      sessionIdRef.current ||
      startingRef.current ||
      startRequestPendingRef.current ||
      endingRef.current
    ) return null

    const priorSession = stopLocal()
    if (priorSession.id) {
      await endBackendSessionTracked(priorSession).catch(() => undefined)
    }
    startRequestPendingRef.current = true
    const runToken = runTokenRef.current + 1
    runTokenRef.current = runToken
    startingRef.current = true
    modeRef.current = 'phone'
    setMode('phone')
    setStarting(true)
    setRunning(false)
    setStatus(`Dialing ${phoneLeadLabel(lead)}...`)
    setTranscript([])
    setAttemptId('')
    setStartedAt('')
    setLeadLabel(phoneLeadLabel(lead))
    setActiveCallState(null)
    const startRequestId = createPlaygroundStartRequestId()
    pendingStartRequestRef.current = { id: startRequestId, mode: 'phone' }

    try {
      const response = await fetch(apiUrl('/calls/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lead,
          config,
          origin: 'playground_phone',
          startRequestId,
        }),
      })
      const payload = (await response.json().catch(() => ({}))) as {
        callControlId?: string
        chatId?: string | null
        error?: string
        playgroundSupervisionToken?: string
        streamId?: string | null
      }
      if (!response.ok || !payload.callControlId) {
        if (pendingStartRequestRef.current?.id === startRequestId) {
          pendingStartRequestRef.current = null
        }
        throw new Error(payload.error || 'Phone test failed to start')
      }

      if (runToken !== runTokenRef.current) {
        await endBackendSessionTracked(
          { id: payload.callControlId, mode: 'phone' },
          true,
        ).catch(() => undefined)
        return null
      }

      if (pendingStartRequestRef.current?.id === startRequestId) {
        pendingStartRequestRef.current = null
      }

      const started = new Date().toISOString()
      const nextActiveCall: ActiveCall = {
        leadId: lead.id,
        callControlId: payload.callControlId,
        chatId: payload.chatId || undefined,
        streamId: payload.streamId || undefined,
        phase: 'dialing',
        startedAt: Date.parse(started),
        takeover: false,
        outcome: undefined,
        playgroundSupervisionToken: payload.playgroundSupervisionToken,
      }
      sessionIdRef.current = payload.callControlId
      activeCallRef.current = nextActiveCall
      setSessionId(payload.callControlId)
      setAttemptId(payload.callControlId)
      setActiveCallState(nextActiveCall)
      setStartedAt(started)
      setRunning(true)
      setStatus(`Phone test dialing ${phoneLeadLabel(lead)}`)
      startingRef.current = false
      setStarting(false)
      openEventStream('phone', payload.callControlId, runToken)
      return payload.callControlId
    } catch (error) {
      const staleRun = runToken !== runTokenRef.current
      const orphanedSession = stopLocal()
      if (orphanedSession.id) {
        await endBackendSessionTracked(orphanedSession).catch(() => undefined)
      }
      if (!staleRun) {
        setStartedAt('')
        setStatus(error instanceof Error ? error.message : 'Phone test failed to start')
      }
      return null
    } finally {
      if (pendingStartRequestRef.current?.id === startRequestId) {
        pendingStartRequestRef.current = null
      }
      startRequestPendingRef.current = false
      clearEndingIfSettled()
    }
  }, [clearEndingIfSettled, endBackendSessionTracked, openEventStream, stopLocal])

  const sendMessage = useCallback(async (message: string) => {
    const text = message.trim()
    if (!text || messageSending) return

    setMessageSending(true)
    try {
      let targetSessionId = sessionIdRef.current || sessionId
      let targetMode = modeRef.current
      if (!targetSessionId) {
        setStatus('Starting playground chat...')
        targetSessionId = (await start({ microphone: false })) || ''
        targetMode = 'browser'
      }
      if (!targetSessionId) throw new Error('Playground session failed to start')

      let lastError: Error | null = null
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const phone = targetMode === 'phone'
        const response = await fetch(
          apiUrl(
            phone
              ? `/calls/${encodeURIComponent(targetSessionId)}/instructions`
              : `/config-tests/${encodeURIComponent(targetSessionId)}/message`,
          ),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              phone
                ? { chatId: activeCallRef.current?.chatId, instruction: text }
                : { text },
            ),
          },
        )
        const payload = await response.json().catch(() => ({}))
        if (response.ok) {
          setStatus(phone ? 'Text whisper delivered privately to the agent' : 'Playground message sent')
          return
        }
        lastError = new Error(
          payload.error || (phone ? 'Live instruction failed' : 'Playground message failed'),
        )
        if (response.status !== 409) break
        await wait(250)
      }
      throw lastError || new Error('Playground message failed')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Playground message failed')
    } finally {
      setMessageSending(false)
    }
  }, [messageSending, sessionId, start])

  const end = useCallback(async () => {
    const hadPendingStart = startRequestPendingRef.current
    beginEnding()
    const stopped = stopLocal(
      modeRef.current === 'phone' ? 'Ending phone test...' : 'Ending Playground test...',
    )
    if (!stopped.id) {
      if (hadPendingStart) {
        setStatus(stopped.mode === 'phone' ? 'Phone test ended' : 'Playground test ended')
      } else if (!startRequestPendingRef.current) {
        setStatus(stopped.mode === 'phone' ? 'Phone test idle' : 'Test idle')
      }
      clearEndingIfSettled()
      return
    }
    try {
      await endBackendSessionTracked(stopped)
      setStatus(stopped.mode === 'phone' ? 'Phone test ended' : 'Playground test ended')
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : stopped.mode === 'phone'
            ? 'Phone test end failed'
            : 'Playground test end failed',
      )
    } finally {
      if (stopped.mode === 'phone') onPhoneEndedRef.current?.()
    }
  }, [beginEnding, clearEndingIfSettled, endBackendSessionTracked, stopLocal])

  return {
    activeCall,
    activeCallRef,
    attemptId,
    end,
    ending,
    leadLabel,
    messageSending,
    mode,
    reset,
    running,
    sendMessage,
    sessionId,
    setActiveCall,
    setStatus,
    start,
    startPhone,
    startedAt,
    starting,
    status,
    transcript,
  }
}

function playgroundRecorderProcessorSource() {
  return `
    class SpeakPlaygroundRecorder extends AudioWorkletProcessor {
      constructor(options) {
        super();
        const frameDurationMs = Math.max(
          1,
          Number(options.processorOptions && options.processorOptions.frameDurationMs) || 20,
        );
        this.frameSampleCount = Math.max(
          1,
          Math.round(sampleRate * frameDurationMs / 1000),
        );
        this.frame = new Float32Array(this.frameSampleCount);
        this.frameOffset = 0;
      }
      process(inputs, outputs) {
        const input = inputs[0] && inputs[0][0];
        if (input && input.length) {
          let inputOffset = 0;
          while (inputOffset < input.length) {
            const count = Math.min(
              input.length - inputOffset,
              this.frameSampleCount - this.frameOffset,
            );
            this.frame.set(
              input.subarray(inputOffset, inputOffset + count),
              this.frameOffset,
            );
            inputOffset += count;
            this.frameOffset += count;
            if (this.frameOffset >= this.frameSampleCount) {
              this.port.postMessage(this.frame, [this.frame.buffer]);
              this.frame = new Float32Array(this.frameSampleCount);
              this.frameOffset = 0;
            }
          }
        }
        if (outputs[0] && outputs[0][0]) outputs[0][0].fill(0);
        return true;
      }
    }
    registerProcessor('${PLAYGROUND_CAPTURE_PROCESSOR}', SpeakPlaygroundRecorder);
  `
}
