import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
} from 'react'
import {
  apiUrl,
  makeHumanAudioSocketUrl,
} from './api'
import {
  startBrowserPcmCapture,
  type BrowserPcmCapture,
} from './browserMicrophone'
import { isActiveCallLive } from './calls'
import type { ActiveCall, Lead } from './types'

type HumanTakeoverBusy = 'idle' | 'takeover' | 'release'

interface UseHumanTakeoverOptions {
  activeCall: ActiveCall | null
  activeCallRef: MutableRefObject<ActiveCall | null>
  activeLead: Lead | null
  controlsLocked: boolean
  sampleRate: number
  setActiveCall: Dispatch<SetStateAction<ActiveCall | null>>
  setBusy: (busy: HumanTakeoverBusy) => void
  setNotice: (message: string) => void
  updateLead: (id: string, patch: Partial<Lead>) => void
}

export function useHumanTakeover({
  activeCall,
  activeCallRef,
  activeLead,
  controlsLocked,
  sampleRate,
  setActiveCall,
  setBusy,
  setNotice,
  updateLead,
}: UseHumanTakeoverOptions) {
  const humanAudioSocketRef = useRef<WebSocket | null>(null)
  const humanCaptureRef = useRef<BrowserPcmCapture | null>(null)

  const stopHumanAudioStream = useCallback(() => {
    humanCaptureRef.current?.stop()
    humanAudioSocketRef.current?.close()

    humanCaptureRef.current = null
    humanAudioSocketRef.current = null
  }, [])

  const startHumanAudioStream = useCallback(async (
    callControlId: string,
    playgroundSupervisionToken = '',
  ) => {
    const socket = new WebSocket(
      makeHumanAudioSocketUrl(callControlId, playgroundSupervisionToken),
    )
    socket.binaryType = 'arraybuffer'

    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error('Human audio bridge failed'))
    })

    try {
      const capture = await startBrowserPcmCapture({
        targetSampleRate: sampleRate,
        onFrame: (frame) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(frame)
        },
      })
      humanAudioSocketRef.current = socket
      humanCaptureRef.current = capture
    } catch (error) {
      socket.close()
      throw error
    }
  }, [sampleRate])

  const releaseTakeover = useCallback(async () => {
    if (!activeCall) return

    try {
      setBusy('release')
      const response = await fetch(apiUrl(`/calls/${activeCall.callControlId}/resume`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: activeCall.chatId }),
      })
      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.error || 'Resume failed')
      }

      stopHumanAudioStream()

      setActiveCall((current) => {
        if (!current) return current
        const next = { ...current, phase: 'live' as const, takeover: false }
        activeCallRef.current = next
        return next
      })
      setNotice('Assistant resumed')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Resume failed')
    } finally {
      setBusy('idle')
    }
  }, [
    activeCall,
    activeCallRef,
    setActiveCall,
    setBusy,
    setNotice,
    stopHumanAudioStream,
  ])

  const bargeIn = useCallback(async () => {
    if (controlsLocked) return
    if (!activeCall || !isActiveCallLive(activeCall)) return

    if (activeCall.takeover) {
      await releaseTakeover()
      return
    }

    try {
      setBusy('takeover')
      await startHumanAudioStream(
        activeCall.callControlId,
        activeCall.playgroundSupervisionToken,
      )
      const response = await fetch(apiUrl(`/calls/${activeCall.callControlId}/barge-in`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: activeCall.chatId }),
      })
      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.error || 'Barge-in failed')
      }

      setActiveCall((current) => {
        if (!current) return current
        const next = { ...current, phase: 'handoff' as const, takeover: true }
        activeCallRef.current = next
        return next
      })
      if (activeLead) {
        updateLead(activeLead.id, { status: 'follow-up' })
      }
      setNotice('Human takeover active')
    } catch (error) {
      void fetch(apiUrl(`/calls/${activeCall.callControlId}/resume`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: activeCall.chatId }),
        keepalive: true,
      }).catch(() => undefined)
      stopHumanAudioStream()
      setNotice(error instanceof Error ? error.message : 'Barge-in failed')
    } finally {
      setBusy('idle')
    }
  }, [
    activeCall,
    activeCallRef,
    activeLead,
    controlsLocked,
    releaseTakeover,
    setActiveCall,
    setBusy,
    setNotice,
    startHumanAudioStream,
    stopHumanAudioStream,
    updateLead,
  ])

  useEffect(() => stopHumanAudioStream, [stopHumanAudioStream])

  return {
    bargeIn,
    releaseTakeover,
    stopHumanAudioStream,
  }
}
