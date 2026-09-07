import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { buildCallToolsProofGates } from './calltools-proof-gates.mjs'
import {
  audioStatsSummary,
  readCallToolsAudioEvidence,
} from './calltools-audio-evidence.mjs'
import { callLogFileName } from '../server/operational-time.mjs'

const args = new Set(process.argv.slice(2))
const options = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith('--') && arg.includes('='))
    .map((arg) => {
      const [key, ...rest] = arg.slice(2).split('=')
      return [key, rest.join('=')]
    }),
)

const requireComplete = args.has('--require-complete')
const minCallerTurns = Number(options.minCallerTurns || process.env.CALLTOOLS_LIVE_PROOF_MIN_CALLER_TURNS || 2)
const minAssistantTurns = Number(options.minAssistantTurns || process.env.CALLTOOLS_LIVE_PROOF_MIN_ASSISTANT_TURNS || 2)
const callControlId = String(options.callControlId || options.call || '').trim()
const expectedProfileId = String(options.profileId || options.agentProfileId || '').trim()
const expectedCampaignId = String(options.campaignId || options.calltoolsCampaignId || '').trim()
const expectedProviderCallId = normalizeCallToolsProviderId(
  options.providerCallId || options.calltoolsCallId || '',
)
let pinnedCallControlId = callControlId
const startedAfter = String(options.startedAfter || '').trim()
const startedAfterMs = startedAfter ? Date.parse(startedAfter) : 0
const waitMs = numberOption(options.waitMs || process.env.CALLTOOLS_LIVE_PROOF_WAIT_MS, 0)
const pollMs = numberOption(options.pollMs || process.env.CALLTOOLS_LIVE_PROOF_POLL_MS, 2_000)
const logFile =
  options.log ||
  process.env.SPEAK_CALLTOOLS_PROOF_LOG ||
  path.join(process.env.CALL_LOG_DIR || 'call-logs', callLogFileName(new Date()))
const callAudioDir = options.callAudioDir || process.env.CALL_AUDIO_DIR || 'call-audio'
const recordingReviewOption = String(options.recordingReview || '').trim()
const recordingTranscriptReview = readJsonOption(recordingReviewOption)
const recordingTranscriptOk = recordingReviewOption
  ? recordingTranscriptReview?.ok === true
  : null
const operatorAction =
  'Keep the selected CallTools campaign active and the Speak agent Available until one answered human call is routed to Speak, then rerun --include-live; or supply --liveProof=<campaign-proof.json>.'

if (startedAfter && !Number.isFinite(startedAfterMs)) {
  finish(failedProof('invalid_started_after', `startedAfter is not a valid timestamp: ${startedAfter}`))
}
if (recordingReviewOption && !recordingTranscriptReview) {
  finish(failedProof('recording_review_invalid', 'recordingReview is not valid JSON or a readable JSON file.'))
}

finish(await waitForCampaignProof())

async function waitForCampaignProof() {
  const deadline = Date.now() + waitMs
  let latestProof = null
  do {
    const latest = latestCallToolsCall()
    if (latest) {
      latestProof = summarizeProof(latest.id, latest.events)
      if (latestProof.ok) return latestProof
    }
    if (Date.now() >= deadline) break
    await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())))
  } while (Date.now() <= deadline)

  if (latestProof) {
    return {
      ...latestProof,
      error: 'native_campaign_call_proof_incomplete',
      operatorAction,
    }
  }
  return failedProof(
    'native_campaign_call_artifact_not_found',
    existsSync(logFile)
      ? 'No lease-authorized native CallTools campaign invite matched this proof run.'
      : `Call log was not found: ${logFile}`,
  )
}

