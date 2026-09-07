import { useCallback, useEffect, useRef, useState } from 'react'
import { apiUrl } from './api'
import { recentLeadName } from './calls'
import type { CallAudioMetadata, RecentCallSummary } from './calls'

export type AudioPlaybackStatusName =
  | 'checking'
  | 'preparing'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'retry'
  | 'error'

export interface AudioPlaybackStatus {
  status: AudioPlaybackStatusName
  message: string
  providerStatus?: string | null
}

interface UseCallAudioPlaybackOptions {
  refreshRecentCalls: (options?: { recoverCampaign?: boolean }) => Promise<RecentCallSummary[]>
  setNotice: (message: string) => void
}

export function useCallAudioPlayback({
  refreshRecentCalls,
  setNotice,
}: UseCallAudioPlaybackOptions) {
  const audioPlaybackRef = useRef<HTMLAudioElement | null>(null)
  const audioPollTimersRef = useRef<Record<string, number>>({})
  const audioPollAttemptsRef = useRef<Record<string, number>>({})
  const [playingAudioCallId, setPlayingAudioCallId] = useState<string | null>(null)
  const [pausedAudioCallId, setPausedAudioCallId] = useState<string | null>(null)
  const [loadingAudioCallId, setLoadingAudioCallId] = useState<string | null>(null)
  const [resolvedAudioLinks, setResolvedAudioLinks] = useState<
    Record<string, CallAudioMetadata>
  >({})
  const [audioStatusByCallId, setAudioStatusByCallId] = useState<
    Record<string, AudioPlaybackStatus>
  >({})

  const clearAudioPoll = useCallback((callControlId: string) => {
    const timer = audioPollTimersRef.current[callControlId]
    if (timer) {
      window.clearTimeout(timer)
      delete audioPollTimersRef.current[callControlId]
    }
  }, [])

  const stopCurrentCallAudio = useCallback(() => {
    const audio = audioPlaybackRef.current
    if (!audio) return

    audio.onended = null
    audio.onerror = null
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    audioPlaybackRef.current = null
  }, [])

  useEffect(
    () => () => {
      stopCurrentCallAudio()
      Object.values(audioPollTimersRef.current).forEach((timer) =>
        window.clearTimeout(timer),
      )
      audioPollTimersRef.current = {}
    },
    [stopCurrentCallAudio],
  )

  const updateAudioStatus = useCallback(
    (callControlId: string, status: AudioPlaybackStatus | null) => {
      setAudioStatusByCallId((current) => {
        if (!status) {
          const next = { ...current }
          delete next[callControlId]
          return next
        }

        const existing = current[callControlId]
        if (
          existing?.status === status.status &&
          existing.message === status.message &&
          existing.providerStatus === status.providerStatus
        ) {
          return current
        }

        return {
          ...current,
          [callControlId]: status,
        }
      })
    },
    [],
  )

  const audioPlaybackStateFor = useCallback(
    (call?: RecentCallSummary | null): AudioPlaybackStatus | null => {
      if (!call) return null
      if (playingAudioCallId === call.callControlId) {
        return { status: 'playing', message: 'Pause call audio' }
      }

      if (pausedAudioCallId === call.callControlId) {
        return { status: 'paused', message: 'Resume call audio' }
      }

      const tracked = audioStatusByCallId[call.callControlId]
      if (tracked) return tracked

      if (loadingAudioCallId === call.callControlId) {
        return { status: 'checking', message: 'Checking call audio' }
      }

      const cached = resolvedAudioLinks[call.callControlId] || call.audio
      if (
        cached?.status === 'ready' &&
        (cached.url || resolvedAudioLinks[call.callControlId]?.url)
      ) {
        return {
          status: 'ready',
          message: 'Ready to play',
          providerStatus: cached.providerStatus,
        }
      }

      return null
    },
    [
      audioStatusByCallId,
      loadingAudioCallId,
      pausedAudioCallId,
      playingAudioCallId,
      resolvedAudioLinks,
    ],
  )

  async function resolveCallAudioLink(
    call: RecentCallSummary,
    options: { fromPoll?: boolean } = {},
  ): Promise<CallAudioMetadata | null> {
    const { callControlId } = call
    if (!options.fromPoll) {
      clearAudioPoll(callControlId)
      audioPollAttemptsRef.current[callControlId] = 0
    }

    setLoadingAudioCallId(callControlId)
    updateAudioStatus(callControlId, {
      status: options.fromPoll ? 'preparing' : 'checking',
      message: options.fromPoll ? 'Still preparing audio' : 'Checking call audio',
    })

    try {
      const response = await fetch(
        apiUrl(`/calls/${encodeURIComponent(callControlId)}/audio-link`),
      )
      const payload = (await response.json()) as CallAudioMetadata & {
        error?: string
      }

      if (!response.ok && response.status !== 202) {
        throw new Error(payload.error || 'Call audio is not available')
      }

      if (payload.status === 'ready' && payload.url) {
        clearAudioPoll(callControlId)
        setResolvedAudioLinks((current) => ({
          ...current,
          [callControlId]: payload,
        }))
        updateAudioStatus(callControlId, {
          status: 'ready',
          message: 'Ready to play',
          providerStatus: payload.providerStatus,
        })
        setNotice(`Call audio is ready for ${recentLeadName(call)}.`)
        void refreshRecentCalls({ recoverCampaign: false })
        return payload
      }

      const providerStatus = payload.providerStatus || payload.status || null
      updateAudioStatus(callControlId, {
        status: 'preparing',
        message: payload.message || 'Speak is preparing call audio.',
        providerStatus,
      })
      setNotice(payload.message || 'Speak is preparing call audio.')
      const attempts = (audioPollAttemptsRef.current[callControlId] || 0) + 1
      audioPollAttemptsRef.current[callControlId] = attempts

      if (attempts > 60) {
        updateAudioStatus(callControlId, {
          status: 'retry',
          message: 'Audio is still preparing. Click play to check again.',
        })
        setNotice('Call audio is still preparing. Click play again in a minute.')
      } else {
        clearAudioPoll(callControlId)
        audioPollTimersRef.current[callControlId] = window.setTimeout(() => {
          delete audioPollTimersRef.current[callControlId]
          void resolveCallAudioLink(call, { fromPoll: true })
        }, 5000)
      }
      void refreshRecentCalls({ recoverCampaign: false })
      return payload
    } catch (error) {
      clearAudioPoll(callControlId)
      const message =
        error instanceof Error ? error.message : 'Call audio playback failed'
      updateAudioStatus(callControlId, {
        status: 'error',
        message,
      })
      setNotice(message)
      return null
    } finally {
      setLoadingAudioCallId((current) =>
        current === callControlId ? null : current,
      )
    }
  }

  async function playCallAudioUrl(call: RecentCallSummary, audioUrl: string) {
    if (playingAudioCallId && playingAudioCallId !== call.callControlId) {
      updateAudioStatus(playingAudioCallId, {
        status: 'ready',
        message: 'Ready to play',
      })
    }

    stopCurrentCallAudio()
    setPausedAudioCallId(null)
    const audio = new Audio(audioUrl)
    audioPlaybackRef.current = audio
    audio.onended = () => {
      setPlayingAudioCallId((current) =>
        current === call.callControlId ? null : current,
      )
      setPausedAudioCallId((current) =>
        current === call.callControlId ? null : current,
      )
      updateAudioStatus(call.callControlId, {
        status: 'ready',
        message: 'Ready to replay',
      })
    }
    audio.onerror = () => {
      setPlayingAudioCallId((current) =>
        current === call.callControlId ? null : current,
      )
      setPausedAudioCallId((current) =>
        current === call.callControlId ? null : current,
      )
      updateAudioStatus(call.callControlId, {
        status: 'retry',
        message: 'Playback failed. Click to retry.',
      })
      setNotice('Call audio playback failed')
    }

    const playPromise = audio.play()
    setPlayingAudioCallId(call.callControlId)
    updateAudioStatus(call.callControlId, {
      status: 'playing',
      message: 'Playing call audio',
    })
    setNotice(`Playing call audio for ${recentLeadName(call)}`)

    try {
      await playPromise
    } catch {
      setPlayingAudioCallId((current) =>
        current === call.callControlId ? null : current,
      )
      setPausedAudioCallId((current) =>
        current === call.callControlId ? null : current,
      )
      updateAudioStatus(call.callControlId, {
        status: 'retry',
        message: 'Browser blocked playback. Click again.',
      })
      setNotice('Browser blocked playback. Click the play button again.')
    }
  }

  async function toggleCallAudioPlayback(call: RecentCallSummary) {
    if (playingAudioCallId === call.callControlId) {
      const audio = audioPlaybackRef.current
      audio?.pause()
      setPlayingAudioCallId(null)
      setPausedAudioCallId(call.callControlId)
      updateAudioStatus(call.callControlId, {
        status: 'paused',
        message: 'Resume call audio',
      })
      setNotice('Call audio paused')
      return
    }

    if (pausedAudioCallId === call.callControlId && audioPlaybackRef.current) {
      try {
        await audioPlaybackRef.current.play()
        setPausedAudioCallId(null)
        setPlayingAudioCallId(call.callControlId)
        updateAudioStatus(call.callControlId, {
          status: 'playing',
          message: 'Pause call audio',
        })
        setNotice(`Playing call audio for ${recentLeadName(call)}`)
      } catch {
        updateAudioStatus(call.callControlId, {
          status: 'retry',
          message: 'Browser blocked playback. Click again.',
        })
        setNotice('Browser blocked playback. Click the play button again.')
      }
      return
    }

    const directAudioUrl =
      call.audio?.status === 'ready' && call.audio.url
        ? call.audio.url
        : resolvedAudioLinks[call.callControlId]?.url
    if (directAudioUrl) {
      await playCallAudioUrl(call, directAudioUrl)
      return
    }

    await resolveCallAudioLink(call)
  }

  return {
    audioPlaybackStateFor,
    loadingAudioCallId,
    playingAudioCallId,
    toggleCallAudioPlayback,
  }
}
