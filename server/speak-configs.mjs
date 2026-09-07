import {
  HumeConfigSyncError,
  readHumeAgentConfig,
  readHumeConfigOptions,
  syncHumeAgentConfig,
} from './hume-configs.mjs'
import {
  InworldConfigSyncError,
  readInworldAgentConfig,
  readInworldConfigOptions,
  syncInworldAgentConfig,
} from './inworld-configs.mjs'
import {
  XaiConfigSyncError,
  readXaiAgentConfig,
  readXaiConfigOptions,
  syncXaiAgentConfig,
} from './xai-configs.mjs'
import { isInworldRuntime, isXaiRuntime } from './runtime-config.mjs'

export {
  HumeConfigSyncError,
  InworldConfigSyncError,
  XaiConfigSyncError,
  readHumeAgentConfig,
  readHumeConfigOptions,
  readInworldAgentConfig,
  readInworldConfigOptions,
  readXaiAgentConfig,
  readXaiConfigOptions,
  syncHumeAgentConfig,
  syncInworldAgentConfig,
  syncXaiAgentConfig,
}

export async function readSpeakAgentConfig(configId) {
  if (isXaiConfigId(configId)) {
    return readXaiAgentConfig(configId)
  }
  if (isInworldConfigId(configId)) {
    return readInworldAgentConfig(configId)
  }
  return readHumeAgentConfig(configId)
}

export async function readSpeakConfigOptions() {
  const [humeResult, inworldResult, xaiResult] = await Promise.allSettled([
    readHumeConfigOptions(),
    readInworldConfigOptions(),
    readXaiConfigOptions(),
  ])

  if (
    humeResult.status === 'rejected' &&
    inworldResult.status === 'rejected' &&
    xaiResult.status === 'rejected'
  ) {
    throw humeResult.reason || inworldResult.reason || xaiResult.reason
  }

  const hume = humeResult.status === 'fulfilled' ? humeResult.value : emptyOptions()
  const inworld =
    inworldResult.status === 'fulfilled' ? inworldResult.value : emptyOptions()
  const xai = xaiResult.status === 'fulfilled' ? xaiResult.value : emptyOptions()
  const providerErrors = {
    ...(humeResult.status === 'rejected'
      ? { hume: { message: 'Hume provider options could not be refreshed.' } }
      : {}),
    ...(inworldResult.status === 'rejected'
      ? { inworld: { message: 'Inworld provider options could not be refreshed.' } }
      : {}),
    ...(xaiResult.status === 'rejected'
      ? { xai: { message: 'xAI provider options could not be refreshed.' } }
      : {}),
  }

  return {
    eviVersions: [...(hume.eviVersions || []), ...(inworld.eviVersions || []), ...(xai.eviVersions || [])],
    codexAuthModels: [...(hume.codexAuthModels || []), ...(inworld.codexAuthModels || []), ...(xai.codexAuthModels || [])],
    languageModels: [...(hume.languageModels || []), ...(inworld.languageModels || []), ...(xai.languageModels || [])],
    voices: [...(hume.voices || []), ...(inworld.voices || []), ...(xai.voices || [])],
    functionTools: hume.functionTools?.length
      ? hume.functionTools
      : inworld.functionTools || [],
    providerErrors,
  }
}

export async function syncSpeakAgentConfig(options) {
  if (isXaiRuntime(options?.config || {})) {
    return syncXaiAgentConfig(options)
  }
  if (isInworldRuntime(options?.config || {})) {
    return syncInworldAgentConfig(options)
  }
  return syncHumeAgentConfig(options)
}

export function isVoiceConfigSyncError(error) {
  return (
    error instanceof HumeConfigSyncError ||
    error instanceof InworldConfigSyncError ||
    error instanceof XaiConfigSyncError
  )
}

function isXaiConfigId(configId) {
  const id = String(configId || '').trim().toLowerCase()
  return id === 'xai-realtime' || id.startsWith('xai-')
}

function isInworldConfigId(configId) {
  const id = String(configId || '').trim().toLowerCase()
  return id === 'inworld-realtime' || id.startsWith('inworld-')
}

function emptyOptions() {
  return {
    eviVersions: [],
    codexAuthModels: [],
    languageModels: [],
    voices: [],
    functionTools: [],
  }
}
