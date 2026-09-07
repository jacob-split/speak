import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { codexAppServer } from './codex-app-server-client.mjs'
import {
  isVoiceConfigSyncError,
  readSpeakConfigOptions,
  syncSpeakAgentConfig,
} from './speak-configs.mjs'
import { isInworldRuntime } from './runtime-config.mjs'
import {
  listWorkspaceProfiles,
  normalizeWorkspaceProfile,
  replaceWorkspaceProfiles,
} from './workspace-store.mjs'

export const SMART_CONFIG_SCHEMA_VERSION = 'speak.smart-config.v1'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const workspaceDataDir = path.resolve(
  repoRoot,
  process.env.SPEAK_WORKSPACE_DATA_DIR || 'workspace-data',
)
const conversationIndexPath = path.join(
  workspaceDataDir,
  'smart-config-conversations.json',
)
const indexVersion = 1
let indexMutationQueue = Promise.resolve()
const activeSmartConfigTurns = new Map()
const DEFAULT_SMART_CONFIG_CODEX_MODEL = 'gpt-5.5'
const DEFAULT_SMART_CONFIG_CODEX_EFFORT = 'xhigh'
const DEFAULT_SMART_CONFIG_CODEX_SERVICE_TIER = 'priority'

const forbiddenConfigPatchKeys = new Set([
  'agentProfileId',
  'agentProfileName',
  'calltoolsAgentBinding',
  'dialerProvider',
  'humeConfigId',
  'humeConfigVersion',
  'humeConfigSyncedAt',
  'inworldConfigId',
  'inworldConfigVersion',
  'inworldConfigSyncedAt',
  'phoneCallerId',
  'phoneConnectionId',
  'sampleRate',
  'speakConfigId',
  'speakConfigVersion',
  'speakConfigSyncedAt',
  'telnyxCallerId',
  'telnyxConnectionId',
  'telnyxStreamCodec',
])

const promptConfigKeys = new Set(['instructions'])
const voiceConfigKeys = new Set([
  'voice',
  'humeVoiceName',
  'humeVoiceProvider',
  'inworldVoiceName',
  'inworldVoiceProvider',
])
const testVariableKeys = new Set([
  'first_name',
  'last_name',
  'full_name',
  'business_name',
  'contact_phone',
  'contact_email',
  'notes',
])

function cleanText(value) {
  return String(value || '').trim()
}

function smartConfigCodexModel() {
  return cleanText(process.env.SPEAK_SMART_CONFIG_CODEX_MODEL) ||
    DEFAULT_SMART_CONFIG_CODEX_MODEL
}

function smartConfigCodexEffort() {
  return cleanText(process.env.SPEAK_SMART_CONFIG_CODEX_EFFORT) ||
    cleanText(process.env.SPEAK_SMART_CONFIG_CODEX_REASONING) ||
    DEFAULT_SMART_CONFIG_CODEX_EFFORT
}

function smartConfigCodexServiceTier() {
  const configured =
    cleanText(process.env.SPEAK_SMART_CONFIG_CODEX_SERVICE_TIER) ||
    cleanText(process.env.SPEAK_SMART_CONFIG_CODEX_SPEED)
  if (/^(standard|default)$/i.test(configured)) return 'default'
  if (/^(fast|priority)$/i.test(configured)) return 'priority'
  return DEFAULT_SMART_CONFIG_CODEX_SERVICE_TIER
}

function smartConfigCodexSettings() {
  const serviceTier = smartConfigCodexServiceTier()
  const effort = smartConfigCodexEffort()
  return {
    model: smartConfigCodexModel(),
    serviceTier,
    effort,
    config: {
      model_reasoning_effort: effort,
      service_tier: serviceTier,
    },
  }
}

export async function listSmartConfigConversations({ profileId } = {}) {
  const index = await readConversationIndex()
  const conversations = index.conversations
    .filter((conversation) => !profileId || conversation.profileId === profileId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))

  return {
    schemaVersion: SMART_CONFIG_SCHEMA_VERSION,
    ok: true,
    conversations,
  }
}

