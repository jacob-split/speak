import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recentCallSummaries } from '../server/call-history.mjs'
import {
  createCallState,
  inferHangupOutcome,
  inferStreamStopOutcome,
  normalizeCallOutcome,
  normalizeLead,
  publicLeadContext,
  resolveToolHangupOutcome,
  shouldDeferToolHangup,
} from '../server/call-state.mjs'
import { speakOpenAiToolDefinitions } from '../server/hume-tools.mjs'
import { normalizeCampaignConfig } from '../server/runtime-config.mjs'

const importedLead = normalizeLead({
  id: 'csv-3',
  name: 'Imported lead 4',
  firstName: 'Imported',
  lastName: 'lead 4',
  business_name: 'Bruggemans Food Stores',
  phone_on_file: '+12025550142',
})

assert.equal(importedLead.name, 'Bruggemans Food Stores')
assert.equal(importedLead.firstName, '')
assert.equal(importedLead.lastName, '')
assert.equal(importedLead.company, 'Bruggemans Food Stores')
assert.equal(importedLead.phone, '+12025550142')

const realContact = normalizeLead({
  name: 'Blossom Bee',
  company: 'Blossom And Bee Catering LLC',
})
assert.equal(realContact.name, 'Blossom Bee')
assert.equal(realContact.firstName, 'Blossom')
assert.equal(realContact.company, 'Blossom And Bee Catering LLC')

const calltoolsLead = normalizeLead({
  id: 'calltools-123',
  name: 'CallTools Contact',
  business_name: 'CallTools Account',
  phone_on_file: '+15551234567',
  source: 'calltools',
  sourceId: 'campaign:12345:live-filter:70884',
  sourceName: 'CallTools 1.0 Contacts',
  sourceUrl: 'calltools://campaigns/12345/live-filters/70884',
  providerIds: {
    calltoolsCallId: 'calltools-call-123',
    calltoolsContactId: '123',
    calltoolsCampaignId: '12345',
  },
})
assert.equal(calltoolsLead.source, 'calltools')
assert.equal(calltoolsLead.sourceId, 'campaign:12345:live-filter:70884')
assert.equal(calltoolsLead.sourceName, 'CallTools 1.0 Contacts')
assert.equal(calltoolsLead.providerIds.calltoolsCampaignId, '12345')

const config = normalizeCampaignConfig({
  endOfTurnSilenceMs: 500,
  speechDetectionThreshold: 0.55,
  minInterruptionMs: 250,
})
assert.equal(config.endOfTurnSilenceMs, 500)
assert.equal(config.speechDetectionThreshold, 0.58)
assert.equal(config.minInterruptionMs, 550)

const formerLatencyDefault = normalizeCampaignConfig({
  endOfTurnSilenceMs: 650,
})
assert.equal(formerLatencyDefault.endOfTurnSilenceMs, 500)

const state = createCallState('test-call', importedLead, config)
assert.deepEqual(publicLeadContext(state), {
  id: 'csv-3',
  first_name: '',
  last_name: '',
  name: 'Bruggemans Food Stores',
  business_name: 'Bruggemans Food Stores',
  phone_on_file: '+12025550142',
  email_on_file: '',
  called_phone: '+12025550142',
  context_counts: {
    hasText: false,
    urls: 0,
    files: 0,
  },
})

const calltoolsState = createCallState('calltools-follow-call', calltoolsLead, {
  ...config,
  dialerProvider: 'calltools',
  agentProfileId: 'agent-config-calltools-default',
  agentProfileName: 'calltools.default',
})
calltoolsState.callProvider = 'calltools'
calltoolsState.eventLog.push({
  patch: { phase: 'live' },
  communication: {
    provider: 'calltools',
    providerIds: {
      calltoolsCallId: 'calltools-call-123',
      calltoolsContactId: '123',
      calltoolsCampaignId: '12345',
      fromPhone: '+15550001111',
    },
  },
})
assert.deepEqual(publicLeadContext(calltoolsState), {
  id: 'calltools-123',
  first_name: 'CallTools',
  last_name: 'Contact',
  name: 'CallTools Contact',
  business_name: 'CallTools Account',
  phone_on_file: '+15551234567',
  email_on_file: '',
  called_phone: '+15551234567',
  source: 'calltools',
  sourceId: 'campaign:12345:live-filter:70884',
  sourceName: 'CallTools 1.0 Contacts',
  sourceUrl: 'calltools://campaigns/12345/live-filters/70884',
  context_counts: {
    hasText: false,
    urls: 0,
    files: 0,
  },
})
const calltoolsRecent = recentCallSummaries({
  callStates: [calltoolsState],
  callLogDir: path.join(mkdtempSync(path.join(os.tmpdir(), 'speak-call-history-')), 'logs'),
  limit: 1,
  leadForState: publicLeadContext,
})[0]
assert.equal(calltoolsRecent.provider, 'calltools')
assert.equal(calltoolsRecent.providerIds.calltoolsCallId, 'calltools-call-123')
assert.equal(calltoolsRecent.providerIds.fromPhone, undefined)
assert.equal(calltoolsRecent.lead.source, 'calltools')
assert.equal(calltoolsRecent.lead.sourceId, 'campaign:12345:live-filter:70884')

const earlyHangup = createCallState('early-call', importedLead, config)
earlyHangup.answered = true
earlyHangup.answeredAt = new Date(Date.now() - 1000).toISOString()
assert.equal(
  inferStreamStopOutcome(earlyHangup),
  'no-answer',
  'answered short stream with no transcript should not be completed',
)
assert.equal(
  inferHangupOutcome(earlyHangup, {
    hangup_cause: 'normal_clearing',
    start_time: new Date(Date.now() - 20_000).toISOString(),
    answered_at: earlyHangup.answeredAt,
    end_time: new Date().toISOString(),
  }),
  'no-answer',
  'answered short hangup with no transcript should measure from answer time',
)