function latestCallToolsCall() {
  if (!existsSync(logFile)) return null
  const records = readFileSync(logFile, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  const byCall = new Map()
  for (const record of records) {
    const id = String(record.callControlId || '')
    if (!id || (pinnedCallControlId && id !== pinnedCallControlId)) continue
    const provider = record.event?.communication?.provider || record.provider || ''
    const hasCallToolsDiagnostic = Boolean(record.event?.diagnostic?.calltools)
    const isCallTools = id.startsWith('calltools-') || provider === 'calltools' || hasCallToolsDiagnostic
    if (!isCallTools) continue
    if (!byCall.has(id)) byCall.set(id, [])
    byCall.get(id).push(record)
  }
  const candidates = [...byCall.entries()]
    .map(([id, events]) => ({ id, events, inviteMs: nativeInviteMs(events) }))
    .filter((item) => !startedAfterMs || item.inviteMs >= startedAfterMs)
  if (pinnedCallControlId) return candidates[0] || null
  const selected = candidates
    .filter((item) => item.inviteMs > 0 && campaignProofIdentity(item.id, item.events).ok)
    .sort((left, right) => left.inviteMs - right.inviteMs)[0] || null
  if (selected) pinnedCallControlId = selected.id
  return selected
}

function summarizeProof(id, events) {
  const diagnostics = events.map((event) => event.event?.diagnostic).filter(Boolean)
  const latestDiagnostic = diagnostics.at(-1) || {}
  const timestamps = Object.assign({}, ...diagnostics.map((item) => item.timestamps || {}))
  const timingMs = Object.assign({}, ...diagnostics.map((item) => item.timingMs || {}))
  const counters = Object.assign({}, ...diagnostics.map((item) => item.counters || {}))
  const audio = events.map((event) => event.event?.audio).filter(Boolean).at(-1) || {}
  const audioQuality = events.map((event) => event.event?.audioQuality).filter(Boolean).at(-1) || {}
  const conversation = summarizeConversationTurns(events)
  const providerIds = Object.assign(
    {},
    ...events.map((event) => event.event?.communication?.providerIds || {}),
  )
  const identity = campaignProofIdentity(id, events)
  const finalPatch = [...events].reverse().find((event) => event.event?.patch?.phase === 'ended')?.event?.patch || {}
  const nativeInviteReceived = Boolean(timestamps.calltools_gateway_invite_received)
  const nativeGatewayAttached = Boolean(timestamps.calltools_gateway_attached)
  const accepted = nativeInviteReceived && nativeGatewayAttached && identity.ok
  const answered = events.some((event) => event.event?.patch?.answeredAt) || Boolean(timestamps.calltools_gateway_attached)
  const audioEvidence = readCallToolsAudioEvidence({ callControlId: id, callAudioDir })
  const leadAudio = audioEvidence.diagnostics['lead-calltools-input']
  const aiAudio = audioEvidence.diagnostics['ai-calltools-output']
  const callerAudioTransport = Number(counters.calltoolsMediaInPackets || 0) > 0 || Boolean(timestamps.first_calltools_media_in)
  const callerAudioAudible = Boolean(leadAudio?.audible)
  const callerAudio = callerAudioTransport && callerAudioAudible
  const assistantAudioTransport =
    Number(counters.calltoolsMediaOutPackets || 0) > 0 ||
    Boolean(timestamps.first_calltools_media_out) ||
    Boolean(timestamps.first_inworld_audio_output)
  const assistantAudioAudible = Boolean(aiAudio?.audible)
  const assistantAudio = assistantAudioTransport && assistantAudioAudible
  const greetingRequested = Boolean(timestamps.initial_greeting_requested)
  const inworldSessionAttached = Boolean(timestamps.inworld_session_attached)
  const humeSessionAttached = Boolean(
    timestamps.hume_chat_attached || timestamps.hume_ws_open,
  )
  const voiceSessionAttached = inworldSessionAttached || humeSessionAttached
  const userTranscript = Boolean(timestamps.first_user_message) && conversation.callerTranscript
  const assistantTranscriptAfterCaller = conversation.assistantTranscriptAfterCaller
  const agentWaitedForCaller = conversation.agentWaitedForCaller
  const enoughBackAndForth =
    conversation.callerTurnCount >= minCallerTurns &&
    conversation.assistantTurnCountAfterCaller >= minAssistantTurns
  const conversationalTurn =
    voiceSessionAttached &&
    userTranscript &&
    assistantTranscriptAfterCaller &&
    agentWaitedForCaller &&
    enoughBackAndForth &&
    assistantAudio
  const hasLeadAudio = Array.isArray(audio.sources) ? audio.sources.includes('lead') : false
  const hasAiAudio = Array.isArray(audio.sources) ? audio.sources.includes('ai') : false
  const gateTimingMs = normalizeGateTimingMs(deriveAssistantAudioTimingMs(timingMs, timestamps), {
    answered,
    assistantAudio,
  })
  const gates = buildCallToolsProofGates({ timingMs: gateTimingMs, audioQuality, options })
  const ok =
    accepted &&
    answered &&
    callerAudio &&
    assistantAudio &&
    !greetingRequested &&
    conversationalTurn &&
    gates.ok &&
    (recordingTranscriptOk !== false)

  return {
    schemaVersion: 'speak.calltools.campaign-proof.v1',
    ok,
    callControlId: id,
    outcome: finalPatch.outcome || '',
    accepted,
    nativeInviteReceived,
    nativeGatewayAttached,
    identity,
    answered,
    callerAudio,
    callerAudioTransport,
    callerAudioAudible,
    assistantAudio,
    assistantAudioTransport,
    assistantAudioAudible,
    greetingRequested,
    agentWaitedForCaller,
    enoughBackAndForth,
    conversationalTurn,
    voiceSessionAttached,
    humeSessionAttached,
    inworldSessionAttached,
    userTranscript,
    assistantTranscriptAfterCaller,
    conversation,
    requiredConversation: {
      minCallerTurns,
      minAssistantTurns,
    },
    audio: {
      status: audio.status || '',
      sources: audio.sources || [],
      hasLeadAudio,
      hasAiAudio,
      durationSeconds: audio.durationSeconds || null,
      evidence: {
        leadCallToolsInput: audioStatsSummary(leadAudio),
        aiCallToolsOutput: audioStatsSummary(aiAudio),
        mixed: audioStatsSummary(audioEvidence.mixed),
      },
    },
    providerIds: {
      calltoolsCallId: providerIds.calltoolsCallId || '',
      calltoolsContactId: normalizeCallToolsProviderId(providerIds.calltoolsContactId),
      calltoolsCampaignId: providerIds.calltoolsCampaignId || '',
      calltoolsPhoneId: providerIds.calltoolsPhoneId || '',
      calltoolsQueueId: providerIds.calltoolsQueueId || '',
    },
    recordingTranscriptReview,
    recordingTranscriptOk,
    timingMs: {
      calltoolsDialToGatewayAttach: timingMs.calltoolsDialToGatewayAttach ?? null,
      calltoolsInviteToVoiceInputReady: timingMs.calltoolsInviteToVoiceInputReady ?? null,
      calltoolsAttachToInworldSession: timingMs.calltoolsAttachToInworldSession ?? null,
      calltoolsAttachToInitialGreetingRequest:
        timingMs.calltoolsAttachToInitialGreetingRequest ?? null,
      firstCallToolsLeadAudioToFirstUserMessage:
        timingMs.firstCallToolsLeadAudioToFirstUserMessage ?? null,
      firstUserMessageToFirstAssistantMessage:
        timingMs.firstUserMessageToFirstAssistantMessage ?? null,
      firstUserMessageToFirstAssistantAudio:
        gateTimingMs.firstUserMessageToFirstAssistantAudio ?? null,
      firstInworldAudioToFirstCallToolsAudio:
        timingMs.firstInworldAudioToFirstCallToolsAudio ?? null,
      calltoolsAttachToFirstAssistantAudio:
        timingMs.calltoolsAttachToFirstAssistantAudio ?? null,
    },
    gates,
    timestamps: {
      dialRequested: timestamps.calltools_gateway_dial_requested || '',
      inviteReceived: timestamps.calltools_gateway_invite_received || '',
      gatewayAttached: timestamps.calltools_gateway_attached || '',
      voiceInputReady: timestamps.voice_input_ready || '',
      initialGreetingRequested: timestamps.initial_greeting_requested || '',
      firstCallerAudio: timestamps.first_calltools_media_in || '',
      humeSessionAttached:
        timestamps.hume_chat_attached || timestamps.hume_ws_open || '',
      inworldSessionAttached: timestamps.inworld_session_attached || '',
      firstUserMessage: timestamps.first_user_message || '',
      firstAssistantMessage: timestamps.first_assistant_message || '',
      firstAssistantAudio: timestamps.first_calltools_media_out || timestamps.first_inworld_audio_output || '',
    },
  }
}

function summarizeConversationTurns(events) {
  const seenTurns = new Set()
  const turns = events
    .map((event, index) => {
      const entry = event.event?.entry
      const text = String(entry?.text || '').trim()
      const speaker = String(entry?.speaker || '').trim()
      if (!entry || !text || !speaker) return null
      if (isSyntheticControlText(text)) return null
      return {
        index,
        at: event.at || '',
        speaker,
        text,
        tone: entry.tone || '',
        providerEventId: entry.providerEventId || '',
      }
    })
    .filter(Boolean)
    .filter((turn) => uniqueTurn(turn, seenTurns))
  const callerTurns = turns.filter((turn) =>
    /^(lead|caller|contact|customer)$/i.test(turn.speaker),
  )
  const assistantTurns = turns.filter((turn) =>
    /^(ai|assistant|agent)$/i.test(turn.speaker) && turn.tone !== 'system',
  )
  const firstCaller = callerTurns.find((turn) => turn.tone !== 'system') || callerTurns[0]
  const assistantAfterCaller = firstCaller
    ? turns.find(
        (turn) =>
          turn.index > firstCaller.index &&
          /^(ai|assistant|agent)$/i.test(turn.speaker) &&
          turn.tone !== 'system',
      )
    : null
  const assistantBeforeCaller =
    firstCaller && assistantTurns.find((turn) => turn.index < firstCaller.index)
  const assistantTurnsAfterCaller = firstCaller
    ? assistantTurns.filter((turn) => turn.index > firstCaller.index)
    : []
  return {
    callerTranscript: Boolean(firstCaller?.text),
    assistantTranscriptAfterCaller: Boolean(assistantAfterCaller?.text),
    agentWaitedForCaller: Boolean(firstCaller?.text) && !assistantBeforeCaller,
    callerTurnCount: callerTurns.filter((turn) => turn.tone !== 'system').length,
    assistantTurnCount: assistantTurns.length,
    assistantTurnCountAfterCaller: assistantTurnsAfterCaller.length,
    callerTextPreview: previewText(firstCaller?.text || ''),
    assistantTextPreview: previewText(assistantAfterCaller?.text || ''),
    turnCount: turns.length,
  }
}

function uniqueTurn(turn, seen) {
  const key = turn.providerEventId || `${turn.speaker}|${turn.at}|${turn.text}`
  if (seen.has(key)) return false
  seen.add(key)
  return true
}

function isSyntheticControlText(text = '') {
  return /^the outbound phone call is connected now\./i.test(String(text || '').trim())
}

function previewText(text = '') {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  return clean.length > 160 ? `${clean.slice(0, 157)}...` : clean
}

function latestMs(events) {
  return Math.max(...events.map((event) => Date.parse(event.at || '') || 0))
}

function normalizeGateTimingMs(timingMs = {}, proof = {}) {
  const normalized = { ...timingMs }
  if (!proof.answered) {
    delete normalized.calltoolsAttachToHumeOpen
    delete normalized.calltoolsAttachToInworldOpen
    delete normalized.calltoolsAttachToHumeChat
    delete normalized.calltoolsAttachToInworldSession
    delete normalized.calltoolsAttachToInitialGreetingRequest
    delete normalized.calltoolsAttachToFirstAssistantAudio
  }
  if (!proof.assistantAudio) {
    delete normalized.firstHumeAudioToFirstCallToolsAudio
    delete normalized.firstInworldAudioToFirstCallToolsAudio
  }
  return normalized
}

function deriveAssistantAudioTimingMs(timingMs = {}, timestamps = {}) {
  return {
    ...timingMs,
    firstUserMessageToFirstAssistantAudio:
      timingMs.firstUserMessageToFirstAssistantAudio ??
      elapsedMs(
        timestamps.first_user_message,
        timestamps.first_calltools_media_out ||
          timestamps.first_telnyx_media_out ||
          timestamps.first_inworld_audio_output ||
          timestamps.first_hume_audio_output,
      ),
  }
}

function elapsedMs(start, end) {
  const startMs = Date.parse(start || '')
  const endMs = Date.parse(end || '')
  if (!startMs || !endMs || endMs < startMs) return undefined
  return endMs - startMs
}

function normalizeCallToolsProviderId(value = '') {
  const text = String(value || '').trim()
  if (!text) return ''
  const prefixed = text.match(/^calltools-(.+)$/i)
  return String(prefixed?.[1] || text).trim()
}

function campaignProofIdentity(id, events = []) {
  const providerProofs = events
    .map((event) => event.event?.calltoolsProviderIdentity)
    .filter((value) => value && typeof value === 'object')
  const providerProof = providerProofs.at(-1) || {}
  const providerExpected =
    providerProof.expected && typeof providerProof.expected === 'object'
      ? providerProof.expected
      : {}
  const profileIds = uniqueText(
    events.flatMap((event) => [
      event.agent?.id,
      event.event?.communication?.agentProfileId,
    ]),
  )
  const campaignIds = uniqueText(
    events.map((event) => event.event?.communication?.providerIds?.calltoolsCampaignId),
  )
  const providerCallIds = uniqueText(
    events.map((event) =>
      normalizeCallToolsProviderId(
        event.event?.communication?.providerIds?.calltoolsCallId,
      ),
    ),
  )
  const phoneIds = uniqueText(
    events.map((event) => event.event?.communication?.providerIds?.calltoolsPhoneId),
  )
  const providers = uniqueText(
    events.flatMap((event) => [event.provider, event.event?.communication?.provider]),
  ).map((value) => value.toLowerCase())
  const profileId = String(providerProof.profileId || '').trim()
  const campaignId = String(providerProof.campaignId || '').trim()
  const providerCallId = normalizeCallToolsProviderId(providerProof.providerCallId)
  const phoneId = String(providerProof.phoneId || '').trim()
  const leaseId = String(providerProof.leaseId || '').trim()
  const appUserId = String(providerProof.appUserId || '').trim()
  const verifiedAt = String(providerProof.verifiedAt || '').trim()
  const callControlProviderId = normalizeCallToolsProviderId(id)
  const errors = []
  if (!providerProofs.length) errors.push('provider-authoritative live-call identity missing')
  if (String(providerProof.provider || '').toLowerCase() !== 'calltools') {
    errors.push('provider-authoritative identity is not CallTools')
  }
  if (providerProof.authoritative !== true) errors.push('provider live-call identity is not authoritative')
  if (providerProof.ok !== true) errors.push('provider live-call identity failed its frozen lease check')
  if (!leaseId) errors.push('lease ID missing')
  if (!profileId) errors.push('profile ID missing')
  if (!appUserId) errors.push('provider app user ID missing')
  if (!campaignId) errors.push('campaign ID missing')
  if (!providerCallId) {
    errors.push('provider call ID missing')
  }
  if (!phoneId) errors.push('provider phone ID missing')
  if (!Number.isFinite(Date.parse(verifiedAt))) errors.push('provider identity verification time missing')
  for (const key of ['leaseId', 'profileId', 'appUserId', 'campaignId', 'phoneId']) {
    const expectedValue = String(providerExpected[key] || '').trim()
    const actualValue = String(providerProof[key] || '').trim()
    if (!expectedValue) errors.push(`frozen lease ${key} missing`)
    else if (actualValue !== expectedValue) errors.push(`${key} does not match frozen lease`)
  }
  if (profileIds.length !== 1 || (profileId && profileIds[0] !== profileId)) {
    errors.push(profileIds.length > 1 ? 'profile IDs conflict' : 'profile event identity mismatch')
  }
  if (campaignIds.length !== 1 || (campaignId && campaignIds[0] !== campaignId)) {
    errors.push(campaignIds.length > 1 ? 'campaign IDs conflict' : 'campaign event identity mismatch')
  }
  const allowedProviderCallIds = new Set(
    [providerCallId, callControlProviderId].filter(Boolean),
  )
  if (
    providerCallIds.length === 0 ||
    providerCallIds.some((value) => !allowedProviderCallIds.has(value))
  ) {
    errors.push(
      providerCallIds.length > 1
        ? 'provider call IDs conflict'
        : 'provider call event identity mismatch',
    )
  }
  if (phoneIds.length !== 1 || (phoneId && phoneIds[0] !== phoneId)) {
    errors.push(phoneIds.length > 1 ? 'provider phone IDs conflict' : 'provider phone event identity mismatch')
  }
  if (providers.length !== 1 || providers[0] !== 'calltools') {
    errors.push(providers.length > 1 ? 'providers conflict' : 'CallTools provider proof missing')
  }
  if (expectedProfileId && profileId !== expectedProfileId) {
    errors.push(`profile ID does not match expected ${expectedProfileId}`)
  }
  if (expectedCampaignId && campaignId !== expectedCampaignId) {
    errors.push(`campaign ID does not match expected ${expectedCampaignId}`)
  }
  if (expectedProviderCallId && providerCallId !== expectedProviderCallId) {
    errors.push(`provider call ID does not match expected ${expectedProviderCallId}`)
  }
  return {
    ok: errors.length === 0,
    profileId,
    leaseId,
    appUserId,
    campaignId,
    provider: providers.length === 1 ? providers[0] : '',
    providerCallId,
    phoneId,
    authoritative: providerProof.authoritative === true,
    verifiedAt,
    callControlProviderId,
    expected: {
      profileId: expectedProfileId,
      campaignId: expectedCampaignId,
      providerCallId: expectedProviderCallId,
    },
    errors,
  }
}

function uniqueText(values = []) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))]
}

function nativeInviteMs(events = []) {
  const values = events
    .map((event) => event.event?.diagnostic?.timestamps?.calltools_gateway_invite_received)
    .map((value) => Date.parse(String(value || '')))
    .filter(Number.isFinite)
  return values.length ? Math.min(...values) : 0
}

function readJsonOption(value = '') {
  if (!value) return null
  try {
    return JSON.parse(existsSync(value) ? readFileSync(value, 'utf8') : value)
  } catch {
    return null
  }
}

function failedProof(error, message) {
  return {
    schemaVersion: 'speak.calltools.campaign-proof.v1',
    ok: false,
    error,
    message,
    operatorAction,
    callControlId,
    logFile,
    startedAfter,
    identity: {
      ok: false,
      expected: {
        profileId: expectedProfileId,
        campaignId: expectedCampaignId,
        providerCallId: expectedProviderCallId,
      },
      errors: [message],
    },
    recordingTranscriptReview,
    recordingTranscriptOk,
  }
}

function numberOption(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function finish(payload) {
  console.log(JSON.stringify(payload, null, 2))
  process.exit(requireComplete && !payload.ok ? 1 : 0)
}