export async function createSmartConfigConversation({
  profileId,
  profileName,
} = {}) {
  const profile = await resolveWorkspaceProfile(profileId)
  const conversation = normalizeConversation({
    id: `smart-config-${randomUUID()}`,
    profileId: profile.id,
    profileName: profileName || profile.name,
    title: smartConfigThreadTitle(profileName || profile.name),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  const index = await mutateConversationIndex((draft) => {
    draft.conversations = [
      conversation,
      ...draft.conversations.filter((item) => item.id !== conversation.id),
    ]
    return draft
  })

  return {
    schemaVersion: SMART_CONFIG_SCHEMA_VERSION,
    ok: true,
    conversation,
    conversations: publicConversations(index.conversations, profile.id),
  }
}

export async function readSmartConfigConversation({ conversationId } = {}) {
  const index = await readConversationIndex()
  const conversation = index.conversations.find(
    (item) => item.id === conversationId || item.threadId === conversationId,
  )

  if (!conversation) {
    return {
      schemaVersion: SMART_CONFIG_SCHEMA_VERSION,
      ok: false,
      error: 'smart_config_conversation_not_found',
      message: 'Smart Config conversation was not found.',
    }
  }

  const messages = conversation.threadId
    ? await readCodexConversationMessages(conversation.threadId)
    : []

  return {
    schemaVersion: SMART_CONFIG_SCHEMA_VERSION,
    ok: true,
    conversation,
    messages,
  }
}

export async function streamSmartConfigTurn({
  conversationId,
  expectedTurnId,
  message,
  profileId,
  response,
  steer = false,
} = {}) {
  prepareSse(response)

  const userMessage = String(message || '').trim()
  if (!userMessage) {
    writeSse(response, 'error', {
      error: 'smart_config_empty_message',
      message: 'A Smart Config message is required.',
    })
    writeSse(response, 'done', { ok: false })
    finishSse(response)
    return
  }

  let listener = null
  try {
    const profile = await resolveWorkspaceProfile(profileId)
    const conversation = await ensureSmartConfigConversation({
      conversationId,
      profile,
    })
    const thread = await ensureCodexThread({ conversation, profile })
    const updatedConversation = await updateConversation(conversation.id, {
      threadId: thread.threadId,
      title: thread.title,
      profileId: profile.id,
      profileName: profile.name,
      updatedAt: new Date().toISOString(),
    })

    writeSse(response, 'thread', {
      conversation: updatedConversation,
      threadId: thread.threadId,
      title: thread.title,
    })
    writeSse(response, 'user_message', {
      id: `smart-config-user-${Date.now()}`,
      role: 'user',
      content: userMessage,
      createdAt: new Date().toISOString(),
    })

    const activeTurn = activeSmartConfigTurns.get(thread.threadId)
    if (steer && activeTurn?.turnId) {
      const turnPrompt = await buildSmartConfigPrompt({
        profile,
        userMessage,
        steer: true,
      })
      await codexAppServer.request('turn/steer', {
        expectedTurnId: String(expectedTurnId || activeTurn.turnId),
        input: [
          {
            type: 'text',
            text: turnPrompt,
            text_elements: [],
          },
        ],
        threadId: thread.threadId,
      })
      await updateConversation(updatedConversation.id, {
        updatedAt: new Date().toISOString(),
      })
      writeSse(response, 'tool_progress', {
        label: 'Steered active Smart Config turn',
        status: 'completed',
      })
      writeSse(response, 'done', { ok: true, steered: true })
      return
    }

    const turnPrompt = await buildSmartConfigPrompt({ profile, userMessage })
    const streamState = createStreamState(response, thread.threadId)
    listener = codexAppServer.onNotification((messageEnvelope) => {
      handleCodexNotification(streamState, messageEnvelope)
    })

    const codexSettings = smartConfigCodexSettings()
    await codexAppServer.request('turn/start', {
      effort: codexSettings.effort,
      input: [
        {
          type: 'text',
          text: turnPrompt,
          text_elements: [],
        },
      ],
      model: codexSettings.model,
      serviceTier: codexSettings.serviceTier,
      threadId: thread.threadId,
    })

    const assistantText = await streamState.waitForCompletion()
    const patch = extractSmartConfigPatch(assistantText)
    const finalText = cleanSmartConfigPatchBlock(assistantText)

    await updateConversation(updatedConversation.id, {
      lastAssistantMessage: finalText.slice(0, 240),
      updatedAt: new Date().toISOString(),
    })

    if (patch) {
      writeSse(response, 'tool_progress', {
        label: 'Applying profile patch',
        status: 'running',
      })
      const applied = await applySmartConfigProfilePatch({
        patch,
        profileId: profile.id,
      })
      writeSse(response, 'profile_applied', applied)
      writeSse(response, 'tool_progress', {
        label: 'Profile patch applied',
        status: 'completed',
      })
    }

    writeSse(response, 'assistant_final', {
      id: `smart-config-assistant-${Date.now()}`,
      role: 'assistant',
      content: finalText || 'Smart Config finished without a visible response.',
      createdAt: new Date().toISOString(),
    })
    writeSse(response, 'done', { ok: true })
  } catch (error) {
    writeSse(response, 'error', publicSmartConfigError(error))
    writeSse(response, 'done', { ok: false })
  } finally {
    if (listener) listener()
    finishSse(response)
  }
}

async function resolveWorkspaceProfile(profileId) {
  const workspace = await listWorkspaceProfiles()
  const profile =
    workspace.profiles.find((item) => item.id === profileId) ||
    workspace.profiles.find((item) => item.id === workspace.activeProfileId) ||
    workspace.profiles[0]

  if (!profile) {
    const error = new Error('A saved Speak profile is required for Smart Config.')
    error.status = 400
    error.code = 'smart_config_profile_required'
    throw error
  }

  return profile
}

async function ensureSmartConfigConversation({ conversationId, profile }) {
  const index = await readConversationIndex()
  const existing = index.conversations.find(
    (item) => item.id === conversationId || item.threadId === conversationId,
  )
  if (existing) return existing

  const created = normalizeConversation({
    id: `smart-config-${randomUUID()}`,
    profileId: profile.id,
    profileName: profile.name,
    title: smartConfigThreadTitle(profile.name),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  await mutateConversationIndex((draft) => {
    draft.conversations = [
      created,
      ...draft.conversations.filter((item) => item.id !== created.id),
    ]
    return draft
  })
  return created
}

async function ensureCodexThread({ conversation, profile }) {
  const codexSettings = smartConfigCodexSettings()
  if (conversation.threadId) {
    await codexAppServer.request('thread/resume', {
      approvalPolicy: 'never',
      config: codexSettings.config,
      cwd: repoRoot,
      model: codexSettings.model,
      sandbox: 'danger-full-access',
      serviceTier: codexSettings.serviceTier,
      threadId: conversation.threadId,
    })
    return {
      threadId: conversation.threadId,
      title: conversation.title || smartConfigThreadTitle(profile.name),
    }
  }

  const title = smartConfigThreadTitle(profile.name)
  const result = await codexAppServer.request('thread/start', {
    approvalPolicy: 'never',
    config: codexSettings.config,
    cwd: repoRoot,
    developerInstructions: smartConfigDeveloperInstructions(profile),
    ephemeral: false,
    model: codexSettings.model,
    sandbox: 'danger-full-access',
    serviceTier: codexSettings.serviceTier,
    threadSource: 'speak-smart-config',
  })
  const threadId = result?.thread?.id || result?.threadId || result?.id
  if (!threadId) {
    throw new Error('Codex app-server did not return a Smart Config thread ID.')
  }

  await codexAppServer.request('thread/name/set', {
    name: title,
    threadId,
  })

  return { threadId, title }
}

function createStreamState(response, threadId) {
  let turnId = ''
  let assistantText = ''
  let settled = false
  let settledError = null
  let settledText = ''
  let resolveCompletion = null
  let rejectCompletion = null
  const timeoutMs = Number(process.env.SPEAK_SMART_CONFIG_TURN_TIMEOUT_MS || 600000)
  const timeout = setTimeout(() => {
    if (settled) return
    settled = true
    settledError = new Error('Smart Config Codex turn timed out.')
    activeSmartConfigTurns.delete(threadId)
    rejectCompletion?.(new Error('Smart Config Codex turn timed out.'))
  }, timeoutMs)

  return {
    append(delta) {
      if (!delta) return
      assistantText += delta
      writeSse(response, 'assistant_delta', {
        delta,
        threadId,
        turnId,
      })
    },
    complete(text = '') {
      if (text && text.length > assistantText.length) assistantText = text
      if (settled) return
      settled = true
      settledText = assistantText
      activeSmartConfigTurns.delete(threadId)
      clearTimeout(timeout)
      resolveCompletion?.(assistantText)
    },
    fail(error) {
      if (settled) return
      settled = true
      settledError = error
      activeSmartConfigTurns.delete(threadId)
      clearTimeout(timeout)
      rejectCompletion?.(error)
    },
    matches(params = {}) {
      if (params.threadId && params.threadId !== threadId) return false
      if (turnId && params.turnId && params.turnId !== turnId) return false
      return true
    },
    noteProgress(label, status = 'running') {
      writeSse(response, 'tool_progress', {
        label,
        status,
        threadId,
        turnId,
      })
    },
    setTurnId(nextTurnId) {
      if (!nextTurnId) return
      const changed = turnId !== nextTurnId
      turnId = nextTurnId
      activeSmartConfigTurns.set(threadId, {
        startedAt: new Date().toISOString(),
        turnId,
      })
      if (!changed) return
      writeSse(response, 'turn', {
        threadId,
        turnId,
      })
    },
    waitForCompletion() {
      if (settled && settledError) return Promise.reject(settledError)
      if (settled) return Promise.resolve(settledText || assistantText)
      return new Promise((resolve, reject) => {
        resolveCompletion = resolve
        rejectCompletion = reject
      })
    },
  }
}

function handleCodexNotification(streamState, envelope = {}) {
  const { method, params = {} } = envelope
  if (!streamState.matches(params)) return

  if (params.turnId) streamState.setTurnId(params.turnId)

  if (method === 'turn/started') {
    streamState.setTurnId(params.turn?.id || params.turnId)
    return
  }

  if (method === 'item/agentMessage/delta') {
    streamState.append(params.delta)
    return
  }

  if (method === 'item/started') {
    const itemType = params.item?.type || 'work'
    if (itemType !== 'agentMessage' && itemType !== 'reasoning') {
      streamState.noteProgress(progressLabelForItem(params.item), 'running')
    }
    return
  }

  if (method === 'item/completed') {
    const item = params.item || {}
    if (item.type === 'agentMessage' && item.text) {
      streamState.complete(item.text)
      return
    }
    if (item.type && item.type !== 'reasoning') {
      streamState.noteProgress(progressLabelForItem(item), 'completed')
    }
    return
  }

  if (method === 'turn/completed') {
    const lastAgentMessage = [...(params.turn?.items || [])]
      .reverse()
      .find((item) => item?.type === 'agentMessage' && item.text)
    streamState.complete(lastAgentMessage?.text)
    return
  }

  if (method === 'turn/failed' || method === 'error') {
    streamState.fail(new Error(params.message || 'Smart Config Codex turn failed.'))
  }
}

function progressLabelForItem(item = {}) {
  if (item.title) return item.title
  if (item.type === 'commandExecution') return item.command || 'Running command'
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
    return item.toolName || item.name || 'Using tool'
  }
  if (item.type === 'fileChange') return item.path || 'Updating file'
  return 'Working'
}

async function buildSmartConfigPrompt({ profile, steer = false, userMessage }) {
  let speakOptions = null
  try {
    speakOptions = await readSpeakConfigOptions()
  } catch (_error) {
    speakOptions = null
  }

  const context = {
    schemaVersion: SMART_CONFIG_SCHEMA_VERSION,
    selectedProfile: profile,
    availableConfigOptions: summarizeConfigOptions(speakOptions),
    patchContract: {
      fence: 'smart-config-profile-patch',
      shape: {
        profile: {
          name: 'optional new profile name',
          config: {
            instructions: 'optional prompt/system message',
            voiceRuntimeProvider: 'optional hume or inworld realtime speech-to-speech provider',
            voice: 'optional configured provider voice id',
            humeVoiceName: 'optional display voice name',
            humeVoiceProvider: 'optional CUSTOM_VOICE or HUME_AI',
            inworldVoiceName: 'optional Inworld display voice name',
            inworldVoiceProvider: 'optional INWORLD_SYSTEM or INWORLD_CUSTOM',
            smartViewId: 'optional durable contact Smart View id',
            eviVersion: 'optional Speak EVI version or Inworld Realtime marker',
            languageModelMode: 'optional hume, inworld, or codex',
            codexAuthModel: 'optional Codex-auth language model for Codex-mode profiles',
            codexReasoningEffort: 'optional none, minimal, low, medium, high, or xhigh for Codex-mode profiles',
            codexFastMode: 'optional fast-mode boolean for Codex-mode profiles',
            useConfigPrompt: 'optional provider compatibility flag; the saved profile instructions remain the runtime prompt source',
            useConfigTools: 'normally true so Speak uses this profile tool configuration',
          },
          testVariables: {
            first_name: 'optional browser test contact first name',
            business_name: 'optional browser test contact business name',
            contact_phone: 'optional browser test contact phone number',
            contact_email: 'optional browser test contact email address',
          },
        },
        changeSummary: ['short applied change summary'],
      },
    },
  }

  return [
    '<smart_config_context>',
    JSON.stringify(context, null, 2),
    '</smart_config_context>',
    '',
    '<smart_config_user_message>',
    userMessage,
    '</smart_config_user_message>',
    '',
    steer
      ? 'This is a follow-up steer message for the active Smart Config turn.'
      : 'Respond naturally as Codex in the Speak playground.',
    'When the selected Speak agent profile should change, include exactly one fenced block labelled smart-config-profile-patch with a minimal JSON patch matching the contract.',
    'By default, prompt and settings changes apply to both the Codex-side agent configuration and the Speak voice configuration. Only scope a change to one side when the user explicitly says Codex-only or Speak-only.',
    'For prompt changes, keep the saved profile instructions as the single source of truth for both Codex-mode and Speak voice runtime. Do not create separate Codex-only and Speak-only prompts unless the user explicitly asks. For tool/settings changes, keep useConfigTools true unless explicitly scoped otherwise.',
    'Do not modify files, run provider CLIs, change live campaign state, or include secrets.',
    'Use only Speak agent configuration fields. Do not set provider IDs, phone transport IDs, raw credentials, sample rates, media codecs, or webhook/runtime infrastructure.',
    'If no profile change is needed, do not include a patch block.',
  ].join('\n')
}

function smartConfigDeveloperInstructions(profile) {
  return [
    'You are the private Codex Smart Config agent for the Speak playground.',
    'Your scope is strictly Speak agent configuration: prompt, profile name, voice, model/settings, smart-view linkage, and browser test variables.',
    `The selected profile is ${profile.name}.`,
    'Default every prompt or settings change across both Codex-mode agent behavior and Speak voice configuration unless the user explicitly scopes it to one side.',
    'Do not make repo edits, shell changes, deployments, live calls, lead mutations, SMS, email, or external side effects.',
    'If a configuration change is appropriate, end with one smart-config-profile-patch fenced JSON block. The Speak backend will validate, apply, and sync it automatically.',
  ].join('\n')
}

function extractSmartConfigPatch(text = '') {
  const match = String(text).match(
    /```smart-config-profile-patch\s*([\s\S]*?)```/i,
  )
  if (!match?.[1]) return null
  try {
    const parsed = JSON.parse(match[1])
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (_error) {
    return null
  }
}

function cleanSmartConfigPatchBlock(text = '') {
  return String(text)
    .replace(/```smart-config-profile-patch\s*[\s\S]*?```/gi, '')
    .trim()
}

async function applySmartConfigProfilePatch({ patch, profileId }) {
  const workspace = await listWorkspaceProfiles()
  const existing = workspace.profiles.find((profile) => profile.id === profileId)
  if (!existing) {
    const error = new Error('Selected Speak profile is no longer available.')
    error.status = 404
    error.code = 'smart_config_profile_missing'
    throw error
  }

  const { profilePatch, ignoredConfigKeys } = normalizeSmartConfigPatch(patch)
  const prepared = normalizeWorkspaceProfile({
    ...existing,
    name: profilePatch.name || existing.name,
    updatedAt: new Date().toISOString(),
    config: {
      ...existing.config,
      ...profilePatch.config,
    },
    testVariables: {
      ...existing.testVariables,
      ...profilePatch.testVariables,
    },
  })
  const ownedUpdates = diffOwnedUpdates(existing, prepared)
  const needsSpeakSync =
    ownedUpdates.name ||
    ownedUpdates.prompt ||
    ownedUpdates.settings ||
    ownedUpdates.voice

  let syncedProfile = prepared
  let syncProof = null
  if (needsSpeakSync) {
    syncProof = await syncSpeakAgentConfig({
      profileName: prepared.name,
      config: prepared.config,
      createNew: speakConfigOwnedByDifferentProfile(workspace.profiles, prepared),
      ownedUpdates,
    })
    syncedProfile = mergeSpeakSyncIntoProfile(prepared, syncProof)
  }

  const nextProfiles = [
    syncedProfile,
    ...workspace.profiles.filter((profile) => profile.id !== existing.id),
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const persisted = await replaceWorkspaceProfiles({
    activeProfileId: workspace.activeProfileId,
    profiles: nextProfiles,
  })
  const persistedProfile =
    persisted.profiles.find((profile) => profile.id === syncedProfile.id) ||
    syncedProfile

  return {
    schemaVersion: SMART_CONFIG_SCHEMA_VERSION,
    ok: true,
    profile: persistedProfile,
    profiles: persisted.profiles,
    activeProfileId: persisted.activeProfileId,
    changeSummary: Array.isArray(patch.changeSummary)
      ? patch.changeSummary.map((item) => String(item)).filter(Boolean)
      : [],
    ignoredConfigKeys,
    ownedUpdates,
    sync: syncProof,
  }
}

function speakConfigOwnedByDifferentProfile(profiles = [], profile) {
  const configId = String(
    isInworldRuntime(profile?.config || {})
      ? profile?.config?.inworldConfigId || profile?.config?.speakConfigId || ''
      : profile?.config?.humeConfigId || profile?.config?.speakConfigId || '',
  ).trim()
  if (!configId || !profile?.id) return false

  return profiles.some((item) => {
    if (item.id === profile.id) return false
    const itemConfigId = String(
      isInworldRuntime(profile?.config || {})
        ? item.config?.inworldConfigId || item.config?.speakConfigId || ''
        : item.config?.humeConfigId || item.config?.speakConfigId || '',
    ).trim()
    return itemConfigId && itemConfigId === configId
  })
}

function normalizeSmartConfigPatch(patch = {}) {
  const profile = patch.profile && typeof patch.profile === 'object'
    ? patch.profile
    : patch
  const configPatch =
    profile.config && typeof profile.config === 'object' ? profile.config : {}
  const testPatch =
    profile.testVariables && typeof profile.testVariables === 'object'
      ? profile.testVariables
      : {}
  const ignoredConfigKeys = []
  const config = {}
  Object.entries(configPatch).forEach(([key, value]) => {
    if (forbiddenConfigPatchKeys.has(key)) {
      ignoredConfigKeys.push(key)
      return
    }
    config[key] = value
  })
  const testVariables = {}
  Object.entries(testPatch).forEach(([key, value]) => {
    if (testVariableKeys.has(key)) testVariables[key] = value
  })

  return {
    ignoredConfigKeys,
    profilePatch: {
      name:
        typeof profile.name === 'string' && profile.name.trim()
          ? profile.name.trim()
          : '',
      config,
      testVariables,
    },
  }
}

function diffOwnedUpdates(previous, next) {
  const changedConfigKeys = Object.keys(next.config || {}).filter(
    (key) => JSON.stringify(previous.config?.[key]) !== JSON.stringify(next.config?.[key]),
  )
  const changedTestKeys = Object.keys(next.testVariables || {}).filter(
    (key) =>
      JSON.stringify(previous.testVariables?.[key]) !==
      JSON.stringify(next.testVariables?.[key]),
  )

  return {
    name: previous.name !== next.name,
    prompt: changedConfigKeys.some((key) => promptConfigKeys.has(key)),
    settings: changedConfigKeys.some(
      (key) => !promptConfigKeys.has(key) && !voiceConfigKeys.has(key),
    ),
    test: changedTestKeys.length > 0,
    voice: changedConfigKeys.some((key) => voiceConfigKeys.has(key)),
  }
}

function mergeSpeakSyncIntoProfile(profile, payload = {}) {
  const configPatch = {}
  const inworldRuntime = isInworldRuntime(payload.config || profile.config || {})
  const providerConfigId = payload.speakConfigId || payload.humeConfigId || payload.inworldConfigId
  const providerConfigName =
    payload.speakConfigName || payload.humeConfigName || payload.inworldConfigName
  const providerConfigVersion =
    payload.speakConfigVersion ?? payload.humeConfigVersion ?? payload.inworldConfigVersion
  const syncedAt =
    payload.speakConfigSyncedAt ||
    payload.humeConfigSyncedAt ||
    payload.inworldConfigSyncedAt ||
    payload.config?.speakConfigSyncedAt ||
    payload.config?.inworldConfigSyncedAt

  if (providerConfigId) {
    if (inworldRuntime) {
      configPatch.inworldConfigId = providerConfigId
    } else {
      configPatch.humeConfigId = providerConfigId
    }
    configPatch.speakConfigId = providerConfigId
  }
  if (providerConfigVersion !== undefined) {
    if (inworldRuntime) {
      configPatch.inworldConfigVersion = providerConfigVersion
    } else {
      configPatch.humeConfigVersion = providerConfigVersion
    }
    configPatch.speakConfigVersion = providerConfigVersion
  }
  if (syncedAt) {
    if (inworldRuntime) {
      configPatch.inworldConfigSyncedAt = syncedAt
    } else {
      configPatch.humeConfigSyncedAt = syncedAt
    }
    configPatch.speakConfigSyncedAt = syncedAt
  }
  configPatch.useConfigPrompt = true
  configPatch.useConfigTools = true

  return normalizeWorkspaceProfile({
    ...profile,
    name: providerConfigName || profile.name,
    config: {
      ...profile.config,
      ...(payload.config || {}),
      ...configPatch,
    },
  })
}

async function readCodexConversationMessages(threadId) {
  try {
    const thread = await codexAppServer.request('thread/read', {
      includeTurns: true,
      threadId,
    })
    const turns = thread?.turns || thread?.thread?.turns || []
    return turns.flatMap((turn) => messagesFromCodexTurn(turn))
  } catch (_error) {
    return []
  }
}

function messagesFromCodexTurn(turn = {}) {
  const createdAt = turn.createdAt || turn.startedAt || ''
  return (turn.items || []).flatMap((item, index) => {
    if (item.type === 'userMessage') {
      const content = extractUserMessageFromPrompt(userMessageText(item))
      if (!content) return []
      return [{
        id: `${turn.id || 'turn'}-user-${index}`,
        role: 'user',
        content,
        createdAt,
      }]
    }
    if (item.type === 'agentMessage' && item.text) {
      return [{
        id: `${turn.id || 'turn'}-assistant-${index}`,
        role: 'assistant',
        content: cleanSmartConfigPatchBlock(item.text),
        createdAt,
      }]
    }
    return []
  })
}

function userMessageText(item = {}) {
  if (typeof item.text === 'string') return item.text
  if (typeof item.message === 'string') return item.message
  if (typeof item.content === 'string') return item.content
  if (Array.isArray(item.content)) {
    return item.content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') return part.text || part.content || ''
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function extractUserMessageFromPrompt(text = '') {
  const match = String(text).match(
    /<smart_config_user_message>\s*([\s\S]*?)\s*<\/smart_config_user_message>/i,
  )
  return match?.[1]?.trim() || ''
}

function summarizeConfigOptions(options) {
  if (!options) return null
  return {
    eviVersions: (options.eviVersions || []).map((item) => ({
      label: item.label,
      value: item.value,
      runtimeProvider: item.runtimeProvider,
    })),
    functionTools: (options.functionTools || []).map((item) => item.name),
    languageModels: (options.languageModels || []).slice(0, 24).map((item) => ({
      label: item.label,
      value: item.value,
      runtimeProvider: item.runtimeProvider,
    })),
    voices: (options.voices || []).slice(0, 32).map((item) => ({
      id: item.id || item.value,
      name: item.name || item.label,
      provider: item.provider || item.type,
      runtimeProvider: item.runtimeProvider,
    })),
  }
}

async function updateConversation(id, patch) {
  const index = await mutateConversationIndex((draft) => {
    draft.conversations = draft.conversations.map((conversation) =>
      conversation.id === id
        ? normalizeConversation({ ...conversation, ...patch })
        : conversation,
    )
    return draft
  })
  return index.conversations.find((conversation) => conversation.id === id)
}

async function readConversationIndex() {
  if (!existsSync(conversationIndexPath)) {
    return { version: indexVersion, conversations: [] }
  }

  const raw = await readFile(conversationIndexPath, 'utf8')
  const parsed = JSON.parse(raw)
  return {
    version: indexVersion,
    conversations: publicConversations(parsed.conversations || []),
  }
}

async function mutateConversationIndex(mutator) {
  const run = async () => {
    const current = await readConversationIndex()
    const next = mutator({
      version: indexVersion,
      conversations: [...current.conversations],
    })
    const normalized = {
      version: indexVersion,
      conversations: publicConversations(next.conversations || []),
    }
    await mkdir(workspaceDataDir, { recursive: true })
    const tempPath = `${conversationIndexPath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(
      tempPath,
      `${JSON.stringify(normalized, null, 2)}\n`,
      'utf8',
    )
    await rename(tempPath, conversationIndexPath)
    return normalized
  }

  indexMutationQueue = indexMutationQueue.then(run, run)
  return indexMutationQueue
}

function publicConversations(conversations, profileId = '') {
  return (Array.isArray(conversations) ? conversations : [])
    .map(normalizeConversation)
    .filter((conversation) => !profileId || conversation.profileId === profileId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function normalizeConversation(value = {}) {
  const now = new Date().toISOString()
  return {
    id: String(value.id || `smart-config-${randomUUID()}`),
    profileId: String(value.profileId || ''),
    profileName: String(value.profileName || ''),
    threadId: String(value.threadId || ''),
    title: String(value.title || smartConfigThreadTitle(value.profileName)),
    createdAt: String(value.createdAt || value.updatedAt || now),
    updatedAt: String(value.updatedAt || value.createdAt || now),
    lastAssistantMessage: String(value.lastAssistantMessage || ''),
  }
}

function smartConfigThreadTitle(profileName = '') {
  const suffix = String(profileName || 'Agent').trim() || 'Agent'
  return `Speak / Main / Smart Config - ${suffix}`
}

function prepareSse(response) {
  response.status(200)
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  response.setHeader('Cache-Control', 'no-cache, no-transform')
  response.setHeader('Connection', 'keep-alive')
  response.flushHeaders?.()
}

function writeSse(response, event, data = {}) {
  if (response.writableEnded) return
  response.write(`event: ${event}\n`)
  response.write(`data: ${JSON.stringify(data)}\n\n`)
}

function finishSse(response) {
  if (!response.writableEnded) response.end()
}

function publicSmartConfigError(error) {
  if (isVoiceConfigSyncError(error)) {
    return {
      error: 'smart_config_sync_failed',
      message: error.message,
      provider: error.provider,
      status: error.status || 502,
    }
  }

  return {
    error: error?.code || 'smart_config_failed',
    message: error instanceof Error ? error.message : 'Smart Config failed.',
    status: error?.status || 500,
  }
}