const silentCallToolsBridge = createCallState('silent-calltools-bridge', calltoolsLead, {
  ...config,
  dialerProvider: 'calltools',
})
silentCallToolsBridge.callProvider = 'calltools'
silentCallToolsBridge.answered = true
silentCallToolsBridge.answeredAt = new Date(Date.now() - 10_000).toISOString()
assert.equal(
  inferStreamStopOutcome(silentCallToolsBridge),
  'no-answer',
  'an established CallTools SIP leg with zero conversation turns must not be completed',
)

const ordinaryCallToolsHangup = createCallState('ordinary-calltools-hangup', calltoolsLead, {
  ...config,
  dialerProvider: 'calltools',
})
ordinaryCallToolsHangup.callProvider = 'calltools'
ordinaryCallToolsHangup.answered = true
ordinaryCallToolsHangup.answeredAt = new Date(Date.now() - 45_000).toISOString()
ordinaryCallToolsHangup.leadUtteranceCount = 3
ordinaryCallToolsHangup.assistantUtteranceCount = 3
assert.equal(
  inferStreamStopOutcome(ordinaryCallToolsHangup),
  'operator-ended',
  'a normal CallTools provider hangup must not infer that the business goal was completed',
)
assert.equal(
  inferHangupOutcome(ordinaryCallToolsHangup, { hangup_cause: 'normal_clearing' }),
  'operator-ended',
  'a normal CallTools clearing must use the neutral customer-hangup disposition',
)

ordinaryCallToolsHangup.outcome = 'completed'
assert.equal(
  inferStreamStopOutcome(ordinaryCallToolsHangup),
  'completed',
  'an explicit completed outcome must remain authoritative for CallTools',
)

const hangUpTool = speakOpenAiToolDefinitions().find(
  (tool) => tool.function?.name === 'hang_up',
)
const advertisedHangUpOutcomes =
  hangUpTool?.function?.parameters?.properties?.outcome?.enum || []
assert.deepEqual(
  advertisedHangUpOutcomes,
  [
    'completed',
    'no-answer',
    'voicemail',
    'not-interested',
    'callback',
    'wrong-number',
    'do-not-call',
    'operator-ended',
    'skipped',
    'failed',
  ],
  'hang_up must advertise the canonical outcome vocabulary used by the backend',
)
for (const outcome of advertisedHangUpOutcomes) {
  assert.equal(
    normalizeCallOutcome(outcome),
    outcome,
    `hang_up outcome ${outcome} must survive backend normalization`,
  )
}
assert.equal(normalizeCallOutcome('not_interested'), 'not-interested')
assert.equal(normalizeCallOutcome('wrong_number'), 'wrong-number')
assert.equal(normalizeCallOutcome('do_not_call'), 'do-not-call')

const silentNoAnswerToolHangup = createCallState(
  'silent-no-answer-tool-hangup',
  importedLead,
  config,
)
assert.equal(
  resolveToolHangupOutcome(silentNoAnswerToolHangup, { outcome: 'no-answer' }),
  'no-answer',
  'no-answer remains valid when no caller conversation was captured',
)

const conversedToolHangup = createCallState('conversed-tool-hangup', importedLead, config)
conversedToolHangup.leadUtteranceCount = 2
assert.equal(
  resolveToolHangupOutcome(conversedToolHangup, { outcome: 'no-answer' }),
  'operator-ended',
  'a voice agent cannot overwrite a captured caller conversation with no-answer',
)

const callerSpeakingToolHangup = createCallState('caller-speaking-tool-hangup', importedLead, config)
callerSpeakingToolHangup.lastUserInterimAt = 10_000
callerSpeakingToolHangup.lastUserInterimText = 'Hey, I am still here'
assert.equal(
  shouldDeferToolHangup(callerSpeakingToolHangup, { nowMs: 11_000 }),
  true,
  'a hang-up request must fail closed while a recent interim caller turn is active',
)
callerSpeakingToolHangup.lastUserInterimText = ''
assert.equal(
  shouldDeferToolHangup(callerSpeakingToolHangup, { nowMs: 11_000 }),
  false,
  'a finalized caller turn must release the hang-up guard',
)
callerSpeakingToolHangup.inworldUserSpeechActive = true
assert.equal(
  shouldDeferToolHangup(callerSpeakingToolHangup, { nowMs: 11_000 }),
  true,
  'the hang-up guard must cover Inworld speech-start state too',
)

const callStateModule = await import('../server/call-state.mjs')
assert.equal(
  typeof callStateModule.resolveToolHangupOutcome,
  'function',
  'the hang_up boundary must expose a testable fail-closed outcome resolver',
)
const silentToolHangup = createCallState('silent-tool-hangup', calltoolsLead, config)
assert.equal(
  callStateModule.resolveToolHangupOutcome(silentToolHangup, {}),
  'no-answer',
  'hang_up without an outcome and without a caller turn must not claim completion',
)
const conversationalToolHangup = createCallState(
  'conversational-tool-hangup',
  calltoolsLead,
  config,
)
conversationalToolHangup.leadUtteranceCount = 1
conversationalToolHangup.assistantUtteranceCount = 1
assert.equal(
  callStateModule.resolveToolHangupOutcome(conversationalToolHangup, {}),
  'operator-ended',
  'hang_up without an explicit result must use a neutral terminal outcome',
)
assert.equal(
  callStateModule.resolveToolHangupOutcome(conversationalToolHangup, {
    outcome: 'not_interested',
  }),
  'not-interested',
  'explicit legacy tool outcomes must normalize to the canonical result',
)

console.log('Lead identity and runtime default checks passed.')
