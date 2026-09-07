import { useCallback, useEffect, useRef, useState } from 'react'
import { makePlaygroundSupervisionSocketUrl } from './api'
import {
  startBrowserPcmCapture,
  type BrowserPcmCapture,
} from './browserMicrophone'
import type { ActiveCall } from './types'

type MonitorSource = 'agent' | 'contact'
type WhisperState = 'idle' | 'starting' | 'recording' | 'processing'

interface UsePlaygroundCallSupervisionOptions {
  activeCall: ActiveCall | null
  enabled: boolean
  setNotice: (message: string) => void
}

const AUDIO_WHISPER_SAMPLE_RATE = 16_000
const SPY_ACK_TIMEOUT_MS = 2_000

export function usePlaygroundCallSupervision({
  activeCall,
  enabled,
  setNotice,
}: UsePlaygroundCallSupervisionOptions) {
  const socketRef = useRef<WebSocket | null>(null)
  const activeCallRef = useRef(activeCall)
  const readyRef = useRef(false)
  const audioWhisperAvailableRef = useRef(false)
  const spyRequestedRef = useRef(false)
  const spyAckRef = useRef<{
    resolve: (enabled: boolean) => void
    timer: number
  } | null>(null)
  const playbackContextRef = useRef<AudioContext | null>(null)
  const playbackCursorsRef = useRef<Record<MonitorSource, number>>({
    agent: 0,
    contact: 0,
  })
  const playbackSourcesRef = useRef<Record<MonitorSource, Set<AudioBufferSourceNode>>>(
    {
      agent: new Set(),
      contact: new Set(),
    },
  )
  const whisperCaptureRef = useRef<BrowserPcmCapture | null>(null)
  const whisperAttemptRef = useRef(0)
  const whisperSendingRef = useRef(false)
  const whisperStateRef = useRef<WhisperState>('idle')
  const [connected, setConnected] = useState(false)
  const [audioWhisperAvailable, setAudioWhisperAvailable] = useState(false)
  const [spyEnabled, setSpyEnabled] = useState(false)
  const [spyBusy, setSpyBusy] = useState(false)
  const [whisperState, setWhisperStateValue] = useState<WhisperState>('idle')

  useEffect(() => {
    activeCallRef.current = activeCall
  }, [activeCall])

  const setWhisperState = useCallback((state: WhisperState) => {
    whisperStateRef.current = state
    setWhisperStateValue(state)
  }, [])

  const resolveSpyAck = useCallback((enabledValue: boolean) => {
    const pending = spyAckRef.current
    if (!pending) return
    window.clearTimeout(pending.timer)
    spyAckRef.current = null
    pending.resolve(enabledValue)
  }, [])

  const stopWhisperCapture = useCallback(() => {
    whisperAttemptRef.current += 1
    whisperSendingRef.current = false
    whisperCaptureRef.current?.stop()
    whisperCaptureRef.current = null
  }, [])

  const clearPlayback = useCallback((source?: MonitorSource) => {
    const sources: MonitorSource[] = source ? [source] : ['agent', 'contact']
    for (const key of sources) {
      for (const audioSource of playbackSourcesRef.current[key]) {
        try {
          audioSource.stop()
        } catch {
          // The source may have completed between the clear event and cleanup.
        }
        audioSource.disconnect()
      }
      playbackSourcesRef.current[key].clear()
      playbackCursorsRef.current[key] = playbackContextRef.current?.currentTime || 0
    }
  }, [])

  const closePlayback = useCallback(() => {
    clearPlayback()
    void playbackContextRef.current?.close()
    playbackContextRef.current = null
    playbackCursorsRef.current = { agent: 0, contact: 0 }
  }, [clearPlayback])

  const ensurePlaybackContext = useCallback(async () => {
    let context = playbackContextRef.current
    if (!context || context.state === 'closed') {
      context = new AudioContext()
      playbackContextRef.current = context
    }
    if (context.state !== 'running') await context.resume()
    return context
  }, [])

  const playMonitorAudio = useCallback(async (
    source: MonitorSource,
    encodedPcm: string,
    sampleRate: number,
  ) => {
    if (!spyRequestedRef.current || !encodedPcm) return
    const context = await ensurePlaybackContext()
    const bytes = base64Bytes(encodedPcm)
    const sampleCount = Math.floor(bytes.length / 2)
    if (!sampleCount) return
    const audioBuffer = context.createBuffer(
      1,
      sampleCount,
      Math.max(8_000, Number(sampleRate) || AUDIO_WHISPER_SAMPLE_RATE),
    )
    const channel = audioBuffer.getChannelData(0)
    const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2)
    for (let index = 0; index < sampleCount; index += 1) {
      channel[index] = view.getInt16(index * 2, true) / 0x8000
    }

    const node = context.createBufferSource()
    node.buffer = audioBuffer
    node.connect(context.destination)
    const now = context.currentTime
    let startAt = Math.max(now + 0.025, playbackCursorsRef.current[source])
    if (startAt > now + 0.75) startAt = now + 0.025
    playbackCursorsRef.current[source] = startAt + audioBuffer.duration
    playbackSourcesRef.current[source].add(node)
    node.onended = () => {
      playbackSourcesRef.current[source].delete(node)
      node.disconnect()
    }
    node.start(startAt)
  }, [ensurePlaybackContext])

  const handleSocketMessage = useCallback((raw: unknown, socket: WebSocket) => {
    let message: {
      audioWhisperAvailable?: boolean
      data?: string
      enabled?: boolean
      error?: string
      maxWhisperMs?: number
      operation?: string
      reason?: string
      sampleRate?: number
      source?: MonitorSource
      transcript?: string
      type?: string
    }
    try {
      message = JSON.parse(String(raw || ''))
    } catch {
      return
    }
    if (socketRef.current !== socket) return

    if (message.type === 'ready') {
      readyRef.current = true
      audioWhisperAvailableRef.current = Boolean(message.audioWhisperAvailable)
      setConnected(true)
      setAudioWhisperAvailable(Boolean(message.audioWhisperAvailable))
      if (spyRequestedRef.current && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'monitor.set', enabled: true }))
      }
      return
    }
    if (message.type === 'monitor.updated') {
      const nextEnabled = Boolean(message.enabled)
      setSpyEnabled(nextEnabled)
      setSpyBusy(false)
      resolveSpyAck(nextEnabled)
      if (!nextEnabled) clearPlayback()
      return
    }
    if (
      message.type === 'audio' &&
      message.data &&
      (message.source === 'contact' || message.source === 'agent')
    ) {
      void playMonitorAudio(
        message.source,
        message.data,
        Number(message.sampleRate || AUDIO_WHISPER_SAMPLE_RATE),
      )
      return
    }
    if (
      message.type === 'audio.clear' &&
      (message.source === 'contact' || message.source === 'agent')
    ) {
      clearPlayback(message.source)
      return
    }
    if (message.type === 'whisper.ready') {
      whisperSendingRef.current = true
      setWhisperState('recording')
      setNotice('Audio Whisper listening — only the agent will receive it')
      return
    }
    if (message.type === 'whisper.limit') {
      stopWhisperCapture()
      setWhisperState('processing')
      setNotice('Audio Whisper time limit reached; transcribing…')
      return
    }
    if (message.type === 'whisper.processing') {
      setWhisperState('processing')
      return
    }
    if (message.type === 'whisper.delivered') {
      stopWhisperCapture()
      setWhisperState('idle')
      setNotice('Voice whisper delivered privately to the agent')
      return
    }
    if (message.type === 'whisper.cancelled') {
      stopWhisperCapture()
      setWhisperState('idle')
      setNotice('Audio Whisper cancelled')
      return
    }
    if (message.type === 'error') {
      if (message.operation === 'monitor') {
        spyRequestedRef.current = false
        setSpyEnabled(false)
        setSpyBusy(false)
        resolveSpyAck(false)
        clearPlayback()
      }
      if (message.operation === 'whisper') {
        stopWhisperCapture()
        setWhisperState('idle')
      }
      setNotice(message.error || 'Phone supervision failed')
    }
  }, [
    clearPlayback,
    playMonitorAudio,
    resolveSpyAck,
    setNotice,
    setWhisperState,
    stopWhisperCapture,
  ])

  const callControlId = enabled ? activeCall?.callControlId || '' : ''
  const supervisionToken = enabled
    ? activeCall?.playgroundSupervisionToken || ''
    : ''
  const mediaReady = Boolean(
    callControlId && supervisionToken && activeCall?.chatId && activeCall?.streamId,
  )

  useEffect(() => {
    let disposed = false
    let reconnectTimer = 0

    readyRef.current = false
    resolveSpyAck(false)
    stopWhisperCapture()
    window.queueMicrotask(() => {
      if (disposed) return
      setConnected(false)
      setAudioWhisperAvailable(false)
      setSpyEnabled(false)
      setSpyBusy(false)
      setWhisperState('idle')
    })

    if (!mediaReady) return

    const connect = () => {
      if (disposed) return
      const socket = new WebSocket(
        makePlaygroundSupervisionSocketUrl(callControlId, supervisionToken),
      )
      socketRef.current = socket
      socket.onmessage = (event) => handleSocketMessage(event.data, socket)
      socket.onclose = () => {
        if (socketRef.current !== socket) return
        readyRef.current = false
        audioWhisperAvailableRef.current = false
        setConnected(false)
        setAudioWhisperAvailable(false)
        setSpyEnabled(false)
        setSpyBusy(false)
        resolveSpyAck(false)
        const hadWhisper = whisperStateRef.current !== 'idle'
        stopWhisperCapture()
        setWhisperState('idle')
        if (!disposed) {
          if (hadWhisper) setNotice('Audio Whisper disconnected before delivery')
          reconnectTimer = window.setTimeout(connect, 1_000)
        }
      }
      socket.onerror = () => {
        // The close handler owns reconnect and user-visible state.
      }
    }

    connect()
    return () => {
      disposed = true
      window.clearTimeout(reconnectTimer)
      spyRequestedRef.current = false
      resolveSpyAck(false)
      stopWhisperCapture()
      closePlayback()
      if (socketRef.current) {
        socketRef.current.onclose = null
        socketRef.current.close()
        socketRef.current = null
      }
      readyRef.current = false
      audioWhisperAvailableRef.current = false
    }
  }, [
    callControlId,
    closePlayback,
    handleSocketMessage,
    mediaReady,
    resolveSpyAck,
    setNotice,
    setWhisperState,
    stopWhisperCapture,
    supervisionToken,
  ])

  const setSpy = useCallback(async (nextEnabled: boolean) => {
    const socket = socketRef.current
    if (!readyRef.current || socket?.readyState !== WebSocket.OPEN) {
      setNotice('Phone supervision is still connecting')
      return false
    }
    if (nextEnabled) {
      try {
        await ensurePlaybackContext()
      } catch {
        setNotice('Browser audio could not start')
        return false
      }
    }
    spyRequestedRef.current = nextEnabled
    setSpyBusy(true)
    const acknowledged = new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => {
        if (spyAckRef.current?.resolve !== resolve) return
        spyAckRef.current = null
        setSpyBusy(false)
        resolve(false)
      }, SPY_ACK_TIMEOUT_MS)
      spyAckRef.current = { resolve, timer }
    })
    socket.send(JSON.stringify({ type: 'monitor.set', enabled: nextEnabled }))
    const result = await acknowledged
    if (!result && nextEnabled) {
      spyRequestedRef.current = false
      setNotice('Spy audio did not attach')
    }
    if (!nextEnabled) clearPlayback()
    return nextEnabled ? result : !result
  }, [clearPlayback, ensurePlaybackContext, setNotice])

  const toggleSpy = useCallback(async () => {
    await setSpy(!spyRequestedRef.current)
  }, [setSpy])

  const ensureSpy = useCallback(async () => {
    if (spyEnabled && spyRequestedRef.current) return true
    return setSpy(true)
  }, [setSpy, spyEnabled])

  const startAudioWhisper = useCallback(async () => {
    const socket = socketRef.current
    if (
      !readyRef.current ||
      socket?.readyState !== WebSocket.OPEN ||
      !audioWhisperAvailableRef.current
    ) {
      setNotice(
        audioWhisperAvailableRef.current
          ? 'Phone supervision is still connecting'
          : 'Audio Whisper transcription is not configured',
      )
      return
    }
    if (activeCallRef.current?.takeover) {
      setNotice('Release Barge before coaching the agent')
      return
    }
    if (whisperStateRef.current !== 'idle') return

    setWhisperState('starting')
    const whisperAttempt = whisperAttemptRef.current + 1
    whisperAttemptRef.current = whisperAttempt
    setNotice('Starting Audio Whisper microphone…')
    try {
      const capture = await startBrowserPcmCapture({
        targetSampleRate: AUDIO_WHISPER_SAMPLE_RATE,
        onFrame: (frame) => {
          const currentSocket = socketRef.current
          if (
            whisperSendingRef.current &&
            currentSocket?.readyState === WebSocket.OPEN
          ) {
            currentSocket.send(frame)
          }
        },
      })
      if (
        whisperAttemptRef.current !== whisperAttempt ||
        socketRef.current !== socket ||
        socket.readyState !== WebSocket.OPEN
      ) {
        capture.stop()
        setWhisperState('idle')
        return
      }
      whisperCaptureRef.current = capture
      socket.send(
        JSON.stringify({
          type: 'whisper.start',
          sampleRate: AUDIO_WHISPER_SAMPLE_RATE,
        }),
      )
    } catch (error) {
      stopWhisperCapture()
      setWhisperState('idle')
      setNotice(
        error instanceof Error ? error.message : 'Audio Whisper microphone failed',
      )
    }
  }, [setNotice, setWhisperState, stopWhisperCapture])

  const stopAudioWhisper = useCallback(() => {
    if (whisperStateRef.current !== 'recording') return
    stopWhisperCapture()
    setWhisperState('processing')
    setNotice('Transcribing private voice whisper…')
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'whisper.stop' }))
    } else {
      setWhisperState('idle')
      setNotice('Audio Whisper disconnected before delivery')
    }
  }, [setNotice, setWhisperState, stopWhisperCapture])

  const toggleAudioWhisper = useCallback(() => {
    if (whisperStateRef.current === 'recording') {
      stopAudioWhisper()
    } else if (whisperStateRef.current === 'idle') {
      void startAudioWhisper()
    }
  }, [startAudioWhisper, stopAudioWhisper])

  const cancelAudioWhisper = useCallback(() => {
    if (whisperStateRef.current === 'idle') return
    stopWhisperCapture()
    setWhisperState('idle')
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'whisper.cancel' }))
    }
  }, [setWhisperState, stopWhisperCapture])

  return {
    audioWhisperAvailable,
    cancelAudioWhisper,
    connected,
    ensureSpy,
    spyBusy,
    spyEnabled,
    toggleAudioWhisper,
    toggleSpy,
    whisperState,
  }
}

function base64Bytes(encoded: string) {
  const binary = window.atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}
