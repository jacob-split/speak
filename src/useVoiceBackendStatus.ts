import {
  useEffect,
  useState,
} from 'react'
import { apiUrl } from './api'
import { normalizeCampaignProfileConfig } from './agentConfigs'
import type {
  CampaignConfig,
  VoiceBackendStatus,
} from './types'

const initialVoiceBackendStatus: VoiceBackendStatus = {
  ok: false,
  configured: false,
  missing: [],
  message: 'Checking voice backend...',
}

interface UseVoiceBackendStatusOptions {
  setCampaignConfig: React.Dispatch<React.SetStateAction<CampaignConfig>>
  setNotice: React.Dispatch<React.SetStateAction<string>>
}

export function useVoiceBackendStatus({
  setCampaignConfig,
  setNotice,
}: UseVoiceBackendStatusOptions) {
  const [voiceBackend, setVoiceBackend] = useState<VoiceBackendStatus>(
    initialVoiceBackendStatus,
  )

  useEffect(() => {
    let mounted = true

    async function loadVoiceBackend() {
      try {
        const response = await fetch(apiUrl('/health'))
        if (!response.ok) {
          throw new Error(`Voice backend returned ${response.status}`)
        }
        const status = (await response.json()) as VoiceBackendStatus
        if (!mounted) return

        setVoiceBackend(status)
        if (status.defaults) {
          setCampaignConfig((current) => ({
            ...normalizeCampaignProfileConfig({
              ...current,
              ...status.defaults,
            }),
          }))
        }
        setNotice(status.configured ? 'Voice backend ready' : status.message)
      } catch {
        if (!mounted) return

        setVoiceBackend({
          ok: false,
          configured: false,
          missing: ['API server'],
          message: 'Voice backend unavailable',
        })
        setNotice('Voice backend unavailable')
      }
    }

    void loadVoiceBackend()

    return () => {
      mounted = false
    }
  }, [setCampaignConfig, setNotice])

  return voiceBackend
}
