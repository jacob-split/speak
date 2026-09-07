import { useCallback, useEffect, useRef, useState } from 'react'
import { apiUrl } from './api'
import type { PhoneProviderOption } from './types'

export interface PhoneProviderOptionsState {
  configured: boolean
  defaultNumber?: PhoneProviderOption | null
  numbers: PhoneProviderOption[]
  proof?: {
    readError?: string
    source?: string
  }
}

const emptyPhoneProviderOptions: PhoneProviderOptionsState = {
  configured: false,
  defaultNumber: null,
  numbers: [],
}

export function usePhoneProviderOptions(enabled: boolean) {
  const requestRef = useRef<AbortController | null>(null)
  const [options, setOptions] = useState<PhoneProviderOptionsState>(
    emptyPhoneProviderOptions,
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    const controller = new AbortController()
    requestRef.current?.abort()
    requestRef.current = controller
    setLoading(true)
    setError('')
    try {
      const response = await fetch(apiUrl('/phone-provider/options'), {
        cache: 'no-store',
        signal: controller.signal,
      })
      const payload = (await response.json().catch(() => ({}))) as
        Partial<PhoneProviderOptionsState> & { error?: string }
      if (!response.ok) {
        throw new Error(payload.error || 'Phone provider options failed')
      }
      if (requestRef.current !== controller) return
      setOptions({
        ...emptyPhoneProviderOptions,
        ...payload,
        numbers: Array.isArray(payload.numbers) ? payload.numbers : [],
      })
      setError(payload.proof?.readError || '')
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return
      if (requestRef.current !== controller) return
      setOptions(emptyPhoneProviderOptions)
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Phone provider options failed',
      )
    } finally {
      if (requestRef.current === controller) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    void Promise.resolve().then(refresh)
    return () => requestRef.current?.abort()
  }, [enabled, refresh])

  return {
    error,
    loading,
    options,
    refresh,
  }
}
