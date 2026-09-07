import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import {
  missingForCall,
  normalizeCampaignConfig,
} from '../server/runtime-config.mjs'
import {
  buildTransportDiagnosticSnapshot,
  createTransportDiagnostics,
} from '../server/transport-diagnostics.mjs'
import {
  applySharedCallToolsDutyBinding,
  auditCallToolsReadiness,
  ensureCallToolsAgentSessionReadiness,
  listCallToolsOptions,
  readCallToolsDutyStatus,
  readCallToolsHistoricalCall,
  readCallToolsPhoneCredentials,
  reconcileCallToolsCallOutcome,
  resolveCallToolsLiveCallContext,
  sanitizeCallToolsPayload,
} from '../server/calltools-client.mjs'
import { enrichCallToolsContactsWithPhoneNumbers } from '../server/calltools-contacts.mjs'
import { createCallToolsDutyMonitor } from '../server/calltools-duty-monitor.mjs'
import { assertCallToolsSeatClaimSafe } from '../server/calltools-seat-claim.mjs'
import {
  callToolsVoiceStandbyRuntimeFingerprint,
  callToolsVoiceStandbyScopeKey,
  createCallToolsVoiceStandbyCoordinator,
} from '../server/calltools-voice-standby.mjs'
import { buildSpeakAgentContract } from '../server/agent-contract.mjs'
import { callLogFileName, operationalDate, operationalTimeZone } from '../server/operational-time.mjs'
import { applyWorkspaceDialerStatePatch } from '../server/workspace-store.mjs'
import {
  callToolsDutyIsActive,
  resolveDialerAgentProfileId,
} from '../src/dialerAgentSelection.ts'

const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
const CALLTOOLS_FAVICON_SOURCE_URL = 'https://calltools.com/wp-content/themes/calltools-theme-v2/favicon.png'
const CALLTOOLS_FAVICON_SHA256 = 'd84b7499d14783d95dd12aa56550ef72ee256c5bf8ac9b3969d43a1b2e679a17'

try {
  Object.assign(process.env, {
    HUME_API_KEY: 'test-hume-key',
    HUME_CONFIG_ID: 'test-hume-config',
    CALLTOOLS_API_KEY: 'test-calltools-key',
    CALLTOOLS_MEDIA_GATEWAY_URL: 'wss://speak-calltools-gateway.example.test',
    CALLTOOLS_MEDIA_GATEWAY_SHARED_SECRET: 'test-secret',
    GOG_WRAPPER: '/bin/sh',
  })
  delete process.env.TELNYX_API_KEY
  delete process.env.TELNYX_CONNECTION_ID
  delete process.env.TELNYX_FROM_NUMBER

  const callToolsConfig = normalizeCampaignConfig({
    dialerProvider: 'calltools',
    humeConfigId: 'test-hume-config',
    calltoolsAgentBinding: {
      enabled: true,
      appUserId: 'agent-user-id',
      phoneId: 'phone-id',
      webCallbackId: '21',
      campaignId: 'campaign-id',
      mediaGatewayStatus: 'configured',
    },
  })

  assert.equal(callToolsConfig.dialerProvider, 'calltools')
  assert.equal(callToolsConfig.voiceRuntimeProvider, 'hume')
  assert.equal(callToolsConfig.calltoolsAgentBinding.mode, 'phone_as_agent')
  assert.equal(callToolsConfig.calltoolsAgentBinding.mediaGatewayStatus, 'configured')
  assert.equal(callToolsConfig.calltoolsAgentBinding.webCallbackId, '21')
  assert.deepEqual(missingForCall(callToolsConfig), [])
  const selectedJaiProfile = {
    id: 'agent-config-jai',
    name: 'JAI',
    config: {
      voiceRuntimeProvider: 'hume',
      humeConfigId: 'jai-hume-config',
      voice: 'jai-stan',
      languageModelMode: 'speak',
      languageModelProvider: 'ANTHROPIC',
      languageModelResource: 'claude-sonnet-4-6',
      promptExpansionEnabled: true,
      nudgesEnabled: true,
      eviStartsConversation: false,
      useConfigPrompt: true,
      useConfigTools: true,
      phoneCallerId: '+15555550101',
      personalPhoneInbound: { enabled: false },
    },
  }
  const activeJaiDuty = {
    leaseId: 'lease-jai-stan',
    profileId: selectedJaiProfile.id,
    status: 'on',
  }
  assert.equal(callToolsDutyIsActive(activeJaiDuty), true)
  assert.equal(
    resolveDialerAgentProfileId(activeJaiDuty, 'agent-config-calltools-default'),
    selectedJaiProfile.id,
    'an active CallTools duty lease pins the Dialer to its assigned agent instead of a shared fallback profile',
  )
  assert.equal(
    resolveDialerAgentProfileId(
      { leaseId: '', profileId: selectedJaiProfile.id, status: 'off' },
      'agent-config-calltools-default',
    ),
    'agent-config-calltools-default',
    'the saved Dialer selection resumes only after the CallTools duty lease is explicitly off',
  )
  const sharedDutyProfile = applySharedCallToolsDutyBinding(selectedJaiProfile, [
    selectedJaiProfile,
    {
      id: 'agent-config-calltools-default',
      name: 'calltools.default',
      config: callToolsConfig,
    },
  ])
  assert.equal(sharedDutyProfile.id, selectedJaiProfile.id)
  assert.equal(sharedDutyProfile.config.voiceRuntimeProvider, 'hume')
  assert.equal(sharedDutyProfile.config.humeConfigId, 'jai-hume-config')
  assert.equal(sharedDutyProfile.config.voice, 'jai-stan')
  assert.equal(sharedDutyProfile.config.dialerProvider, 'calltools')
  assert.equal(sharedDutyProfile.config.calltoolsAgentBinding.appUserId, 'agent-user-id')
  assert.equal(sharedDutyProfile.config.calltoolsAgentBinding.phoneId, 'phone-id')
  const {
    calltoolsAgentBinding: sharedBindingOverlay,
    dialerProvider: sharedDialerOverlay,
    ...sharedVoiceRuntime
  } = sharedDutyProfile.config
  assert.equal(sharedDialerOverlay, 'calltools')
  assert.equal(sharedBindingOverlay.phoneId, 'phone-id')
  assert.deepEqual(
    sharedVoiceRuntime,
    selectedJaiProfile.config,
    'CallTools may overlay only transport identity and the shared seat binding; every Playground profile setting must remain byte-for-byte selected-agent state',
  )
  assert.deepEqual(sharedDutyProfile.calltoolsBindingResolution, {
    selectedVoiceProfileId: selectedJaiProfile.id,
    selectedVoiceProfileName: selectedJaiProfile.name,
    adoptedSharedBinding: true,
    source: 'workspace-shared-seat',
    bindingSourceProfileId: 'agent-config-calltools-default',
    bindingSourceProfileName: 'calltools.default',
  })
  assert.equal(
    selectedJaiProfile.config.calltoolsAgentBinding,
    undefined,
    'shared CallTools duty binding must not mutate the selected voice profile',
  )
  verifyCallToolsVoiceStandbyRuntimeIsolation()
  const partiallyBoundJai = {
    ...selectedJaiProfile,
    config: {
      ...selectedJaiProfile.config,
      calltoolsAgentBinding: {
        appUserId: 'agent-user-id',
        campaignId: 'campaign-id',
      },
    },
  }
  const resolvedPartialJai = applySharedCallToolsDutyBinding(partiallyBoundJai, [
    partiallyBoundJai,
    {
      id: 'shared-seat-binding',
      name: 'Workspace shared seat',
      config: callToolsConfig,
    },
  ])
  assert.equal(resolvedPartialJai.id, partiallyBoundJai.id)
  assert.equal(resolvedPartialJai.config.calltoolsAgentBinding.phoneId, 'phone-id')
  assert.equal(resolvedPartialJai.calltoolsBindingResolution.selectedVoiceProfileId, partiallyBoundJai.id)
  assert.equal(resolvedPartialJai.calltoolsBindingResolution.bindingSourceProfileId, 'shared-seat-binding')
  assert.equal(resolvedPartialJai.calltoolsBindingResolution.adoptedSharedBinding, true)
  assert.equal(partiallyBoundJai.config.calltoolsAgentBinding.phoneId, undefined)
  assert.throws(
    () =>
      applySharedCallToolsDutyBinding(selectedJaiProfile, [
        selectedJaiProfile,
        {
          id: 'shared-binding-a',
          name: 'Shared binding A',
          config: {
            dialerProvider: 'calltools',
            calltoolsAgentBinding: {
              appUserId: 'agent-user-id',
              phoneId: 'phone-id-a',
              campaignId: 'campaign-id',
            },
          },
        },
        {
          id: 'shared-binding-b',
          name: 'Shared binding B',
          config: {
            dialerProvider: 'calltools',
            calltoolsAgentBinding: {
              appUserId: 'agent-user-id',
              phoneId: 'phone-id-b',
              campaignId: 'campaign-id',
            },
          },
        },
      ]),
    (error) => {
      assert.equal(error?.code, 'calltools_shared_binding_ambiguous')
      assert.deepEqual(error?.candidateProfileIds, [
        'shared-binding-a',
        'shared-binding-b',
      ])
      return true
    },
    'shared CallTools binding resolution must fail closed when complete candidates disagree',
  )
  const equivalentSharedCandidates = [
    {
      id: 'shared-binding-a',
      name: 'Shared binding A',
      config: {
        dialerProvider: 'calltools',
        calltoolsAgentBinding: {
          appUserId: 'agent-user-id',
          phoneId: 'phone-id',
          campaignId: 'campaign-id',
          mediaGatewayStatus: 'configured',
        },
      },
    },
    {
      id: 'shared-binding-b',
      name: 'Shared binding B',
      config: {
        dialerProvider: 'calltools',
        calltoolsAgentBinding: {
          appUserId: 'agent-user-id',
          phoneId: 'phone-id',
          campaignId: 'campaign-id',
          mediaGatewayStatus: 'registered',
        },
      },
    },
  ]
  const equivalentSharedBindingForward = applySharedCallToolsDutyBinding(
    selectedJaiProfile,
    equivalentSharedCandidates,
  ).config.calltoolsAgentBinding
  const equivalentSharedBindingReverse = applySharedCallToolsDutyBinding(
    selectedJaiProfile,
    [...equivalentSharedCandidates].reverse(),
  ).config.calltoolsAgentBinding
  assert.deepEqual(
    equivalentSharedBindingReverse,
    equivalentSharedBindingForward,
    'equivalent shared bindings must resolve deterministically regardless of profile order',
  )
  assert.equal(equivalentSharedBindingForward.mediaGatewayStatus, 'configured')
  assert.equal(operationalTimeZone(), 'America/New_York')
  assert.equal(
    operationalDate('2026-07-04T00:30:00Z'),
    '2026-07-03',
    'Speak and CallTools use the Eastern operational date across the UTC midnight boundary',
  )
  assert.equal(
    callLogFileName('2026-07-04T00:30:00Z'),
    'events-2026-07-03.jsonl',
    'CallTools proof logs use the Eastern operational date, not the UTC date',
  )
  await checkCallToolsDutyMonitorBehavior()
  await checkCallToolsSeatClaimSafety()
  await checkFocusedCallToolsDutyStatusReader()

  const noCallbackConfig = normalizeCampaignConfig({
    ...callToolsConfig,
    calltoolsAgentBinding: {
      ...callToolsConfig.calltoolsAgentBinding,
      webCallbackId: '',
    },
  })
  assert.deepEqual(
    missingForCall(noCallbackConfig),
    [],
    'CallTools campaign-follow runtime must not require Web Callback configuration',
  )
  const preconnectedVoiceState = {
    transportDiagnostics: createTransportDiagnostics({
      sampleRate: 16000,
      telnyxStreamCodec: 'L16',
      inworldRealtimeModel: 'google-ai-studio/gemini-2.5-flash',
    }),
  }
  preconnectedVoiceState.transportDiagnostics.timestamps = {
    inworld_session_attached: '2026-07-03T10:00:00.000Z',
    calltools_gateway_attached: '2026-07-03T10:00:05.000Z',
  }
  assert.equal(
    buildTransportDiagnosticSnapshot(preconnectedVoiceState).timingMs
      .calltoolsAttachToInworldSession,
    0,
    'CallTools proof latency treats preconnected Inworld sessions as already attached',
  )

  const blockedConfig = normalizeCampaignConfig({
    dialerProvider: 'calltools',
    humeConfigId: 'test-hume-config',
  })
  const blockedMissing = missingForCall(blockedConfig)
  assert.ok(blockedMissing.includes('CALLTOOLS_AGENT_USER_ID'))
  assert.ok(blockedMissing.includes('CALLTOOLS_PHONE_ID'))
  assert.ok(!blockedMissing.includes('TELNYX_API_KEY'))

  const sanitized = sanitizeCallToolsPayload({
    id: 1,
    password: 'must-not-leak',
    nested: { api_key: 'must-not-leak' },
  })
  assert.equal(sanitized.password, '[redacted]')
  assert.equal(sanitized.nested.api_key, '[redacted]')

  Object.assign(process.env, {
    CALLTOOLS_GATEWAY_PHONE_ID: 'phone-id',
    CALLTOOLS_GATEWAY_PHONE_WS_URL: 'wss://sip.calltools.test',
    CALLTOOLS_GATEWAY_PHONE_SIP_URI: 'sip:operator@example.calltools.test',
    CALLTOOLS_GATEWAY_PHONE_USERNAME: 'speak-phone-user',
    CALLTOOLS_GATEWAY_PHONE_PASSWORD: 'local-phone-password',
  })
  globalThis.fetch = async () => {
    const error = new Error('This operation was aborted')
    error.name = 'AbortError'
    throw error
  }
  const fallbackPhone = await readCallToolsPhoneCredentials('phone-id')
  assert.equal(fallbackPhone.id, 'phone-id')
  assert.equal(fallbackPhone.server, 'wss://sip.calltools.test')
  assert.equal(fallbackPhone.uri, 'sip:operator@example.calltools.test')
  assert.equal(fallbackPhone.authorizationUsername, 'speak-phone-user')
  assert.equal(fallbackPhone.authorizationPassword, 'local-phone-password')
  assert.equal(fallbackPhone.source, 'local_fallback')
  process.env.CALLTOOLS_PHONE_CREDENTIAL_FALLBACK_FIRST = 'true'
  let fallbackFirstFetchCalled = false
  globalThis.fetch = async () => {
    fallbackFirstFetchCalled = true
    return jsonResponse({
      id: 'phone-id',
      ws_url: 'wss://unexpected.calltools.test',
      sip_uri: 'sip:unexpected@example.calltools.test',
      username: 'unexpected',
      password: 'unexpected',
      is_webrtc: true,
    })
  }
  const fallbackFirstPhone = await readCallToolsPhoneCredentials('phone-id')
  assert.equal(fallbackFirstPhone.server, 'wss://sip.calltools.test')
  assert.equal(fallbackFirstFetchCalled, false)
  delete process.env.CALLTOOLS_GATEWAY_PHONE_ID
  delete process.env.CALLTOOLS_GATEWAY_PHONE_WS_URL
  delete process.env.CALLTOOLS_GATEWAY_PHONE_SIP_URI
  delete process.env.CALLTOOLS_GATEWAY_PHONE_USERNAME
  delete process.env.CALLTOOLS_GATEWAY_PHONE_PASSWORD
  delete process.env.CALLTOOLS_PHONE_CREDENTIAL_FALLBACK_FIRST

  const requestedUrls = []
  let contactBucketAssignmentBody = null
  let contactBucketAssigned = false
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    requestedUrls.push(url)
    if (url.pathname.endsWith('/users/')) {
      return jsonResponse({
        results: [
          {
            app_user: 'agent-user-id',
            full_name: 'Speak Operator',
            email: 'operator@example.com',
            is_agent: true,
            is_manager: false,
          },
        ],
      })
    }
    if (url.pathname.endsWith('/phones/')) {
      return jsonResponse({
        results: [
          {
            id: 'phone-id',
            app_user: 'agent-user-id',
            name: 'Speak Example Phone',
            sip_uri: 'sip:operator@example.calltools.test',
            ws_url: 'wss://sip.calltools.test',
            is_webrtc: true,
            extension: '1001',
            service_level: 'agent',
            call_recording: 'No',
            password: 'must-not-leak',
          },
        ],
      })
    }
    if (url.pathname.endsWith('/queues/')) {
      return jsonResponse({ results: [] })
    }
    if (url.pathname.endsWith('/campaigns/')) {
      return jsonResponse({
        results: [
          {
            id: 'campaign-id',
            name: 'Main Campaign',
            active: true,
            originate_calls: true,
            channels_per_agent: 5,
            amd_active: true,
            call_recording: true,
            caller_id_strategy: 'strategy-id',
            live_filter: 'stale-live-filter-id',
          },
        ],
      })
    }
    if (url.pathname.endsWith('/campaigns/campaign-id/')) {
      return jsonResponse({
        id: 'campaign-id',
        name: 'Main Campaign',
        active: true,
        originate_calls: true,
        channels_per_agent: 5,
        amd_active: true,
        call_recording: true,
        caller_id_strategy: 'strategy-id',
        live_filter: 'live-filter-id',
      })
    }
    if (url.pathname.endsWith('/agentstatuses/agent-user-id/')) {
      return jsonResponse({
        app_user: 'agent-user-id',
        full_name: 'Speak Operator',
        ready: true,
        logged_in: true,
        campaign: 'campaign-id',
        campaign_name: 'Main Campaign',
        web_phone_status: 'Registered',
        web_phone_registered_on: '2026-07-03T05:01:00Z',
        ps_endpoint_id: 'o26066_a26066_p39833',
        live_calls_count: 0,
      })
    }
    if (url.pathname.endsWith('/campaignagents/agent-user-id/')) {
      return jsonResponse({
        app_user: 'agent-user-id',
        full_name: 'Speak Operator',
        agent_status: 43869,
        campaign: 'campaign-id',
        priority: 0,
        ready: true,
        ready_since: '2026-07-03T05:01:00Z',
        last_call_on: '2026-07-03T05:00:00Z',
      })
    }
    if (url.pathname.endsWith('/campaignstatuses/campaign-id/')) {
      return jsonResponse({
        id: 'campaign-id',
        campaign: 'campaign-id',
        name: 'Main Campaign',
        active: true,
        originate_calls: true,
        channels_per_agent: 5,
        logged_in_agents: 1,
        waiting_agents: 1,
        phone_call_agents: 0,
        post_call_wrap_up_agents: 0,
        total_contact_count: 5,
        warning_message: '',
      })
    }
    if (url.pathname.endsWith('/callerids/')) {
      return jsonResponse({
        results: [
          {
            id: 'caller-id',
            name: 'Speak Caller ID',
            campaign_enabled: true,
            sti_verified: true,
          },
        ],
      })
    }
    if (url.pathname.endsWith('/webcallbacks/')) {
      return jsonResponse({
        results: [
          {
            id: '21',
            uuid: 'web-callback-uuid',
            name: 'Speak QA Phone Gateway',
            active: true,
            next_destination: 'Phone: Speak Example Phone',
            caller_id_strategy: 'strategy-id',
            ring_time: 60,
            retries: 0,
            retry_delay: 60,
          },
        ],
      })
    }
    if (url.pathname.endsWith('/livefilters/live-filter-id/')) {
      return jsonResponse({
        id: 'live-filter-id',
        name: 'All Contacts',
        active: true,
        count: 5,
        ignore_time_zone_count: 5,
        filter_contact_ready: true,
      })
    }
    if (url.pathname.endsWith('/buckets/7976/')) {
      if ((init.method || 'GET').toUpperCase() === 'PATCH') {
        contactBucketAssignmentBody = JSON.parse(inputBody(init))
        contactBucketAssigned = true
        return jsonResponse({
          id: '7976',
          name: 'Speak QA Test Contacts',
          count: 1,
          ...contactBucketAssignmentBody,
        })
      }
      return jsonResponse({
        id: '7976',
        name: 'Speak QA Test Contacts',
        count: contactBucketAssigned ? 1 : 0,
        filter_state_hours_holidays: false,
      })
    }
    if (url.pathname.endsWith('/livephonecalls/')) {
      return jsonResponse({
        results: [
          {
            call_uuid: '6a8dce41-9368-46f1-bf3f-d89f348dfb9a',
            contact: 123,
            campaign: 456,
            live_filter: 'live-filter-id',
            queue: 789,
            web_call_back: '21',
            app_user: 'agent-user-id',
            source: '+15552221000',
            destination: '+15550001111',
            inbound: false,
            call_type: 'campaign',
            call_path: 'campaign',
            start: '2026-07-02T15:01:00Z',
            answered_on: '2026-07-02T15:01:03Z',
          },
        ],
      })
    }
    if (url.pathname.endsWith('/calls/')) {
      if (url.searchParams.get('uuid') === 'provider-nonuuid-id') {
        return jsonResponse({ detail: 'Invalid uuid filter' }, 400)
      }
      if (url.searchParams.get('destination') === '+15550001111') {
        return jsonResponse({
          results: [
            {
              id: 410,
              uuid: 'older-direct-call',
              contact: null,
              campaign: null,
              queue: null,
              web_call_back: null,
              app_user: 'agent-user-id',
              source: '+15552221000',
              destination: '+15550001111',
              inbound: false,
              call_type: 'outbound',
              start: '2026-07-02T15:00:00Z',
              end: '2026-07-02T15:00:20Z',
              duration: 20,
              billsec: 19,
              call_recording_fsfile_id: 555111,
            },
            {
              id: 413,
              uuid: 'direct-outbound-call',
              contact: null,
              campaign: null,
              queue: null,
              web_call_back: null,
              app_user: 'agent-user-id',
              source: '+15552221000',
              destination: '+15550001111',
              inbound: false,
              call_type: 'outbound',
              start: '2026-07-02T15:01:02Z',
              end: '2026-07-02T15:01:26Z',
              duration: 24,
              billsec: 23,
              call_recording_fsfile_id: 888999,
            },
          ],
        })
      }
      if (url.searchParams.get('destination') === '+15550002222') {
        return jsonResponse({
          results: [
            {
              id: 409,
              uuid: 'stale-direct-outbound-call',
              contact: null,
              campaign: null,
              queue: null,
              web_call_back: null,
              app_user: 'agent-user-id',
              source: '+15552221000',
              destination: '+15550002222',
              inbound: false,
              call_type: 'outbound',
              start: '2026-07-02T13:01:00Z',
              end: '2026-07-02T13:01:20Z',
              duration: 20,
              billsec: 19,
              call_recording_fsfile_id: 444000,
            },
          ],
        })
      }
      return jsonResponse({
        results: [
          {
            id: 412,
            uuid: '6a8dce41-9368-46f1-bf3f-d89f348dfb9a',
            contact: 123,
            campaign: 456,
            queue: 789,
            web_call_back: '21',
            app_user: 'agent-user-id',
            source: '+15552221000',
            destination: '+15550001111',
            inbound: false,
            call_type: 'campaign',
            start: '2026-07-02T15:01:00Z',
            end: '2026-07-02T15:02:00Z',
            duration: 60,
            billsec: 55,
            call_recording_fsfile_id: 987654,
          },
        ],
      })
    }
    if (url.pathname.endsWith('/phonenumbers/phone-number-id/')) {
      return jsonResponse({
        id: 'phone-number-id',
        ...JSON.parse(inputBody(init)),
      })
    }
    if (url.pathname.endsWith('/phonenumbers/')) {
      return jsonResponse({
        results: [
          {
            id: 'phone-number-id',
            contact: 123,
            phone_number: '+15552221000',
            do_not_contact: false,
          },
        ],
      })
    }
    if (url.pathname.endsWith('/contactbuckets/')) {
      return jsonResponse({
        results: contactBucketAssigned
          ? [
              {
                id: 'contact-bucket-id',
                contact: 123,
                bucket: 7976,
              },
            ]
          : [],
      })
    }
    if (url.pathname.endsWith('/contacts/123/')) {
      if ((init.method || 'GET').toUpperCase() === 'PATCH') {
        const contactPatchBody = JSON.parse(inputBody(init))
        if (Array.isArray(contactPatchBody.add_buckets)) {
          contactBucketAssignmentBody = contactPatchBody
          contactBucketAssigned = true
        }
        return jsonResponse({
          id: 123,
          uuid: 'contact-uuid',
          first_name: 'Ada',
          last_name: 'Lovelace',
          company_name: 'Analytical Engines',
          phone_number: '(555) 222-1000',
          email: 'ada@example.com',
          state: 'CA',
          system_disposition: 'Ready',
          buckets: contactBucketAssigned ? [7976] : [],
        })
      }
      return jsonResponse({
        id: 123,
        uuid: 'contact-uuid',
        first_name: 'Ada',
        last_name: 'Lovelace',
        company_name: 'Analytical Engines',
        phone_number: '(555) 222-1000',
        email: 'ada@example.com',
        state: 'CA',
        system_disposition: 'Ready',
        buckets: contactBucketAssigned ? [7976] : [],
      })
    }
    if (url.pathname.endsWith('/calldispositions/')) {
      return jsonResponse({
        results: [
          { id: 86569, name: 'Not Interested' },
          { id: 86568, name: 'Contact not available' },
          { id: 86564, name: 'DNC This Number', set_phone_number_dnc: true },
          { id: 86562, name: 'Customer Hang Up' },
          { id: 86561, name: 'Call Back Scheduled' },
          { id: 86570, name: 'Wrong Number' },
        ],
      })
    }
    if (url.pathname.endsWith('/historicalcalldispositions/')) {
      return jsonResponse({
        id: 999,
        ...JSON.parse(inputBody(init)),
      }, 201)
    }
    throw new Error(`Unexpected mocked CallTools request: ${url.pathname}`)
  }
  const calltoolsOptions = await listCallToolsOptions()
  assert.equal(calltoolsOptions.phones.length, 1)
  assert.equal(calltoolsOptions.phones[0].id, 'phone-id')
  assert.equal(calltoolsOptions.phones[0].name, 'Speak Example Phone')
  assert.equal(calltoolsOptions.phones[0].sipUri, 'sip:operator@example.calltools.test')
  assert.equal(calltoolsOptions.phones[0].webSocketUrl, 'wss://sip.calltools.test')
  assert.equal(calltoolsOptions.phones[0].extension, '1001')
  assert.equal(calltoolsOptions.phones[0].serviceLevel, 'agent')
  assert.equal(
    JSON.stringify(calltoolsOptions.phones).includes('must-not-leak'),
    false,
    'CallTools phone options must not expose native phone passwords',
  )
  const liveContext = await resolveCallToolsLiveCallContext({
    calltoolsCallId: 'sip-call-id',
    from: '+15552221000',
    to: '+15550001111',
    config: callToolsConfig,
  })
  assert.equal(liveContext.liveCall.callUuid, '6a8dce41-9368-46f1-bf3f-d89f348dfb9a')
  assert.equal(liveContext.lead.id, 'calltools-123')
  assert.equal(liveContext.lead.company, 'Analytical Engines')
  assert.equal(liveContext.lead.source, 'calltools')
  assert.equal(liveContext.lead.sourceId, 'campaign:456:live-filter:live-filter-id')
  assert.equal(liveContext.lead.sourceName, 'CallTools Contacts')
  assert.equal('notes' in liveContext.lead, false)
  assert.equal(liveContext.lead.context?.text || '', '')
  assert.doesNotMatch(JSON.stringify(liveContext.lead), /Source: CallTools|CallTools contact ID/)
  assert.equal(liveContext.providerIds.calltoolsContactId, '123')
  assert.equal(liveContext.providerIds.calltoolsCampaignId, '456')
  assert.equal(liveContext.providerIds.calltoolsWebCallbackId, '21')
  assert.equal(liveContext.providerIds.calltoolsQueueId, '789')
  const uniqueScopedLiveContext = await resolveCallToolsLiveCallContext({
    calltoolsCallId: 'unrelated-sip-leg-id',
    config: callToolsConfig,
  })
  assert.equal(
    uniqueScopedLiveContext.liveCall?.callUuid,
    '6a8dce41-9368-46f1-bf3f-d89f348dfb9a',
    'a sole live call inside the frozen app-user and route binding must hydrate contact context even when the SIP leg ID differs',
  )
  assert.equal(uniqueScopedLiveContext.lead.id, 'calltools-123')
  assert.doesNotMatch(
    readFileSync('server/calltools-client.mjs', 'utf8'),
    /callToolsLiveCallMatches[\s\S]{0,300}liveCalls\[0\]/,
    'live-call identity must never fall back to an unrelated first provider call',
  )
  assert.equal(
    requestedUrls.find((url) => url.pathname.endsWith('/livephonecalls/'))?.searchParams.get('app_user_id'),
    'agent-user-id',
    'live-call lookup filters by the bound CallTools agent',
  )
  assert.equal(
    requestedUrls.find((url) => url.pathname.endsWith('/livephonecalls/'))?.searchParams.get('web_call_back_id'),
    '21',
    'live-call lookup filters by the bound CallTools Web callback route',
  )
  const campaignMirrorConfig = normalizeCampaignConfig({
    ...callToolsConfig,
    calltoolsAgentBinding: {
      ...callToolsConfig.calltoolsAgentBinding,
      webCallbackId: '',
      campaignId: 'campaign-id',
      queueId: 'queue-id',
    },
  })
  const mirrorLookupStart = requestedUrls.length
  await resolveCallToolsLiveCallContext({
    calltoolsCallId: 'sip-leg-id',
    config: campaignMirrorConfig,
  })
  const mirrorLiveCallRequest = requestedUrls
    .slice(mirrorLookupStart)
    .find((url) => url.pathname.endsWith('/livephonecalls/'))
  assert.equal(mirrorLiveCallRequest?.searchParams.get('campaign_id'), 'campaign-id')
  assert.equal(
    mirrorLiveCallRequest?.searchParams.get('queue_id'),
    null,
    'campaign mirror lookup must not combine campaign and unrelated queue filters',
  )
  const historicalCall = await readCallToolsHistoricalCall({
    calltoolsCallId: liveContext.liveCall.callUuid,
    contactId: liveContext.providerIds.calltoolsContactId,
    config: callToolsConfig,
  })
  assert.equal(historicalCall.uuid, '6a8dce41-9368-46f1-bf3f-d89f348dfb9a')
  assert.equal(historicalCall.callRecordingFsFileId, '987654')
  assert.equal(
    requestedUrls.find((url) => url.pathname.endsWith('/calls/'))?.searchParams.get('uuid'),
    '6a8dce41-9368-46f1-bf3f-d89f348dfb9a',
    'historical CallTools calls are queried by UUID for native recording metadata',
  )
  const fallbackHistoricalCall = await readCallToolsHistoricalCall({
    calltoolsCallId: 'provider-nonuuid-id',
    contactId: liveContext.providerIds.calltoolsContactId,
    config: callToolsConfig,
  })
  assert.equal(
    fallbackHistoricalCall.callRecordingFsFileId,
    '987654',
    'historical CallTools recording lookup falls back to scoped contact/campaign filters after a rejected provider call id',
  )
  assert.ok(
    requestedUrls.some((url) =>
      url.pathname.endsWith('/calls/') &&
      url.searchParams.get('contact_id') === '123' &&
      url.searchParams.get('web_call_back_id') === '21',
    ),
    'historical CallTools fallback query stays scoped to known contact and route metadata',
  )
  const directOutboundHistoricalCall = await readCallToolsHistoricalCall({
    to: '+15550001111',
    startedAt: '2026-07-02T15:01:00Z',
    config: callToolsConfig,
  })
  assert.equal(
    directOutboundHistoricalCall.callRecordingFsFileId,
    '888999',
    'historical CallTools direct outbound lookup finds recording by app user, destination, and nearest start time',
  )
  assert.ok(
    requestedUrls.some((url) =>
      url.pathname.endsWith('/calls/') &&
      url.searchParams.get('app_user_id') === 'agent-user-id' &&
      url.searchParams.get('destination') === '+15550001111' &&
      url.searchParams.get('start__date') === '2026-07-02',
    ),
    'historical CallTools direct outbound lookup uses app_user_id, destination, and start date',
  )
  const staleDirectOutboundHistoricalCall = await readCallToolsHistoricalCall({
    to: '+15550002222',
    startedAt: '2026-07-02T15:01:00Z',
    config: callToolsConfig,
  })
  assert.equal(
    staleDirectOutboundHistoricalCall,
    null,
    'historical CallTools direct outbound lookup rejects old recordings outside the start-time tolerance',
  )
  const staleScopedHistoricalCall = await readCallToolsHistoricalCall({
    calltoolsCallId: 'provider-nonuuid-id',
    contactId: liveContext.providerIds.calltoolsContactId,
    startedAt: '2026-07-02T16:30:00Z',
    config: callToolsConfig,
  })
  assert.equal(
    staleScopedHistoricalCall,
    null,
    'historical CallTools scoped fallback rejects stale contact/campaign recordings outside the start-time tolerance',
  )
  const unscopedHistoricalCall = await readCallToolsHistoricalCall({
    calltoolsCallId: 'wrong-calltools-call-id',
    config: { calltoolsAgentBinding: {} },
  })
  assert.equal(
    unscopedHistoricalCall,
    null,
    'historical recording lookup must not attach the newest CallTools recording without an exact id match or scoped fallback filters',
  )
  const readiness = await auditCallToolsReadiness({
    profile: {
      id: 'agent-config-calltools-default',
      name: 'calltools.default',
      config: {
        ...callToolsConfig,
        calltoolsAgentBinding: {
          ...callToolsConfig.calltoolsAgentBinding,
          liveFilterId: 'live-filter-id',
          callerIdStrategyId: 'strategy-id',
        },
      },
    },
    gatewayStatus: {
      connected: true,
      connectionCount: 1,
      status: 'registered',
      gateway: {
        profileId: 'agent-config-calltools-default',
        profileName: 'calltools.default',
        phoneId: 'phone-id',
        sampleRate: 16000,
      },
    },
  })
  assert.equal(readiness.ready, true)
  assert.equal(readiness.runtimeReady, true)
  assert.equal(readiness.campaignReady, true)
  assert.equal(
    readiness.binding.liveFilterId,
    'live-filter-id',
    'CallTools readiness must prefer the authoritative campaign detail over stale campaign-list metadata',
  )
  assert.equal(readiness.counts.dispositions, 6)
  assert.equal(readiness.counts.webCallbacks, 1)
  assert.equal(readiness.checks.find((check) => check.id === 'web-callback')?.status, 'ready')
  assert.equal(readiness.checks.find((check) => check.id === 'agent-session')?.status, 'ready')
  assert.equal(readiness.checks.find((check) => check.id === 'campaign-source')?.status, 'ready')
  assert.equal(
    readiness.checks.find((check) => check.id === 'campaign-source')?.proof.sourceKind,
    'live-filter',
  )
  assert.equal(
    readiness.checks.find((check) => check.id === 'agent-session')?.proof.webPhoneStatus,
    'Registered',
  )
  assert.equal(readiness.checks.find((check) => check.id === 'dispositions')?.status, 'ready')
  const readinessOutcomeCoverage =
    readiness.checks.find((check) => check.id === 'dispositions')?.proof.outcomeCoverage || []
  assert.equal(
    readinessOutcomeCoverage.find((item) => item.outcome === 'completed')?.dispositionName,
    'Customer Hang Up',
    'generic completion must use the neutral native disposition and never imply a sales goal',
  )
  assert.equal(
    readinessOutcomeCoverage.some((item) => item.outcome === 'voicemail'),
    false,
    'CallTools voicemail must not be part of disposition readiness because the native dialer filters it before agent handoff',
  )
  assert.equal(
    readinessOutcomeCoverage.find((item) => item.outcome === 'callback')?.dispositionName,
    'Call Back Scheduled',
    'readiness must prove the advertised callback disposition',
  )
  assert.equal(
    readinessOutcomeCoverage.find((item) => item.outcome === 'wrong-number')?.dispositionName,
    'Wrong Number',
    'readiness must prove the advertised wrong-number disposition',
  )
  assert.deepEqual(readiness.blockers, [])
  assert.equal(
    JSON.stringify(readiness).includes('must-not-leak'),
    false,
    'readiness proof must not expose CallTools phone credentials',
  )

  const healthyCallToolsFetch = globalThis.fetch
  const agentSessionRequests = []
  let agentSessionPatchBody = null
  let agentSessionPatched = false
  let campaignPatchBody = null
  let campaignPatched = false
  let campaignAgentPatchBody = null
  let campaignAgentPatched = false
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const method = (init.method || 'GET').toUpperCase()
    const body = inputBody(init) ? JSON.parse(inputBody(init)) : null
    agentSessionRequests.push({ method, pathname: url.pathname, body })
    if (url.pathname.endsWith('/statuses/')) {
      return jsonResponse({
        results: [
          {
            id: 43869,
            name: 'Ready',
            campaign_action: 'Set Ready',
            queue_action: 'Set Ready',
            agent_can_select: true,
          },
        ],
      })
    }
    if (url.pathname.endsWith('/agentstatuses/26066/')) {
      if (method === 'PATCH') {
        agentSessionPatched = true
        agentSessionPatchBody = body
        return jsonResponse({
          app_user: '26066',
          full_name: 'Speak Operator',
          ready: true,
          logged_in: campaignAgentPatched,
          campaign: body.campaign || null,
          campaign_name: 'Main Campaign',
          web_phone_status: body.web_phone_status,
          web_phone_registered_on: body.web_phone_registered_on,
          ps_endpoint_id: 'o26066_a26066_p39833',
          live_calls_count: 0,
        })
      }
      return jsonResponse({
        app_user: '26066',
        full_name: 'Speak Operator',
        ready: agentSessionPatched,
        logged_in: campaignAgentPatched,
        campaign: agentSessionPatched ? agentSessionPatchBody.campaign || null : '9301',
        campaign_name: 'Main Campaign',
        web_phone_status: agentSessionPatched ? agentSessionPatchBody.web_phone_status : 'Registered',
        web_phone_registered_on: agentSessionPatched
          ? agentSessionPatchBody.web_phone_registered_on
          : '2026-07-01T12:00:00Z',
        ps_endpoint_id: agentSessionPatched ? 'o26066_a26066_p39833' : '',
        live_calls_count: 0,
      })
    }
    if (url.pathname.endsWith('/campaigns/9301/')) {
      if (method === 'PATCH') {
        campaignPatched = true
        campaignPatchBody = body
      }
      return jsonResponse({
        id: '9301',
        name: 'Main Campaign',
        active: campaignPatched,
        originate_calls: campaignPatched,
        caller_id_strategy: 10,
      })
    }
    if (url.pathname.endsWith('/campaignagents/26066/')) {
      if (method === 'PATCH') {
        campaignAgentPatched = true
        campaignAgentPatchBody = body
      }
      return jsonResponse({
        app_user: '26066',
        full_name: 'Speak Operator',
        agent_status: 43869,
        campaign: campaignAgentPatched ? campaignAgentPatchBody.campaign : null,
        ready: campaignAgentPatched,
        ready_since: '2026-07-05T12:00:00Z',
      })
    }
    if (url.pathname.endsWith('/campaignstatuses/9301/')) {
      return jsonResponse({
        id: '9301',
        campaign: '9301',
        name: 'Main Campaign',
        active: campaignPatched,
        originate_calls: campaignPatched,
        logged_in_agents: campaignAgentPatched ? 1 : 0,
        waiting_agents: campaignAgentPatched ? 1 : 0,
        phone_call_agents: 0,
        post_call_wrap_up_agents: 0,
      })
    }
    throw new Error(`Unexpected mocked CallTools agent-session request: ${method} ${url.pathname}`)
  }
  const ensuredAgentSession = await ensureCallToolsAgentSessionReadiness({
    appUserId: '26066',
    campaignId: '9301',
    apply: true,
    requireCampaignReady: true,
  })
  globalThis.fetch = healthyCallToolsFetch
  assert.equal(ensuredAgentSession.ok, true)
  assert.equal(ensuredAgentSession.status, 'ready')
  assert.equal(ensuredAgentSession.requireCampaignReady, true)
  assert.equal(ensuredAgentSession.readinessMode, 'campaign-follow')
  assert.equal(ensuredAgentSession.applyRequested, true)
  assert.equal(ensuredAgentSession.mutationPerformed, true)
  assert.deepEqual(campaignPatchBody, { active: true, originate_calls: true })
  assert.deepEqual(campaignAgentPatchBody, { campaign: 9301, ready: true })
  assert.equal(ensuredAgentSession.campaignStart.ok, true)
  assert.equal(ensuredAgentSession.campaignStart.mutationPerformed, true)
  assert.equal(agentSessionPatchBody.ready, true)
  assert.equal(agentSessionPatchBody.agent_status, 43869)
  assert.equal(agentSessionPatchBody.campaign, 9301)
  assert.equal(agentSessionPatchBody.web_phone_status, 'Registered')
  assert.ok(agentSessionPatchBody.web_phone_registered_on)
  assert.notEqual(agentSessionPatchBody.web_phone_registered_on, '2026-07-01T12:00:00Z')
  assert.equal(ensuredAgentSession.after.webPhoneStatus, 'Registered')
  assert.equal(ensuredAgentSession.after.webPhoneRegisteredOn, agentSessionPatchBody.web_phone_registered_on)
  assert.equal(ensuredAgentSession.proof.loggedIn, true)
  assert.equal(ensuredAgentSession.proof.nativeLoggedIn, true)
  assert.equal(ensuredAgentSession.proof.campaignLoginProof, 'campaign_status_agent_counts')
  assert.equal(ensuredAgentSession.proof.campaignAgentProof, 'campaignagents_app_user_ready')
  assert.deepEqual(ensuredAgentSession.blockers, [])
  assert.deepEqual(
    agentSessionRequests.map((request) => `${request.method} ${request.pathname}`),
    [
      'GET /api/campaigns/9301/',
      'PATCH /api/campaigns/9301/',
      'GET /api/campaignstatuses/9301/',
      'GET /api/agentstatuses/26066/',
      'GET /api/statuses/',
      'PATCH /api/agentstatuses/26066/',
      'GET /api/agentstatuses/26066/',
      'GET /api/campaignagents/26066/',
      'GET /api/campaignstatuses/9301/',
      'PATCH /api/campaignagents/26066/',
      'GET /api/agentstatuses/26066/',
      'GET /api/campaignagents/26066/',
      'GET /api/campaignstatuses/9301/',
    ],
    'CallTools agent-session helper must use backend REST endpoints, not browser automation',
  )
  const noCallbackReadiness = await auditCallToolsReadiness({
    profile: {
      id: 'agent-config-calltools-default',
      name: 'calltools.default',
      config: {
        ...noCallbackConfig,
        calltoolsAgentBinding: {
          ...noCallbackConfig.calltoolsAgentBinding,
          liveFilterId: 'live-filter-id',
          callerIdStrategyId: 'strategy-id',
        },
      },
    },
    gatewayStatus: {
      connected: true,
      connectionCount: 1,
      status: 'registered',
      gateway: {
        profileId: 'agent-config-calltools-default',
        profileName: 'calltools.default',
        phoneId: 'phone-id',
        sampleRate: 16000,
      },
    },
  })
  assert.equal(noCallbackReadiness.runtimeReady, true)
  assert.equal(
    noCallbackReadiness.blockers.includes('CALLTOOLS_WEB_CALLBACK_ID'),
    false,
    'CallTools runtime readiness must not block on missing Web Callback ID',
  )
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (
      url.pathname.endsWith('/users/') ||
      url.pathname.endsWith('/campaigns/') ||
      url.pathname.endsWith('/queues/') ||
      url.pathname.endsWith('/callerids/') ||
      url.pathname.endsWith('/webcallbacks/') ||
      url.pathname.endsWith('/calldispositions/') ||
      url.pathname.endsWith('/agentstatuses/agent-user-id/') ||
      url.pathname.endsWith('/campaignagents/agent-user-id/') ||
      url.pathname.endsWith('/campaignstatuses/campaign-id/') ||
      url.pathname.endsWith('/livefilters/live-filter-id/')
    ) {
      return jsonResponse({ detail: 'CallTools upstream read timed out' }, 503)
    }
    if (url.pathname.endsWith('/phones/')) {
      return jsonResponse({
        results: [
          {
            id: 'phone-id',
            app_user: 'agent-user-id',
            name: 'Speak Example Phone',
            sip_uri: 'sip:operator@example.calltools.test',
            ws_url: 'wss://sip.calltools.test',
            is_webrtc: true,
          },
        ],
      })
    }
    if (url.pathname.endsWith('/livephonecalls/')) {
      return jsonResponse({ results: [] })
    }
    throw new Error(`Unexpected mocked CallTools outage request: ${url.pathname}`)
  }
  const outageReadiness = await auditCallToolsReadiness({
    profile: {
      id: 'agent-config-calltools-default',
      name: 'calltools.default',
      config: {
        ...callToolsConfig,
        calltoolsAgentBinding: {
          ...callToolsConfig.calltoolsAgentBinding,
          liveFilterId: 'live-filter-id',
          callerIdStrategyId: 'strategy-id',
        },
      },
    },
    gatewayStatus: {
      connected: true,
      connectionCount: 1,
      status: 'registered',
      gateway: {
        profileId: 'agent-config-calltools-default',
        profileName: 'calltools.default',
        phoneId: 'phone-id',
        healthy: true,
        stale: false,
        heartbeatStaleAfterMs: 15000,
        lastSeenAgeMs: 100,
      },
    },
  })
  const outageAgentUserCheck = outageReadiness.checks.find((check) => check.id === 'agent-user')
  const outageCampaignCheck = outageReadiness.checks.find((check) => check.id === 'campaign')
  const outageDispositionsCheck = outageReadiness.checks.find((check) => check.id === 'dispositions')
  assert.ok(
    outageAgentUserCheck?.blockers.includes('CALLTOOLS_USERS_READ_FAILED'),
    'CallTools user collection read failures must stay distinct from missing agent users',
  )
  assert.ok(
    !outageAgentUserCheck?.blockers.includes('CALLTOOLS_AGENT_USER_NOT_FOUND'),
    'CallTools user collection outages must not be reported as missing agent users',
  )
  assert.ok(
    outageCampaignCheck?.blockers.includes('CALLTOOLS_CAMPAIGNS_READ_FAILED'),
    'CallTools campaign collection read failures must stay distinct from missing campaigns',
  )
  assert.ok(
    !outageCampaignCheck?.blockers.includes('CALLTOOLS_CAMPAIGN_NOT_FOUND'),
    'CallTools campaign collection outages must not be reported as missing campaigns',
  )
  assert.ok(
    outageDispositionsCheck?.blockers.includes('CALLTOOLS_DISPOSITIONS_READ_FAILED'),
    'CallTools disposition read failures must be explicit readiness blockers',
  )
  assert.ok(
    !outageReadiness.blockers.includes('CALLTOOLS_AGENT_NOT_READY') &&
      !outageReadiness.blockers.includes('CALLTOOLS_AGENT_NOT_LOGGED_IN') &&
      !outageReadiness.blockers.includes('CALLTOOLS_AGENT_WEB_PHONE_NOT_REGISTERED') &&
      !outageReadiness.blockers.includes('CALLTOOLS_LIVE_FILTER_EMPTY'),
    'CallTools read failures must not invent native state or empty-inventory blockers',
  )
  assert.match(
    outageDispositionsCheck?.proof.readError || '',
    /upstream read timed out/i,
    'CallTools disposition read failures must include sanitized provider error proof',
  )
  assert.equal(outageReadiness.ready, false)
  assert.equal(outageReadiness.runtimeReady, false)
  globalThis.fetch = healthyCallToolsFetch

  const serverIndex = readFileSync('server/index.mjs', 'utf8')
  const dutyMonitorStart = serverIndex.indexOf('const callToolsDutyMonitor = createCallToolsDutyMonitor({')
  const dutyMonitorConstruction = serverIndex.slice(
    dutyMonitorStart,
    serverIndex.indexOf('\napp.use(', dutyMonitorStart),
  )
  const callStartRoute = serverIndex.match(/app\.post\('\/api\/calls\/start'[\s\S]*?\n\}\)/)?.[0] || ''
  assert.match(
    callStartRoute,
    /await resolveStartRuntimeConfig\(\{[\s\S]*?dialerProvider: 'speak'/,
    'direct live start resolves the saved voice profile while making the route-selected Speak transport authoritative',
  )
  assert.match(
    serverIndex,
    /async function resolveStartRuntimeConfig/,
    'server owns profile-aware start runtime config resolution',
  )
  assert.match(
    serverIndex,
    /source\.agentProfileId[\s\S]*listWorkspaceProfiles\(\)/,
    'profile-aware runtime config resolution can load saved profiles from agentProfileId',
  )
  assert.match(
    serverIndex,
    /calltoolsAgentBinding:\s*explicitBinding[\s\S]*profileConfig\.calltoolsAgentBinding/,
    'partial start config must not wipe saved CallTools binding',
  )
  assert.match(
    serverIndex,
    /normalizeCallToolsProviderId/,
    'CallTools communication metadata normalizes provider IDs',
  )
  assert.match(
    serverIndex,
    /\^calltools-\(\.\+\)\$/,
    'CallTools provider IDs strip Speak lead ID prefixes before persistence',
  )
  assert.match(
    callStartRoute,
    /calltools_direct_start_disabled[\s\S]*fetch\(`\$\{TELNYX_API_BASE\}\/calls`/,
    'CallTools is rejected while Telnyx outbound starts remain available',
  )
  const plannedOutcome = await reconcileCallToolsCallOutcome({
    outcome: 'no-answer',
    config: callToolsConfig,
    calltoolsContext: liveContext,
    lead: liveContext.lead,
    apply: false,
  })
  assert.equal(plannedOutcome.action, 'planned')
  assert.equal(plannedOutcome.mutationPerformed, false)
  assert.equal(
    plannedOutcome.disposition.name,
    'Contact not available',
    'no-answer must support the account neutral non-contact wording',
  )
  assert.equal(plannedOutcome.payload.disposition, 86568)
  assert.equal(plannedOutcome.payload.contact, 123)
  const unexpectedVoicemailOutcome = await reconcileCallToolsCallOutcome({
    outcome: 'voicemail',
    config: callToolsConfig,
    calltoolsContext: liveContext,
    lead: liveContext.lead,
    apply: false,
  })
  assert.equal(unexpectedVoicemailOutcome.action, 'blocked')
  assert.equal(unexpectedVoicemailOutcome.disposition, null)
  assert.ok(unexpectedVoicemailOutcome.blockers.includes('CALLTOOLS_DISPOSITION_NOT_FOUND'))
  const plannedCompletedOutcome = await reconcileCallToolsCallOutcome({
    outcome: 'completed',
    config: callToolsConfig,
    calltoolsContext: liveContext,
    lead: liveContext.lead,
    apply: false,
  })
  assert.equal(
    plannedCompletedOutcome.disposition.name,
    'Customer Hang Up',
    'generic completion must remain neutral instead of inventing a CallTools goal result',
  )
  const plannedCallbackOutcome = await reconcileCallToolsCallOutcome({
    outcome: 'callback',
    config: callToolsConfig,
    calltoolsContext: liveContext,
    lead: liveContext.lead,
    apply: false,
  })
  assert.equal(
    plannedCallbackOutcome.disposition.name,
    'Call Back Scheduled',
    'callback outcomes must not fall through to Customer Hang Up',
  )
  const plannedWrongNumberOutcome = await reconcileCallToolsCallOutcome({
    outcome: 'wrong-number',
    config: callToolsConfig,
    calltoolsContext: liveContext,
    lead: liveContext.lead,
    apply: false,
  })
  assert.equal(
    plannedWrongNumberOutcome.disposition.name,
    'Wrong Number',
    'wrong-number outcomes must not fall through to Customer Hang Up',
  )
  assert.equal(
    requestedUrls.some((url) => url.pathname.endsWith('/historicalcalldispositions/')),
    false,
    'dry-run outcome reconciliation must not mutate CallTools',
  )
  const appliedOutcome = await reconcileCallToolsCallOutcome({
    outcome: 'not-interested',
    config: callToolsConfig,
    calltoolsContext: liveContext,
    lead: liveContext.lead,
    apply: true,
    confirm: true,
  })
  assert.equal(appliedOutcome.mutationPerformed, true)
  assert.equal(appliedOutcome.record.id, 999)
  assert.equal(appliedOutcome.payload.disposition, 86569)
  assert.equal(
    requestedUrls.filter((url) => url.pathname.endsWith('/historicalcalldispositions/')).length,
    1,
    'confirmed outcome reconciliation creates exactly one historical disposition',
  )

  const contract = buildSpeakAgentContract()
  const agentContract = JSON.stringify(contract, null, 2)
  const dialerController = readFileSync('src/useDialerCallController.ts', 'utf8')
  const dialerRunControls = readFileSync('src/DialerRunControls.tsx', 'utf8')
  const appSource = readFileSync('src/App.tsx', 'utf8')
  const dialerReadModel = readFileSync('src/useDialerReadModel.ts', 'utf8')
  const agentManual = readFileSync('AGENTS.md', 'utf8')
  assert.doesNotMatch(
    readFileSync('server/calltools-duty-monitor.mjs', 'utf8'),
    /runDirectStartOperation/,
    'the duty monitor must not retain a dead one-shot CallTools start gate',
  )
  assert.equal(
    contract.dataSchemas?.profile?.properties?.config?.properties?.dialerProvider?.enum?.includes(
      'calltools',
    ),
    true,
    'agent contract exposes calltools dialer provider',
  )
  assert.ok(
    contract.dataSchemas?.profile?.properties?.config?.properties?.calltoolsAgentBinding,
    'agent contract exposes calltoolsAgentBinding',
  )
  assert.ok(
    contract.dataSchemas?.profile?.properties?.config?.properties?.calltoolsAgentBinding
      ?.properties?.webCallbackId,
    'agent contract exposes calltoolsAgentBinding.webCallbackId',
  )
  assert.equal(
    contract.dataSchemas?.lead?.properties?.source?.enum?.includes('calltools'),
    true,
    'agent contract exposes calltools contact source',
  )
  assert.equal(
    contract.dataSchemas?.lead?.properties?.source?.enum?.includes('personal-phone'),
    true,
    'agent contract exposes personal-phone contact source',
  )
  assert.ok(
    contract.backend.actions.some((action) => action.id === 'sync_calltools_campaign_contacts'),
    'agent contract exposes CallTools campaign contact sync',
  )
  assert.ok(
    contract.backend.actions.some((action) => action.id === 'read_calltools_campaign_contacts_status'),
    'agent contract exposes CallTools campaign contact status',
  )
  assert.ok(
    contract.backend.actions.some((action) => action.id === 'read_calltools_readiness'),
    'agent contract exposes CallTools readiness status',
  )

  const workspaceStore = readFileSync('server/workspace-store.mjs', 'utf8')
  assert.match(workspaceStore, /source === 'calltools'/, 'workspace preserves calltools contact source')
  const libraryWorkspace = readFileSync('src/LibraryWorkspace.tsx', 'utf8')
  const appCss = readFileSync('src/App.css', 'utf8')
  assert.match(libraryWorkspace, /calltools-favicon\.png/, 'Library uses official CallTools mark asset')
  assert.match(
    libraryWorkspace,
    /className="secondary-button library-calltools-action"[\s\S]*<CallToolsMark \/>/,
    'Library renders CallTools through the branded source action beside Personal Phone',
  )
  assert.match(
    libraryWorkspace,
    /className="secondary-button library-personal-phone-action"[\s\S]*syncPersonalPhoneContacts/,
    'Library renders Personal Phone as the first-party contact source action',
  )
  assert.match(libraryWorkspace, /\/calltools\/campaign-contacts\/sync/, 'Library can sync CallTools campaign contacts')
  const calltoolsContacts = readFileSync('server/calltools-contacts.mjs', 'utf8')
  assert.match(
    calltoolsContacts,
    /readPaginatedCallToolsContacts/,
    'CallTools campaign contact sync must use paginated source reads',
  )
  assert.match(
    calltoolsContacts,
    /CALLTOOLS_CONTACT_SYNC_MAX_PAGES/,
    'CallTools campaign contact sync must expose a bounded max-page override',
  )
  assert.match(
    calltoolsContacts,
    /enrichCallToolsContactsWithPhoneNumbers/,
    'CallTools campaign contact sync must enrich contacts with separate phone-number reads',
  )
  assert.match(
    calltoolsContacts,
    /\/phonenumbers\//,
    'CallTools campaign contact sync must read phone numbers when contact rows omit phone fields',
  )
  assert.match(
    calltoolsContacts,
    /CALLTOOLS_PHONE_NUMBER_SYNC_MAX_PAGES/,
    'CallTools phone-number enrichment must expose a bounded max-page override',
  )
  assert.match(
    calltoolsContacts,
    /live_filter_id/,
    'CallTools live-filter sync must query contacts by live filter',
  )
  assert.match(
    calltoolsContacts,
    /buckets__id/,
    'CallTools bucket sync must query contacts by bucket',
  )
  assert.doesNotMatch(
    calltoolsContacts,
    /page\s*<=\s*20/,
    'CallTools campaign contact sync must not cap bucket reads at 20 pages',
  )
  const phoneNumberRequests = []
  const enrichedContacts = await enrichCallToolsContactsWithPhoneNumbers(
    [
      { id: '123', first_name: 'Ada' },
      { id: '456', first_name: 'Grace', phone_number: '+15550002222' },
    ],
    {
      request: async (path, options = {}) => {
        phoneNumberRequests.push({ path, query: options.query || {} })
        assert.equal(path, '/phonenumbers/')
        return {
          count: 2,
          next: null,
          results: [
            {
              id: 'phone-number-id',
              contact: 123,
              phone_number: '+15550001111',
              do_not_contact: false,
            },
            {
              id: 'unrelated-phone-number-id',
              contact: 999,
              phone_number: '+15559999999',
              do_not_contact: false,
            },
          ],
        }
      },
    },
  )
  assert.equal(phoneNumberRequests.length, 1, 'phone enrichment uses paginated bulk reads')
  assert.equal(phoneNumberRequests[0].query.page, 1)
  assert.equal(enrichedContacts.contacts[0]._phone_numbers[0].phone_number, '+15550001111')
  assert.equal(enrichedContacts.contacts[1].phone_number, '+15550002222')
  assert.equal(enrichedContacts.readProof.phoneNumberHydratedContactCount, 1)
  assert.equal(enrichedContacts.readProof.phoneNumberMatchedContactCount, 1)
  assert.equal(enrichedContacts.readProof.phoneNumberMissingContactCount, 0)
  assert.ok(existsSync('src/assets/calltools-favicon.png'), 'CallTools mark asset exists')
  assert.equal(
    createHash('sha256').update(readFileSync('src/assets/calltools-favicon.png')).digest('hex'),
    CALLTOOLS_FAVICON_SHA256,
    `CallTools Library mark matches ${CALLTOOLS_FAVICON_SOURCE_URL}`,
  )
  assert.match(
    appCss,
    /\.library-action-row \.library-calltools-action[\s\S]*\.calltools-logo-mark\s*\{[\s\S]*background:\s*#fff/,
    'CallTools transparent favicon renders on a light plate in Library',
  )
  const speakSettingsPanel = readFileSync('src/SpeakSettingsPanel.tsx', 'utf8')
  assert.match(
    speakSettingsPanel,
    /mediaGatewayHealthyConnectionCount/,
    'settings rail consumes CallTools healthy gateway count',
  )
  assert.match(
    speakSettingsPanel,
    /webCallbacks/,
    'settings rail exposes CallTools Web callback route options',
  )
  assert.match(
    speakSettingsPanel,
    /apiUrl\('\/calltools\/options'\)/,
    'settings rail reads sanitized CallTools account options',
  )
  assert.match(
    speakSettingsPanel,
    /<span>CallTools phone<\/span>[\s\S]*value=\{calltoolsBinding\.phoneId \|\| ''\}[\s\S]*calltoolsOptions\.phones\.map/,
    'settings rail renders CallTools phone options from the account catalog',
  )
  assert.match(
    speakSettingsPanel,
    /const phone = calltoolsOptions\.phones\.find[\s\S]*phoneId: event\.target\.value[\s\S]*phoneSipUri: phone\?\.sipUri \|\| ''[\s\S]*phoneWebSocketUrl: phone\?\.webSocketUrl \|\| ''/,
    'settings rail persists selected CallTools phone SIP and WebSocket metadata',
  )
  assert.match(
    speakSettingsPanel,
    /formatCallToolsHeartbeatAge\(selectedCallToolsGateway\.lastSeenAgeMs\)/,
    'settings rail renders selected CallTools gateway heartbeat age',
  )
  assert.match(
    speakSettingsPanel,
    /selectedCallToolsGateway\.healthy[\s\S]*Healthy/,
    'settings rail labels healthy CallTools gateway registrations',
  )
  assert.match(
    speakSettingsPanel,
    /selectedCallToolsGateway\.stale[\s\S]*Stale/,
    'settings rail labels stale CallTools gateway registrations',
  )
  assert.match(
    appCss,
    /\.config-runtime small\s*\{[\s\S]*text-overflow:\s*ellipsis/,
    'CallTools gateway heartbeat detail fits inside the runtime grid',
  )
  const readinessCheck = readFileSync('scripts/check-calltools-readiness.mjs', 'utf8')
  const agentSessionHelper = readFileSync('scripts/ensure-calltools-agent-session.mjs', 'utf8')
  const fullE2eAudit = readFileSync('scripts/check-full-e2e-audit.mjs', 'utf8')
  const calltoolsClient = readFileSync('server/calltools-client.mjs', 'utf8')
  const calltoolsDutyMonitor = readFileSync('server/calltools-duty-monitor.mjs', 'utf8')
  const calltoolsSeatClaim = readFileSync('server/calltools-seat-claim.mjs', 'utf8')
  const activeCallTranscriptHook = readFileSync('src/useActiveCallTranscript.ts', 'utf8')
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
  assert.match(
    serverIndex,
    /app\.post\('\/api\/calltools\/verify-agent'[\s\S]{0,500}resolveCallToolsSourceProfileInput[\s\S]{0,1000}bindingResolution/,
    'CallTools verification resolves the workspace shared-seat binding while preserving selected voice identity proof',
  )
  assert.match(
    calltoolsClient,
    /selectedVoiceProfileId:[\s\S]{0,500}adoptedSharedBinding[\s\S]{0,500}bindingSourceProfileId:/,
    'shared-seat binding resolution reports selected voice profile and binding source independently',
  )
  assert.match(
    speakSettingsPanel,
    /bindingResolution\?\.adoptedSharedBinding !== true[\s\S]{0,800}workspace shared seat/,
    'Settings verification does not copy a shared-seat binding into the selected voice profile',
  )
  assert.ok(
    packageJson.scripts?.['calltools:agent-session'],
    'CallTools agent-session helper must be exposed',
  )
  assert.match(
    calltoolsClient,
    /bucketEffectiveCount/,
    'CallTools readiness uses effective source counts when bucket counters lag',
  )
  assert.match(
    calltoolsClient,
    /reportedCount:\s*bucketReportedCount/,
    'CallTools readiness exposes raw bucket reportedCount beside effective count',
  )
  assert.match(
    calltoolsClient,
    /readCallToolsSourceSelectableContacts/,
    'CallTools readiness must query source contacts directly when campaign status inventory lags',
  )
  assert.doesNotMatch(
    calltoolsClient,
    /Activate the selected CallTools Web Call Back route before live starts/,
    'CallTools readiness messaging must not imply Web Call Back is used for Speak live starts',
  )
  assert.match(
    calltoolsClient,
    /legacy contact-first callback helper; Speak live starts use the registered gateway/,
    'CallTools Web Call Back next action must preserve the gateway-first live-start contract',
  )
  assert.match(
    calltoolsClient,
    /live_filter_id/,
    'CallTools readiness must support direct live-filter contact selectability reads',
  )
  assert.match(
    calltoolsClient,
    /buckets__id/,
    'CallTools readiness must support direct bucket contact selectability reads',
  )
  assert.match(
    calltoolsClient,
    /campaignStatusSelectableContactCount/,
    'CallTools readiness must preserve raw campaign-status selectable count beside effective proof',
  )
  assert.match(
    calltoolsClient,
    /sourceSelectableContactCount/,
    'CallTools readiness must expose direct source selectable contact proof',
  )
  assert.match(
    calltoolsClient,
    /hydrateCallToolsContactForSelectability/,
    'CallTools readiness must hydrate source contact detail when list rows omit phone fields',
  )
  assert.match(
    calltoolsClient,
    /readCallToolsContact\(contact\.id(?:,\s*options)?\)/,
    'CallTools source selectability must use native contact detail proof before declaring a row phone-less',
  )
  assert.match(
    calltoolsClient,
    /\/contactbuckets\//,
    'CallTools lead preparation reads native ContactBucket membership as proof',
  )
  assert.match(
    calltoolsClient,
    /const campaignCheckIds = \['agent-session', 'campaign', 'caller-id', 'campaign-source'\]/,
    'CallTools campaignReady requires native agent session plus campaign inventory',
  )
  assert.match(
    agentContract,
    /For CallTools campaign sources,[\s\S]{0,420}establish_calltools_agent_session[\s\S]{0,420}activates\/originates the native campaign[\s\S]{0,320}without (?:browser|a human) login/,
    'Dialer start contract must establish the selected native campaign and agent session with one action',
  )
  const calltoolsFollowStart = dialerController.indexOf(
    "if (isContactSourceKeyForSource(contactSourceKey, 'calltools'))",
  )
  const voiceReadyStart = dialerController.indexOf('if (!voiceReady)', calltoolsFollowStart)
  assert.ok(calltoolsFollowStart >= 0 && voiceReadyStart > calltoolsFollowStart)
  const calltoolsFollowBranch = dialerController.slice(calltoolsFollowStart, voiceReadyStart)
  const calltoolsStopStart = dialerController.indexOf('async function stopCampaign()')
  const calltoolsStopEnd = dialerController.indexOf('async function skipToNext()', calltoolsStopStart)
  const calltoolsStopBranch = dialerController.slice(calltoolsStopStart, calltoolsStopEnd)
  const stopProofIndex = calltoolsStopBranch.indexOf('session.after?.ready !== false')
  const stopClearIndex = calltoolsStopBranch.indexOf('campaignRunningRef.current = false')
  const prepareAgentSessionIndex = serverIndex.indexOf(
    'const prepareAgentSession = targetReady && apply',
  )
  const persistSelectedProfileIndex = serverIndex.indexOf(
    'if (profile.id) await setActiveWorkspaceProfile(profile.id)',
    prepareAgentSessionIndex,
  )
  const activateGatewayIndex = serverIndex.indexOf(
    'gatewayRegistration = await setCallToolsGatewayRegistration(',
    prepareAgentSessionIndex,
  )
  const missingDutyLifecycleGuards = [
    [
      /const callConfig = refreshActiveAgentCallConfig[\s\S]{0,220}await refreshActiveAgentCallConfig\(\)[\s\S]{0,300}callConfig\.agentProfileId/.test(
        calltoolsFollowBranch,
      ),
      'CallTools availability refreshes and validates the authoritative selected profile before native mutation',
    ],
    [
      /const preferredActiveId =\s*effectiveActiveAgentProfileId \|\|[\s\S]{0,450}nextProfiles\.some\(\(profile\) => profile\.id === preferredActiveId\)[\s\S]{0,450}payload\.activeProfileId/.test(
        appSource,
      ),
      'profile refresh preserves the operator-selected or leased agent when it exists on the server',
    ],
    [
      /fetch\(apiUrl\('\/calltools\/agent-session'\),\s*\{[\s\S]{0,1200}body:\s*JSON\.stringify\(\{[\s\S]{0,500}profileId:\s*callConfig\.agentProfileId[\s\S]{0,500}mode:\s*'campaign-follow'[\s\S]{0,300}ready:\s*true[\s\S]{0,300}apply:\s*true[\s\S]{0,300}confirmAgentSession:\s*true[\s\S]{0,300}requireCampaignReady:\s*true/.test(
        calltoolsFollowBranch,
      ),
      'native agent-session start request',
    ],
    [
      prepareAgentSessionIndex >= 0 &&
        persistSelectedProfileIndex > prepareAgentSessionIndex &&
        activateGatewayIndex > persistSelectedProfileIndex,
      'Available persists the selected voice profile before activating the CallTools gateway',
    ],
    [
      /!readiness\.ready[\s\S]{0,300}!readiness\.runtimeReady[\s\S]{0,300}!readiness\.campaignReady[\s\S]{0,500}readiness\.dutyMonitor\?\.status !== 'on'[\s\S]{0,900}setCampaignRunning\(true\)/.test(
        calltoolsFollowBranch,
      ),
      'runtime, campaign, and backend duty proof before local on-duty state',
    ],
    [
      /catch \(error\)[\s\S]{0,1200}fetch\(apiUrl\('\/dialer-state'\)\)[\s\S]{0,1200}duty\.leaseId[\s\S]{0,1200}campaignRunningRef\.current = dutyActive/.test(
        calltoolsFollowBranch,
      ) && !calltoolsFollowBranch.includes('rollbackResponse'),
      'failed or conflicting enable reads the server-owned lease without disarming another tab',
    ],
    [
      /fetch\(apiUrl\('\/calltools\/agent-session'\),\s*\{[\s\S]{0,1200}body:\s*JSON\.stringify\(\{[\s\S]{0,500}profileId:\s*callToolsDuty\?\.profileId[\s\S]{0,500}mode:\s*'paused'[\s\S]{0,300}ready:\s*false[\s\S]{0,300}apply:\s*true[\s\S]{0,300}confirmAgentSession:\s*true/.test(
        calltoolsStopBranch,
      ),
      'native agent-session stop request',
    ],
    [
      /expectedLeaseId:\s*callToolsDuty\?\.leaseId[\s\S]{0,500}appUserId:\s*callToolsDuty\?\.binding\?\.appUserId[\s\S]{0,500}campaignId:\s*callToolsDuty\?\.binding\?\.campaignId[\s\S]{0,500}phoneId:\s*callToolsDuty\?\.binding\?\.phoneId/.test(
        calltoolsStopBranch,
      ),
      'Unavailable submits the exact observed lease and frozen binding',
    ],
    [
      stopProofIndex >= 0 && stopClearIndex > stopProofIndex,
      'failed disarm preserves local on-duty state',
    ],
    [
      /if \(isContactSourceKeyForSource\(contactSourceKey, 'calltools'\)\) return[\s\S]{0,500}scheduleNextCampaignCallRef\.current\?\./.test(
        dialerController,
      ),
      'CallTools follow bypasses local queue auto-advance',
    ],
    [
      /\(!campaignRunning && !calltoolsFollowMode\)[\s\S]{0,120}\(activeCall && isActiveCallLive\(activeCall\)\)/.test(
        appSource,
      ) &&
        /call\.callControlId === activeCall\.callControlId\) return false/.test(appSource) &&
        /const mirroredCallToolsCalls = useMemo[\s\S]{0,700}call\.provider !== 'calltools'[\s\S]{0,700}calltoolsCampaignId/.test(
          appSource,
        ),
      'ended active CallTools call is replaced only by a different call from the selected native campaign',
    ],
    [
      ['Go available', 'Enabling', 'Go unavailable'].every((label) =>
        dialerRunControls.includes(`'${label}'`),
      ),
      'CallTools Go available / Enabling / Go unavailable copy',
    ],
    [
      dialerController.includes('Available for CallTools campaign calls') &&
        dialerController.includes('Unavailable for CallTools campaign calls') &&
        appSource.includes('Available for CallTools campaign calls') &&
        appSource.includes('Unavailable for CallTools campaign calls') &&
        !/On duty|Off duty/.test(`${dialerController}\n${dialerRunControls}\n${appSource}`),
      'CallTools Dialer status uses native Available / Unavailable terminology everywhere',
    ],
    [
      /const mirroredCallToolsCalls = useMemo[\s\S]{0,900}call\.provider !== 'calltools'[\s\S]{0,900}calltoolsCampaignId/.test(
        appSource,
      ) &&
        /if \(!callCampaignId\) return isLiveRecentCall\(call\)/.test(appSource) &&
        /const dialerFilteredLeads =[\s\S]{0,900}calltoolsFollowMode[\s\S]{0,900}mirroredCallToolsCalls[\s\S]{0,900}callMatchesLead/.test(
          appSource,
        ),
      'CallTools Dialer mirrors only calls captured from the selected native campaign',
    ],
    [
      /async function syncCallToolsAvailabilityProof[\s\S]{0,1200}\/calltools\/readiness[\s\S]{0,1800}leaseActive[\s\S]{0,500}callToolsDutyIsActive\(readiness\.dutyMonitor\)[\s\S]{0,700}setCampaignRunning\(leaseActive\)/.test(
        appSource,
      ),
      'Dialer renders the persisted backend Available lease instead of transient readiness',
    ],
    [
      /!campaignRunning && !calltoolsFollowMode/.test(appSource) &&
        /const liveCall = \(calltoolsFollowMode \? mirroredCallToolsCalls : recentCalls\)\.find/.test(
          appSource,
        ),
      'Dialer recovers a matching native CallTools live call without requiring a local duty lease',
    ],
    [
      /resolveCallToolsLiveCallContextWithRetry[\s\S]{0,1800}setTimeout[\s\S]{0,1000}resolveCallToolsLiveCallContext[\s\S]{0,1000}calltoolsContext\?\.liveCall/.test(
        serverIndex,
      ),
      'CallTools invite context retries until the native live-call contact becomes visible',
    ],
    [
      /const currentProfile =\s*registeredProfile \|\|/.test(serverIndex) &&
        /runtimeConfig = normalizeCampaignConfig\(\s*withCallToolsRuntimeIdentity\(profile\)/.test(
          serverIndex,
        ) &&
        /const initialLead = normalizeLead\(\s*callToolsGatewayLead\(/.test(serverIndex) &&
        !/const initialRuntimeContext = await resolveWorkspaceRuntimeSnapshot/.test(serverIndex),
      'CallTools SIP answer hot path reuses the registered profile identity and defers workspace context hydration',
    ],
    [
      /Dialer CallTools availability[\s\S]{0,500}\/api\/calltools\/agent-session[\s\S]{0,900}Available is latched[\s\S]{0,700}unregisters Speak's SIP endpoint/.test(
        agentManual,
      ),
      'CallTools latched availability and shared-seat SIP handoff documentation',
    ],
  ]
    .filter(([present]) => !present)
    .map(([, label]) => label)
  assert.deepEqual(
    missingDutyLifecycleGuards,
    [],
    'Dialer CallTools duty lifecycle is missing required native start/stop and successive-call guards',
  )
  assert.match(
    calltoolsFollowBranch,
    /apiUrl\(`\/calltools\/readiness/,
    'Dialer follow mode must read CallTools backend readiness before enabling follow state',
  )
  assert.match(
    calltoolsFollowBranch,
    /setCampaignQueueIds\(\[\]\)/,
    'Dialer follow mode must not create a Speak-owned contact queue for CallTools sources',
  )
  assert.doesNotMatch(
    calltoolsFollowBranch,
    /startCall\(|campaignSourceLeads\(/,
    'Dialer follow mode must not start Speak-owned calls or local queues for CallTools sources',
  )
  assert.match(
    dialerRunControls,
    /const calltoolsFollowMode = isContactSourceKeyForSource\([\s\S]{0,260}contactSourceKeyFromDialerSourceId\(dialerSourceId\)[\s\S]{0,1200}\? 'Go available'[\s\S]{0,700}Start the selected CallTools campaign and make this agent Available/,
    'Dialer Go action must describe its one-click native campaign and availability behavior',
  )
  assert.match(
    appCss,
    /\.dialer-run-button\.calltools-follow-mode\s+span\s*\{[\s\S]{0,180}display:\s*inline/,
    'CallTools availability action must keep its text visible beside the ambiguous phone icon',
  )
  assert.match(
    speakSettingsPanel,
    /async function selectDialerProvider[\s\S]{0,1200}\/dialer-state[\s\S]{0,1800}dutyActive[\s\S]{0,800}duty\?\.profileId === selectedProfileId[\s\S]{0,1200}\/calltools\/agent-session/,
    'Settings reads the durable assignment and releases native state only for the selected leased profile',
  )
  assert.match(
    speakSettingsPanel,
    /expectedLeaseId:\s*duty\.leaseId[\s\S]{0,500}profileId:\s*duty\.profileId[\s\S]{0,500}appUserId:\s*duty\.binding\?\.appUserId[\s\S]{0,500}campaignId:\s*duty\.binding\?\.campaignId[\s\S]{0,500}phoneId:\s*duty\.binding\?\.phoneId/,
    'Settings provider switch releases only the exact observed lease and frozen binding',
  )
  assert.match(
    speakSettingsPanel,
    /else if \(dutyActive\)[\s\S]{0,500}assignment was not changed[\s\S]{0,500}else \{[\s\S]{0,300}No active CallTools assignment/,
    'Settings provider switch leaves another profile lease untouched and skips native mutation when no lease is active',
  )
  assert.match(
    appSource,
    /const \[campaignStatus, setCampaignStatus\] = useState[\s\S]{0,160}const \[notice, setNotice\] = useState/,
    'Dialer must retain duty status and notices for visible operator proof',
  )
  assert.match(
    appSource,
    /const controlStatusText =[\s\S]{0,900}notice \|\| campaignStatus/,
    'Dialer must render backend duty success and failure notices when idle',
  )
  assert.match(
    activeCallTranscriptHook,
    /transcriptCallIdRef[\s\S]{0,500}activeCallControlId[\s\S]{0,500}setTranscript\(\[\]\)/,
    'Dialer must clear the live transcript when a different CallTools call attaches',
  )
  assert.match(
    dialerReadModel,
    /!activeCallIsLive \|\| call\.callControlId !== activeCall\?\.callControlId/,
    'Dialer must not render the active live call again as historical call content',
  )
  assert.match(
    appSource,
    /syncCallToolsAvailabilityProof[\s\S]{0,1800}\/calltools\/readiness[\s\S]{0,2200}leaseActive[\s\S]{0,700}setCampaignRunning\(leaseActive\)/,
    'Dialer must render the durable backend Available lease across navigation and refresh',
  )
  assert.match(
    serverIndex,
    /const callToolsDutyMonitor = createCallToolsDutyMonitor\([\s\S]{0,2400}readCallToolsDutyStatus/,
    'Voice backend must run the CallTools duty monitor independently of the Dialer tab',
  )
  assert.ok(
    sourceBetween(
      serverIndex,
      'server.listen(PORT',
      "for (const signal of ['SIGTERM', 'SIGINT'])",
    ).includes('callToolsDutyMonitor.start()') &&
      sourceBetween(
        serverIndex,
        'async function shutdownVoiceBackend',
        '\nfunction beginHttpServerShutdown',
      ).includes('callToolsDutyMonitor.stop()'),
    'Voice backend must start and quiesce the duty monitor with the service lifecycle',
  )
  assert.match(
    serverIndex,
    /setCallToolsGatewayRegistration[\s\S]{0,8000}gateway\.registration\.set/,
    'backend must coordinate explicit SIP registration ownership for the shared human and Speak account',
  )
  assert.doesNotMatch(
    sourceBetween(
      serverIndex,
      'async function setCallToolsGatewayRegistration',
      '\nfunction callToolsGatewayEntryHealthy',
    ),
    /if \(!selectedSocket\)[\s\S]{0,240}return \{ enabled: false, ok: true, connected: false \}/,
    'missing gateway control must never be treated as proven SIP release',
  )
  assert.match(
    sourceBetween(
      serverIndex,
      'async function setCallToolsGatewayRegistration',
      '\nfunction callToolsGatewayEntryHealthy',
    ),
    /gatewayOwnerInstanceId[\s\S]{0,2200}calltools_gateway_registration_ambiguous[\s\S]{0,3600}duplicateGateways[\s\S]{0,900}Promise\.all/,
    'enable claims one durable gateway owner, releases duplicates, and waits for acknowledgements',
  )
  assert.match(serverIndex, /gateway\.registration\.changed/, 'backend records gateway registration acknowledgements')
  assert.match(
    dutyMonitorConstruction,
    /arm:\s*async[\s\S]{0,1400}assertCallToolsSeatClaimAvailable[\s\S]{0,500}setCallToolsGatewayRegistration\([\s\S]{0,350}true[\s\S]{0,1000}bindCallToolsGatewayToProfile[\s\S]{0,1200}ready:\s*true/,
    'the durable Available transaction must prove shared-seat ownership before claiming and binding SIP',
  )
  assert.match(
    serverIndex,
    /preflightAgentSession[\s\S]{0,500}assertCallToolsSeatClaimAvailable[\s\S]{0,2200}preflight:\s*preflightAgentSession/,
    'initial Available must prove the shared human seat is free before persisting a lease',
  )
  assert.match(
    sourceBetween(
      serverIndex,
      'function prepareCallToolsStandbyVoiceSession',
      '\nfunction ensureCallToolsStandbyVoiceSession',
    ),
    /prepareProvisionalVoiceSession\([\s\S]{0,500}connectImmediately:\s*true/,
    'CallTools Available must preconnect the selected voice provider so the caller is not waiting on session startup',
  )
  assert.match(
    sourceBetween(
      serverIndex,
      'function prepareCallToolsGatewayState',
      '\nfunction attachPreparedCallToolsGatewayState',
    ),
    /state\.callProvider = 'calltools'[\s\S]{0,5000}connectVoiceSession\(state\)/,
    'CallTools must connect the voice provider during native invite preparation before the human bridge',
  )
  assert.match(
    calltoolsSeatClaim,
    /gatewayStatus\?\.connected === true[\s\S]{0,300}sipRegistered === true/,
    'seat claiming must allow a matching healthy Speak gateway to rearm',
  )
  assert.match(
    calltoolsSeatClaim,
    /calltools_native_seat_state_unproven[\s\S]{0,1200}calltools_human_seat_active/,
    'seat claiming must fail closed on unreadable or active native state',
  )
  assert.match(
    dutyMonitorConstruction,
    /disarm:\s*async[\s\S]{0,1200}ready:\s*false[\s\S]{0,1200}setCallToolsGatewayRegistration\([\s\S]{0,350}false/,
    'the monitored Unavailable transaction must prove native release and SIP release together',
  )
  assert.match(
    serverIndex,
    /if \(!targetReady && isActiveCallToolsDuty\(persistedDuty\)\)\s*\{[\s\S]{0,240}assertCallToolsDutyReleaseScope\(persistedDuty, request\.body \|\| \{\}\)/,
    'active CallTools lease release must always require exact lease/profile/app-user/campaign/phone scope',
  )
  assert.match(
    calltoolsDutyMonitor,
    /!targetReady && activeLease && !expectedLeaseId[\s\S]{0,300}calltools_duty_release_scope_incomplete[\s\S]{0,700}!targetReady && !activeLease[\s\S]{0,1000}provesCallToolsSeatAlreadyUnavailable[\s\S]{0,500}calltools_duty_release_requires_active_lease/,
    'every native Unavailable mutation requires the exact active Speak lease while off state is read-only and fail-closed',
  )
  assert.match(
    serverIndex,
    /proveUnavailable:\s*!targetReady[\s\S]{0,400}readCallToolsDutyStatus\([\s\S]{0,250}includeSeatClaimProof:\s*true/,
    'off-state Unavailable idempotency must use full provider seat proof without a native mutation',
  )
  assert.match(
    serverIndex,
    /apply && !targetReady && releasingActiveDuty[\s\S]{0,120}callToolsVoiceStandby\.cancel\('unavailable'\)/,
    'a replayed off-state Unavailable request must not cancel unrelated voice standby state',
  )
  assert.doesNotMatch(
    sourceBetween(dutyMonitorConstruction, 'disarm: async', '\n  intervalMs:'),
    /resolveCallToolsSourceProfileInput/,
    'frozen release must not depend on the leased profile still existing',
  )
  assert.doesNotMatch(
    serverIndex,
    /targetReady && !isCallToolsDialer\(selectedProfile\.config \|\| \{\}\)[\s\S]{0,500}calltools_runtime_disabled/,
    'CallTools availability must adapt the selected voice profile to the shared seat instead of requiring a stripped CallTools-only profile',
  )
  const calltoolsTransportIdentity = sourceBetween(
    serverIndex,
    'function isCallToolsGatewayCall(state)',
    '\nasync function pauseVoiceAssistant',
  )
  assert.doesNotMatch(
    calltoolsTransportIdentity,
    /config\?\.dialerProvider/,
    'live CallTools transport identity must come from the active session, not the saved agent profile',
  )
  assert.match(
    calltoolsTransportIdentity,
    /callProvider === 'calltools'[\s\S]{0,180}Boolean\(state\?\.calltoolsWs\)/,
    'live CallTools transport identity must use provider or socket proof',
  )
  const callHistory = readFileSync('server/call-history.mjs', 'utf8')
  assert.doesNotMatch(
    callHistory,
    /callProvider \|\| state\??\.config\?\.dialerProvider/,
    'persisted call provider identity must not fall back to an agent profile default',
  )
  const directDialerStart = sourceBetween(
    dialerController,
    'async function startCall(',
    '\n  async function endHistoryCall',
  )
  assert.match(
    directDialerStart,
    /const directCallConfig = \{[\s\S]{0,180}\.\.\.callConfig[\s\S]{0,180}dialerProvider: 'speak'[\s\S]{0,450}config: directCallConfig/,
    'a Speak/Telnyx Dialer source must adapt any selected voice profile to the direct-call transport',
  )
  const directStartRoute = sourceBetween(
    serverIndex,
    "app.post('/api/calls/start'",
    "\napp.post('/api/calls/:callControlId/end'",
  )
  assert.match(
    directStartRoute,
    /resolveStartRuntimeConfig\(\{[\s\S]*?\.\.\.\(config[\s\S]*?dialerProvider: 'speak'/,
    'the direct-call API must adapt any saved voice profile to Speak/Telnyx instead of treating its stored dialer default as a runtime restriction',
  )
  assert.doesNotMatch(
    speakSettingsPanel,
    /personalPhoneInbound\.enabled && dialerProvider === 'speak'|dialerProvider !== 'speak' \|\|[\s\S]{0,220}personalPhoneInbound/,
    'Personal Phone eligibility controls must not be gated by the agent profile dialer default',
  )
  assert.doesNotMatch(
    calltoolsClient,
    /applySharedCallToolsDutyBinding[\s\S]{0,1200}operator\.speak/,
    'shared CallTools binding resolution must not privilege a hard-coded agent name',
  )
  assert.doesNotMatch(
    serverIndex,
    /resolveCallToolsSourceProfileInput[\s\S]{0,1200}operator\.speak/,
    'CallTools profile resolution must use the selected or active profile, not calltools.default',
  )
  assert.match(
    serverIndex,
    /campaignFollow:\s*requireCampaignReady\s*\|\|\s*mode === 'campaign-follow'/,
    'all campaign-readiness starts must create the durable backend Available lease',
  )
  const directCallStartRoute = sourceBetween(
    serverIndex,
    "app.post('/api/calls/start'",
    "\napp.post('/api/calls/:callControlId/end'",
  )
  assert.match(
    sourceBetween(directCallStartRoute, 'runtimeConfig = await resolveStartRuntimeConfig', 'ensureVoiceProviderConfigReady'),
    /isCallToolsDialer[\s\S]{0,500}calltools_direct_start_disabled/,
    'direct CallTools starts must fail before voice-provider reconciliation or any provider mutation',
  )
  assert.doesNotMatch(
    directCallStartRoute,
    /runDirectStartOperation|type:\s*'call\.dial'|calltoolsPendingStarts|callToolsPreProvenPausedDirectStartRequested/,
    'the disabled CallTools branch must not retain unreachable direct-dial infrastructure',
  )
  assert.match(
    directCallStartRoute,
    /fetch\(`\$\{TELNYX_API_BASE\}\/calls`/,
    'Telnyx outbound starts must remain implemented after the CallTools rejection',
  )
  assert.match(
    sourceBetween(
      serverIndex,
      'async function createCallToolsGatewayState',
      '\nfunction callToolsGatewayLead',
    ),
    /readWorkspaceCallToolsDuty[\s\S]{0,900}callToolsDutyAcceptsGatewayCall[\s\S]{0,600}calltools_duty_lease_required/,
    'an inbound campaign gateway call must require the matching frozen Available lease',
  )
  assert.match(
    sourceBetween(
      serverIndex,
      "app.get('/api/calltools/gateway-config'",
      "app.post('/api/calls/start'",
    ),
    /activeDuty\s*\?\s*normalizeDutyBinding\(duty\.binding\)/,
    'gateway restart must use the frozen lease binding instead of mutable profile binding',
  )
  assert.match(
    calltoolsDutyMonitor,
    /campaignActive === false[\s\S]{0,300}originateCalls === false[\s\S]{0,500}rearmLease/,
    'Backend duty monitor must retain Available and reconcile CallTools campaign drift',
  )
  assert.match(
    workspaceStore,
    /delete patch\.calltoolsDuty[\s\S]{0,1400}next\.campaignRunning = false/,
    'Client dialer-state writes must not replace or resurrect server-owned CallTools duty',
  )
  assert.match(
    calltoolsClient,
    /ensureCallToolsAgentSessionReadiness/,
    'CallTools agent readiness must be establishable through a backend API helper',
  )
  assert.doesNotMatch(
    serverIndex,
    /CALLTOOLS_PENDING_START_TTL_MS|calltoolsPendingStarts|registerCallToolsPendingStart|takeMatchingCallToolsPendingStart|calltoolsPendingStart|pendingStartMatched|callToolsPreProvenPausedDirectStartRequested/,
    'one-shot pending CallTools start state must be fully removed',
  )
  assert.match(
    calltoolsClient,
    /CALLTOOLS_AGENT_SESSION_BACKEND_PROOF/,
    'CallTools agent-session readiness must expose backend/headless proof metadata',
  )
  assert.match(
    calltoolsClient,
    /establishPath:\s*'agentstatuses\.patch'/,
    'CallTools agent-session readiness must declare the AgentStatus PATCH establishment path',
  )
  assert.match(
    calltoolsClient,
    /proofSources:\s*\[[\s\S]*'agentstatuses\.read'[\s\S]*'campaignagents\.read'[\s\S]*'campaignstatuses\.read'/,
    'CallTools agent-session readiness must declare the native backend proof sources',
  )
  assert.match(
    calltoolsClient,
    /\/agentstatuses\/\$\{encodeURIComponent\(targetAppUserId\)\}\//,
    'CallTools backend readiness helper must patch native AgentStatus directly',
  )
  assert.match(
    calltoolsClient,
    /\/campaignagents\/\$\{encodeURIComponent\(targetAppUserId\)\}\/[\s\S]{0,220}method:\s*'PATCH'/,
    'CallTools backend readiness helper must establish the selected native campaign-agent session',
  )
  assert.match(
    calltoolsClient,
    /campaignAgentMutationEndpoint|CALLTOOLS_CAMPAIGN_AGENT_STATUS_PATCH_FAILED|campaignAgentPatchError/,
    'CallTools agent-session proof must report campaign-agent login mutation failures',
  )
  assert.match(
    calltoolsClient,
    /const patch = \{ active: true, originate_calls: true \}/,
    'Go available must activate and originate the frozen native CallTools campaign',
  )
  assert.match(
    calltoolsClient,
    /\/campaigns\/\$\{encodeURIComponent\(targetCampaignId\)\}\/[\s\S]{0,260}method:\s*'PATCH'/,
    'Go available must start the selected CallTools campaign through its native backend API',
  )
  assert.match(
    calltoolsClient,
    /CALLTOOLS_AGENT_SESSION_PATCH_TIMEOUT_MS/,
    'CallTools backend readiness helper must give native AgentStatus PATCH its own timeout',
  )
  assert.match(
    calltoolsClient,
    /timeoutMs:\s*requestOptions\.agentSessionPatchTimeoutMs/,
    'CallTools backend readiness helper must not use the short read timeout for AgentStatus PATCH',
  )
  assert.match(
    calltoolsClient,
    /patchMs:\s*requestOptions\.agentSessionPatchTimeoutMs/,
    'CallTools backend readiness helper must expose sanitized AgentStatus PATCH timeout proof',
  )
  assert.match(
    calltoolsClient,
    /web_phone_status:\s*safeLeadText\(webPhoneStatus\) \|\| 'Registered'/,
    'CallTools backend readiness helper must register the native web phone status through the API',
  )
  assert.match(
    calltoolsClient,
    /\/campaignagents\/\$\{encodeURIComponent\(id\)\}\//,
    'CallTools backend readiness proof must read the per-agent campaign status endpoint',
  )
  assert.match(
    calltoolsClient,
    /campaignAgentProof:\s*campaignAgentReady \? 'campaignagents_app_user_ready'/,
    'CallTools readiness must require per-agent campaign readiness before accepting aggregate login proof',
  )
  assert.match(
    calltoolsClient,
    /campaignLoginProof:\s*campaignLoginProof \? 'campaign_status_agent_counts'/,
    'CallTools readiness must accept backend campaign aggregate proof only after per-agent campaign proof',
  )
  assert.match(
    calltoolsClient,
    /const ready = runtimeReady && campaignReady/,
    'CallTools top-level readiness requires both runtime and native campaign readiness',
  )
  assert.match(
    calltoolsClient,
    /CALLTOOLS_AGENT_WEB_PHONE_NATIVE_SESSION_MISSING/,
    'CallTools campaign readiness requires native webPhoneRegisteredOn proof',
  )
  assert.match(
    calltoolsClient,
    /CALLTOOLS_USERS_READ_FAILED/,
    'CallTools readiness preserves user-list read failures instead of false not-found blockers',
  )
  assert.match(
    calltoolsClient,
    /CALLTOOLS_DISPOSITIONS_READ_FAILED/,
    'CallTools readiness preserves disposition read failures instead of false missing-disposition blockers',
  )
  assert.match(
    readinessCheck,
    /readinessFailureSummary/,
    'strict CallTools readiness failures must include actionable native session proof',
  )
  assert.match(
    readinessCheck,
    /agentSession\.webPhoneRegisteredOn/,
    'strict CallTools readiness failures must report native webPhoneRegisteredOn proof',
  )
  assert.match(
    readinessCheck,
    /agent-session proof must declare backendOnly=true/,
    'CallTools readiness verifier must reject non-backend agent-session proof',
  )
  assert.match(
    readinessCheck,
    /agent-session proof must not require browser automation/,
    'CallTools readiness verifier must reject browser-based agent-session proof',
  )
  assert.match(
    readinessCheck,
    /agentstatuses\.read/,
    'CallTools readiness verifier must require native AgentStatus read proof',
  )
  assert.match(
    readinessCheck,
    /nextAction=/,
    'strict CallTools readiness failures must preserve the backend next action',
  )
  assert.doesNotMatch(
    readinessCheck,
    /agent-config-calltools-default/,
    'CallTools readiness verifier must not default normal operation to one saved profile',
  )
  assert.match(
    readinessCheck,
    /adoptResolvedCallToolsProfileId/,
    'CallTools readiness verifier must adopt the backend-selected active profile before mutation',
  )
  assert.match(
    readinessCheck,
    /searchParams\.set\('profileId'/,
    'CallTools readiness verifier must pin profileId on the readiness endpoint',
  )
  assert.match(
    readinessCheck,
    /ensureCallToolsAgentSessionReadiness/,
    'CallTools readiness verifier must establish readiness through the backend AgentStatus helper',
  )
  assert.match(
    readinessCheck,
    /api\/calltools\/agent-session/,
    'CallTools readiness verifier must establish readiness through the backend agent-session route',
  )
  assert.match(
    readinessCheck,
    /confirmAgentSession:\s*apply/,
    'CallTools readiness verifier must explicitly confirm backend AgentStatus mutations',
  )
  assert.match(
    readinessCheck,
    /assertHeadlessAgentSessionHelper/,
    'CallTools readiness verifier must statically reject browser/dashboard agent-session helpers',
  )
  assert.match(
    readinessCheck,
    /const ensureAgentSession =[\s\S]*requireReady/,
    'CallTools readiness verifier must tie backend AgentStatus establishment to --require-ready',
  )
  assert.match(
    readinessCheck,
    /assertHeadlessReadinessVerifier\(\)/,
    'CallTools readiness verifier must statically prove its own backend/headless execution path',
  )
  assert.match(
    readinessCheck,
    /shouldPollAfterAgentSessionEnsure/,
    'CallTools readiness verifier must poll final readiness after a backend AgentStatus mutation or timeout-shaped patch result',
  )
  assert.match(
    readinessCheck,
    /result\?\.patchError/,
    'CallTools readiness verifier must keep polling when CallTools accepts AgentStatus PATCH slower than the backend route timeout',
  )
  assert.match(
    readinessCheck,
    /agentSessionEnsure\.patchError=/,
    'strict CallTools readiness failures must report native AgentStatus PATCH errors',
  )
  assert.match(
    readinessCheck,
    /agentSessionEnsure\.campaignAgentPatchError=/,
    'strict CallTools readiness failures must report native campaign-agent PATCH errors',
  )
  assert.match(
    readinessCheck,
    /pauseAfterReady/,
    'CallTools readiness verifier must support pausing native AgentStatus after strict non-live readiness proof',
  )
  assert.match(
    readinessCheck,
    /agentSessionFinalPause/,
    'CallTools readiness verifier must report the backend AgentStatus pause performed after strict proof',
  )
  assert.match(
    readinessCheck,
    /pause-after-ready must leave native AgentStatus not-ready after proving readiness/,
    'CallTools readiness verifier must fail closed if final backend pause proof is missing',
  )
  assert.match(
    readinessCheck,
    /agentSessionFinalPause\.status=/,
    'strict CallTools readiness failures must report the final native pause result',
  )
  assert.match(
    readinessCheck,
    /finalReadiness\.agentSession\.ready=/,
    'strict CallTools readiness failures must report the final native ready state',
  )
  assert.doesNotMatch(
    readinessCheck,
    /prepareProofContact|api\/calltools\/prepare-lead|ensureProofContact|CALLTOOLS_PROOF_CONTACT_PHONE|VAPI_DEMO_CONTACT_PHONE/,
    'strict CallTools readiness must never mutate or synthesize proof-contact inventory',
  )
  for (const pattern of [
    /\bfrom\s+['"]playwright['"]/i,
    /\bimport\(['"]playwright['"]\)/i,
    /\bchromium\.launch\b/i,
    /\bfirefox\.launch\b/i,
    /\bwebkit\.launch\b/i,
    /\blaunchPersistentContext\b/,
    /\bpage\.goto\b/,
    /\bpage\.locator\b/,
    /\bgrantPermissions\b/,
    /\bprocess\.env\.CALLTOOLS_AGENT_SESSION_PASSWORD\b/,
  ]) {
    assert.doesNotMatch(
      readinessCheck,
      pattern,
      `CallTools readiness verifier must not depend on browser/dashboard automation: ${pattern}`,
    )
  }
  assert.match(
    readinessCheck,
    /readiness verifier must not depend on browser\/dashboard automation/,
    'CallTools readiness verifier must fail closed if browser/dashboard automation is reintroduced',
  )
  assert.match(
    fullE2eAudit,
    /const requireCallToolsReady = includeLive/,
    'full-audit may arm CallTools only for an explicit --include-live run',
  )
  assert.match(
    agentSessionHelper,
    /api\/calltools\/agent-session/,
    'agent-session helper must use the backend agent-session route',
  )
  assert.match(
    agentSessionHelper,
    /confirmAgentSession:\s*shouldApply/,
    'agent-session helper must explicitly confirm backend AgentStatus mutations',
  )
  assert.match(
    agentSessionHelper,
    /backendOnly:\s*true/,
    'agent-session helper must declare the backend readiness path',
  )
  assert.match(
    agentSessionHelper,
    /agentSessionBackendProofReady/,
    'agent-session helper must reject readiness payloads without backend/headless proof metadata',
  )
  assert.match(
    agentSessionHelper,
    /assertBackendHeadlessOnlyHelper/,
    'agent-session helper must fail closed if browser/dashboard automation is introduced',
  )
  assert.match(
    agentSessionHelper,
    /forbiddenAutomationPatterns/,
    'agent-session helper must own its backend/headless-only automation denylist',
  )
  assert.match(
    agentSessionHelper,
    /headlessOnly:\s*true/,
    'agent-session helper must declare the headless readiness path',
  )
  assert.match(
    agentSessionHelper,
    /--dry-run/,
    'agent-session helper must support a non-mutating backend plan mode',
  )
  assert.match(
    agentSessionHelper,
    /if \(args\.help\) \{\s*printUsage\(\)\s*process\.exit\(0\)\s*\}/,
    'agent-session helper --help must exit before reading or mutating provider state',
  )
  assert.match(
    agentSessionHelper,
    /--help\s+Print this message without reading or mutating provider state\./,
    'agent-session helper usage must document that --help is non-mutating',
  )
  assert.match(
    agentSessionHelper,
    /targetReady/,
    'agent-session helper must support explicit backend ready and not-ready targets',
  )
  assert.match(
    agentSessionHelper,
    /agentSessionNotReady/,
    'agent-session helper must verify backend-paused AgentStatus for explicit human-seat handoff',
  )
  assert.match(
    agentSessionHelper,
    /--ready=false/,
    'agent-session helper must document the backend pause mode in next actions',
  )
  assert.match(
    agentSessionHelper,
    /CALLTOOLS_AGENT_SESSION_TIMEOUT_MS/,
    'agent-session helper must bound backend readiness polling',
  )
  assert.match(
    agentSessionHelper,
    /patchError:\s*result\.patchError \|\| ''/,
    'agent-session helper must expose native AgentStatus PATCH errors in JSON output',
  )
  assert.match(
    agentSessionHelper,
    /campaignAgentPatchError|campaignAgentPatch|campaignAgentMutationEndpoint/,
    'agent-session helper must expose sanitized campaign-agent mutation proof',
  )
  assert.doesNotMatch(
    agentSessionHelper,
    /readiness\.campaignReady\s*&&/,
    'agent-session helper must not conflate agent-session establishment with campaign-source readiness',
  )
  assert.match(
    agentSessionHelper,
    /api\/calltools\/readiness/,
    'agent-session helper must poll Speak readiness for native proof',
  )
  assert.doesNotMatch(
    agentSessionHelper,
    /agent-config-calltools-default/,
    'agent-session helper must not default normal operation to one saved profile',
  )
  assert.match(
    agentSessionHelper,
    /adoptResolvedCallToolsProfileId/,
    'agent-session helper must adopt the backend-selected active profile before mutation',
  )
  assert.doesNotMatch(
    agentSessionHelper,
    /chromium|playwright|launchPersistentContext|grantPermissions|#username|#password|Join Campaign|dashboardState|CALLTOOLS_AGENT_SESSION_PASSWORD/,
    'agent-session helper must not depend on browser/dashboard automation',
  )
  assert.doesNotMatch(
    fullE2eAudit,
    /qa:calltools-contact-proof|calltools:prepare-proof-contact|runCallToolsAgentSessionForAudit\(\{ ready: false \}\)|--pause-after-ready/,
    'full audit must not mutate proof inventory or invoke legacy direct-call certification',
  )
  assert.match(
    fullE2eAudit,
    /--ready=\$\{ready \? 'true' : 'false'\}/,
    'full audit must pass explicit backend AgentStatus target state to the helper',
  )
  assert.match(
    fullE2eAudit,
    /if \(includeLive\)[\s\S]{0,500}runCallToolsAgentSessionForAudit\(\{ ready: true \}\)[\s\S]{0,1200}--require-campaign-ready/,
    '--include-live must explicitly arm and verify campaign-follow readiness',
  )
  assert.match(
    fullE2eAudit,
    /qa:calltools-live-proof[\s\S]{0,1800}--startedAfter=\$\{startedAt\.toISOString\(\)\}[\s\S]{0,500}--waitMs=/,
    'full audit must wait for a native campaign artifact bound to the current audit run',
  )
  assert.doesNotMatch(
    fullE2eAudit,
    /--keep-open|calltoolsAgentSessionHeadless|CALLTOOLS_AGENT_SESSION_HEADLESS/,
    'full audit must not depend on browser-held CallTools sessions',
  )
  assert.match(
    calltoolsClient,
    /extension:\s*safeLeadText\(phone\.extension\)/,
    'CallTools phone credentials preserve the PBX extension without exposing secrets',
  )
  assert.match(
    calltoolsClient,
    /serviceLevel:\s*safeLeadText\(value\.service_level\)/,
    'CallTools normalized phone options preserve service-level metadata',
  )
  assert.doesNotMatch(
    serverIndex,
    /qa-answer|callToolsQaAnswer|CALLTOOLS_QA_ANSWER|VAPI_/i,
    'backend must not retain the retired answer-bot or Vapi proof runtime',
  )
  assert.match(
    serverIndex,
    /recoverInworldToolPlanRestriction[\s\S]*sendInworldSessionUpdate\(state, \{ includeTools: false \}\)/,
    'Inworld plan-restricted tool calling falls back to a no-tools realtime session update',
  )
  assert.match(
    serverIndex,
    /inworldSessionToolsEnabled\(state\)[\s\S]*inworldToolDefinitions/,
    'Inworld session construction gates provider tools on explicit capability',
  )
  assert.match(
    serverIndex,
    /<tool_availability>[\s\S]*Inworld provider tool calling is unavailable/,
    'Inworld no-tools sessions tell the model not to claim unavailable tool actions',
  )
  assert.match(
    readFileSync('server/runtime-config.mjs', 'utf8'),
    /INWORLD_TOOL_CALLING_ENABLED/,
    'Inworld tool calling has an explicit runtime capability flag',
  )
  assert.match(
    serverIndex,
    /recoverInworldModelPlanRestriction[\s\S]*inworldFallbackRealtimeModel[\s\S]*response\.create/,
    'Inworld unavailable selected models fall back to a native realtime model and retry the response',
  )
  assert.match(
    serverIndex,
    /voice: inworldVoiceId\(state\)/,
    'Inworld TTS uses Inworld-native voice identity instead of the cross-provider voice field',
  )
  assert.match(
    serverIndex,
    /looksLikeUuid[\s\S]*DEFAULT_INWORLD_VOICE/,
    'Inworld TTS falls back away from stored Hume UUID voice IDs',
  )
  assert.match(
    readFileSync('server/runtime-config.mjs', 'utf8'),
    /INWORLD_FALLBACK_REALTIME_MODEL/,
    'Inworld model fallback has an explicit runtime option',
  )
  console.log('CallTools Phone-as-Agent checks passed')
} finally {
  globalThis.fetch = originalFetch
  process.env = originalEnv
}

function verifyCallToolsVoiceStandbyRuntimeIsolation() {
  const binding = {
    appUserId: 'agent-user-id',
    campaignId: 'campaign-id',
    phoneId: 'phone-id',
  }
  const baseScope = {
    binding,
    leaseId: 'lease-id',
    profileId: 'agent-config-jai',
    profile: { id: 'agent-config-jai', updatedAt: '2026-07-15T19:00:00.000Z' },
  }
  const humeConfig = {
    voiceRuntimeProvider: 'hume',
    humeConfigId: 'hume-config-a',
    voice: 'jai-stan-a',
    verboseTranscription: true,
    sampleRate: 16_000,
  }
  const changedHumeConfig = {
    ...humeConfig,
    humeConfigId: 'hume-config-b',
    voice: 'jai-stan-b',
  }
  const inworldConfig = {
    voiceRuntimeProvider: 'inworld',
    inworldConfigId: 'inworld-config-a',
    inworldVoiceId: 'inworld-voice-a',
    sampleRate: 16_000,
  }
  assert.notEqual(
    callToolsVoiceStandbyRuntimeFingerprint({ config: humeConfig }),
    callToolsVoiceStandbyRuntimeFingerprint({ config: changedHumeConfig }),
    'Hume config or voice edits must change the standby runtime fingerprint',
  )
  assert.notEqual(
    callToolsVoiceStandbyScopeKey({ ...baseScope, config: humeConfig }),
    callToolsVoiceStandbyScopeKey({ ...baseScope, config: inworldConfig }),
    'Hume and Inworld standby sockets must never share a lease scope key',
  )

  const records = new Map()
  const cancellations = []
  let prepared = 0
  const coordinator = createCallToolsVoiceStandbyCoordinator({
    prepare: ({ key, scope }) => {
      const state = { id: `standby-${++prepared}`, config: scope.config, healthy: true }
      records.set(key, { state })
      return state
    },
    cancel: (key, reason) => {
      cancellations.push({ key, reason })
      return records.delete(key)
    },
    get: (key) => records.get(key) || null,
    isHealthy: (state) => state.healthy === true,
  })
  const first = coordinator.ensure({ ...baseScope, config: humeConfig })
  assert.equal(coordinator.ensure({ ...baseScope, config: humeConfig }), first)
  const second = coordinator.ensure({ ...baseScope, config: changedHumeConfig })
  assert.notEqual(second, first)
  assert.equal(cancellations.at(-1)?.reason, 'scope_changed')
  assert.equal(
    coordinator.claim(
      { ...baseScope, config: humeConfig },
      () => 'stale-runtime-must-not-bind',
    ),
    null,
    'a stale Hume standby must not bind after an operational config edit',
  )
  assert.equal(
    coordinator.claim(
      { ...baseScope, config: changedHumeConfig },
      ({ state }) => state,
    ),
    second,
  )
  const third = coordinator.ensure({ ...baseScope, config: inworldConfig })
  assert.equal(third.config.voiceRuntimeProvider, 'inworld')
  assert.notEqual(third, second)
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function inputBody(init) {
  return init?.body || '{}'
}

async function checkCallToolsSeatClaimSafety() {
  let nativeReadCount = 0
  const owned = await assertCallToolsSeatClaimSafe({
    gatewayStatus: {
      connected: true,
      gateway: { sipRegistered: true },
    },
    readNativeStatus: async () => {
      nativeReadCount += 1
      return { agentReady: true }
    },
  })
  assert.equal(owned.ownershipProven, true)
  assert.equal(nativeReadCount, 0, 'a matching healthy Speak gateway proves rearm ownership')

  const available = await assertCallToolsSeatClaimSafe({
    gatewayStatus: { connected: false },
    readNativeStatus: async () => ({
      agentReady: false,
      agentLoggedIn: false,
      agentLiveCallsCount: 0,
      campaignAgentReady: false,
      liveCallsCount: 0,
      seatClaimSafe: true,
    }),
  })
  assert.equal(available.reason, 'native_agent_confirmed_logged_out_without_live_calls')

  const loggedInButUnavailable = await assertCallToolsSeatClaimSafe({
    gatewayStatus: { connected: false },
    readNativeStatus: async () => ({
      agentReady: false,
      agentLoggedIn: true,
      agentLiveCallsCount: 0,
      campaignAgentReady: false,
      liveCallsCount: 0,
      humanSeatActive: false,
      seatClaimSafe: true,
    }),
  })
  assert.equal(
    loggedInButUnavailable.reason,
    'native_agent_confirmed_unavailable_without_live_calls',
  )

  await assert.rejects(
    assertCallToolsSeatClaimSafe({
      gatewayStatus: { connected: false },
      readNativeStatus: async () => ({
        agentReady: true,
        agentLoggedIn: true,
        humanSeatActive: true,
        seatClaimSafe: false,
      }),
    }),
    (error) => {
      assert.equal(error?.status, 409)
      assert.equal(error?.code, 'calltools_human_seat_active')
      return true
    },
  )
  await assert.rejects(
    assertCallToolsSeatClaimSafe({
      gatewayStatus: { connected: false },
      readNativeStatus: async () => ({
        agentReady: false,
        agentLoggedIn: true,
        agentLiveCallsCount: 1,
        campaignAgentReady: false,
        liveCallsCount: 1,
        humanSeatActive: true,
        seatClaimSafe: false,
      }),
    }),
    (error) => {
      assert.equal(error?.status, 409)
      assert.equal(error?.code, 'calltools_human_seat_active')
      return true
    },
  )
  await assert.rejects(
    assertCallToolsSeatClaimSafe({
      gatewayStatus: { connected: false },
      readNativeStatus: async () => ({
        agentReady: null,
        agentReadError: 'native read timeout',
      }),
    }),
    (error) => {
      assert.equal(error?.status, 503)
      assert.equal(error?.code, 'calltools_native_seat_state_unproven')
      return true
    },
  )
}

async function checkCallToolsDutyMonitorBehavior() {
  const binding = {
    appUserId: 'agent-user-id',
    campaignId: 'campaign-id',
    phoneId: 'phone-id',
  }
  let state = {
    campaignRunning: false,
    calltoolsDuty: {
      binding: {},
      blockers: [],
      leaseId: '',
      message: '',
      profileId: '',
      providerReadFailures: 0,
      status: 'off',
    },
  }
  let providerStatus = healthyDutyStatus()
  let disarmCount = 0
  let armCount = 0
  let armResult = { ok: true, after: { ready: true } }
  let leaseSequence = 0
  const patches = []
  let readProviderStatusImpl = async () => structuredClone(providerStatus)
  let proveUnavailableImpl = async () => ({
    agentReady: false,
    agentLoggedIn: false,
    agentLiveCallsCount: 0,
    binding: {
      appUserId: binding.appUserId,
      campaignId: binding.campaignId,
    },
    campaignAgentReady: false,
    humanSeatActive: false,
    liveCallsCount: 0,
    seatClaimProofRead: true,
    seatClaimSafe: true,
  })
  const monitor = createCallToolsDutyMonitor({
    arm: async () => {
      armCount += 1
      return structuredClone(armResult)
    },
    createLeaseId: () => `lease-${++leaseSequence}`,
    disarm: async () => {
      disarmCount += 1
      return { ok: true, after: { ready: false } }
    },
    logger: { warn() {} },
    now: () => '2026-07-14T23:00:00.000Z',
    patchDuty: async ({ expectedLeaseId, patch }) => {
      if (state.calltoolsDuty.leaseId !== expectedLeaseId) {
        return {
          applied: false,
          dialerState: structuredClone(state),
        }
      }
      patches.push(structuredClone(patch))
      state = {
        ...state,
        campaignRunning: Boolean(patch.leaseId ?? state.calltoolsDuty.leaseId),
        calltoolsDuty: { ...state.calltoolsDuty, ...patch },
      }
      if (state.calltoolsDuty.status === 'off') state.campaignRunning = false
      return { applied: true, dialerState: structuredClone(state) }
    },
    proveUnavailable: (...args) => proveUnavailableImpl(...args),
    readDuty: async () => ({ dialerState: structuredClone(state) }),
    readProviderStatus: (...args) => readProviderStatusImpl(...args),
  })

  const protectedOffState = applyWorkspaceDialerStatePatch(
    {
      sourceId: 'source:calltools::calltools%3Acampaign%3A12345',
      campaignRunning: false,
      calltoolsDuty: { leaseId: '', status: 'off' },
    },
    {
      campaignRunning: true,
      calltoolsDuty: {
        leaseId: 'client-forged-lease',
        status: 'on',
      },
      controllerId: 'stale-browser-controller',
    },
  )
  assert.equal(
    protectedOffState.campaignRunning,
    false,
    'a stale browser heartbeat cannot resurrect server-owned CallTools duty',
  )
  assert.equal(protectedOffState.calltoolsDuty.leaseId, '')
  assert.equal(protectedOffState.controllerId, '')

  let blockedPrepareCount = 0
  let blockedMutateCount = 0
  await assert.rejects(
    monitor.runAgentSessionMutation({
      binding,
      campaignFollow: true,
      mutate: async () => {
        blockedMutateCount += 1
        return { ok: true, after: { ready: true } }
      },
      preflight: async () => {
        throw Object.assign(new Error('Native CallTools seat is already active'), {
          status: 409,
          code: 'calltools_human_seat_active',
        })
      },
      prepare: async () => {
        blockedPrepareCount += 1
      },
      profileId: 'profile-a',
      targetReady: true,
    }),
    (error) => {
      assert.equal(error?.code, 'calltools_human_seat_active')
      return true
    },
  )
  assert.equal(
    state.calltoolsDuty.status,
    'off',
    'a rejected SIP ownership claim must not persist an Available lease',
  )
  assert.equal(state.calltoolsDuty.leaseId, '')
  assert.equal(blockedPrepareCount, 0, 'a rejected ownership claim must not touch the gateway')
  assert.equal(blockedMutateCount, 0, 'a rejected ownership claim must not touch AgentStatus')

  const enabled = await monitor.runAgentSessionMutation({
    binding,
    campaignFollow: true,
    prepare: async () => {
      assert.equal(
        state.calltoolsDuty.status,
        'arming',
        'the durable Available lease must exist before gateway or provider preparation begins',
      )
    },
    mutate: async () => {
      assert.equal(
        state.calltoolsDuty.status,
        'arming',
        'durable duty lease must be persisted before native AgentStatus is armed',
      )
      return { ok: true, after: { ready: true } }
    },
    profileId: 'profile-a',
    targetReady: true,
  })
  assert.equal(enabled.session.ok, true)
  assert.equal(enabled.duty.status, 'on')
  assert.equal(state.campaignRunning, true)
  assert.equal(state.calltoolsDuty.leaseId, 'lease-1')
  assert.equal(state.calltoolsDuty.profileId, 'profile-a')

  let unscopedReleaseMutations = 0
  await assert.rejects(
    monitor.runAgentSessionMutation({
      binding,
      mutate: async () => {
        unscopedReleaseMutations += 1
        return { ok: true, after: { ready: false } }
      },
      profileId: 'profile-a',
      targetReady: false,
    }),
    (error) => {
      assert.equal(error?.code, 'calltools_duty_release_scope_incomplete')
      return true
    },
  )
  assert.equal(unscopedReleaseMutations, 0)
  assert.equal(state.calltoolsDuty.leaseId, 'lease-1')
  assert.equal(state.calltoolsDuty.status, 'on')

  let mismatchedReleaseMutations = 0
  await assert.rejects(
    monitor.runAgentSessionMutation({
      binding,
      expectedLeaseId: 'another-lease',
      mutate: async () => {
        mismatchedReleaseMutations += 1
        return { ok: true, after: { ready: false } }
      },
      profileId: 'profile-a',
      targetReady: false,
    }),
    (error) => {
      assert.equal(error?.code, 'calltools_duty_release_scope_mismatch')
      return true
    },
  )
  assert.equal(mismatchedReleaseMutations, 0)
  assert.equal(state.calltoolsDuty.leaseId, 'lease-1')
  assert.equal(state.calltoolsDuty.status, 'on')

  await monitor.reconcileNow()
  assert.equal(disarmCount, 0, 'healthy campaign duty must remain armed')

  providerStatus = pausedDutyStatus()
  await monitor.reconcileNow()
  assert.equal(disarmCount, 0, 'an Available lease must never be silently disarmed')
  assert.equal(armCount, 1, 'an unexpected native pause must be repaired')
  assert.equal(state.campaignRunning, true)
  assert.equal(state.calltoolsDuty.status, 'on')
  assert.equal(state.calltoolsDuty.leaseId, 'lease-1')

  providerStatus = healthyDutyStatus({ agentReady: false })
  await monitor.reconcileNow()
  assert.equal(armCount, 2, 'native Unavailable drift must be reconciled back to Available')
  assert.equal(state.calltoolsDuty.status, 'on')

  readProviderStatusImpl = async () => ({
    agentReadError: 'temporary agent read failure',
    campaignReadError: 'temporary campaign read failure',
  })
  await monitor.reconcileNow()
  await monitor.reconcileNow()
  await monitor.reconcileNow()
  assert.equal(
    state.calltoolsDuty.status,
    'on',
    'repeated health-read failures must retain the operator-requested Available lease',
  )
  assert.equal(disarmCount, 0)

  providerStatus = healthyDutyStatus()
  readProviderStatusImpl = async () => structuredClone(providerStatus)
  const reaffirmed = await monitor.runAgentSessionMutation({
    binding,
    campaignFollow: true,
    mutate: async () => ({ ok: true, after: { ready: true } }),
    profileId: 'profile-a',
    targetReady: true,
  })
  assert.equal(reaffirmed.duty.leaseId, 'lease-1', 'Available is idempotent and keeps its lease')
  assert.equal(reaffirmed.duty.status, 'on')

  await monitor.runAgentSessionMutation({
    binding,
    expectedLeaseId: state.calltoolsDuty.leaseId,
    mutate: async () => ({ ok: true, after: { ready: false } }),
    profileId: 'profile-a',
    targetReady: false,
  })
  assert.equal(state.calltoolsDuty.status, 'off')
  assert.equal(state.campaignRunning, false)
  assert.equal(state.calltoolsDuty.leaseId, '')
  assert.equal((await monitor.publicState()).autoRearm, true)

  await monitor.runAgentSessionMutation({
    binding,
    campaignFollow: true,
    mutate: async () => ({ ok: true, after: { ready: true } }),
    profileId: 'profile-a',
    targetReady: true,
  })
  providerStatus = pausedDutyStatus()
  armResult = {
    ok: false,
    after: { ready: false },
    patchError: 'bounded CallTools PATCH timeout',
  }
  await monitor.reconcileNow()
  assert.equal(state.campaignRunning, true)
  assert.equal(state.calltoolsDuty.status, 'on')
  assert.equal(state.calltoolsDuty.leaseId, 'lease-2')
  assert.equal(state.calltoolsDuty.providerReadFailures, 1)
  assert.match(state.calltoolsDuty.message, /retaining Available/i)
  assert.equal(disarmCount, 0, 'provider retry failure must never release Available')

  armResult = { ok: true, after: { ready: true } }
  await monitor.reconcileNow()
  assert.equal(state.calltoolsDuty.status, 'on')
  assert.equal(state.calltoolsDuty.leaseId, 'lease-2')
  assert.equal(state.calltoolsDuty.providerReadFailures, 0)

  providerStatus = healthyDutyStatus()
  await monitor.runAgentSessionMutation({
    binding,
    campaignFollow: true,
    mutate: async () => ({ ok: true, after: { ready: true } }),
    profileId: 'profile-a',
    targetReady: true,
  })
  providerStatus = healthyDutyStatus({ agentReady: false })
  await monitor.reconcileNow()
  assert.equal(disarmCount, 0, 'native Unavailable drift must be rearmed, not released')
  assert.equal(state.calltoolsDuty.status, 'on')
  assert.equal(state.calltoolsDuty.leaseId, 'lease-2')

  providerStatus = healthyDutyStatus()
  await monitor.runAgentSessionMutation({
    binding,
    campaignFollow: true,
    mutate: async () => ({ ok: true, after: { ready: true } }),
    profileId: 'profile-a',
    targetReady: true,
  })
  let releaseReadiness
  let readinessReadStarted
  const readinessStarted = new Promise((resolve) => {
    readinessReadStarted = resolve
  })
  const delayedReadiness = new Promise((resolve) => {
    releaseReadiness = resolve
  })
  const delayedProviderStatus = pausedDutyStatus()
  readProviderStatusImpl = async () => {
    readinessReadStarted()
    await delayedReadiness
    return structuredClone(delayedProviderStatus)
  }
  const staleReconcile = monitor.reconcileNow()
  await readinessStarted
  const reenable = monitor.runAgentSessionMutation({
    binding,
    campaignFollow: true,
    mutate: async () => ({ ok: true, after: { ready: true } }),
    profileId: 'profile-a',
    targetReady: true,
  })
  providerStatus = healthyDutyStatus()
  readProviderStatusImpl = async () => structuredClone(providerStatus)
  releaseReadiness()
  await staleReconcile
  await reenable
  assert.equal(state.calltoolsDuty.status, 'on')
  assert.equal(state.calltoolsDuty.leaseId, 'lease-2')
  assert.equal(
    patches.at(-1)?.status,
    'on',
    'serialized re-enable must win after an in-flight stale pause reconciliation',
  )

  await monitor.runAgentSessionMutation({
    binding,
    campaignFollow: false,
    expectedLeaseId: state.calltoolsDuty.leaseId,
    mutate: async () => ({ ok: true, after: { ready: false } }),
    profileId: 'profile-a',
    targetReady: false,
  })
  assert.equal(state.calltoolsDuty.status, 'off')
  assert.equal(state.campaignRunning, false)

  providerStatus = healthyDutyStatus()
  await monitor.runAgentSessionMutation({
    binding,
    campaignFollow: true,
    mutate: async () => ({ ok: true, after: { ready: true } }),
    profileId: 'profile-a',
    targetReady: true,
  })
  readProviderStatusImpl = async () => ({
    agentReadError: 'agent read unavailable',
    campaignReadError: 'campaign read unavailable',
  })
  armResult = {
    ok: false,
    after: { ready: false },
    patchError: 'bounded CallTools PATCH timeout',
  }
  await monitor.reconcileNow()
  assert.equal(state.calltoolsDuty.status, 'on')
  assert.equal(state.calltoolsDuty.providerReadFailures, 1)
  await monitor.reconcileNow()
  assert.equal(state.calltoolsDuty.status, 'on')
  assert.equal(state.calltoolsDuty.providerReadFailures, 2)
  assert.equal(state.calltoolsDuty.leaseId, 'lease-3')
  assert.equal(disarmCount, 0, 'read failures must never silently release Available')

  providerStatus = healthyDutyStatus()
  readProviderStatusImpl = async () => structuredClone(providerStatus)
  armResult = { ok: true, after: { ready: true } }
  await monitor.runAgentSessionMutation({
    binding,
    expectedLeaseId: state.calltoolsDuty.leaseId,
    mutate: async () => ({ ok: true, after: { ready: false } }),
    profileId: 'profile-a',
    targetReady: false,
  })
  let releasePreparation
  let preparationStarted
  let prepareCount = 0
  let conflictingMutateCount = 0
  const preparationPending = new Promise((resolve) => {
    preparationStarted = resolve
  })
  const preparationRelease = new Promise((resolve) => {
    releasePreparation = resolve
  })
  const firstEnable = monitor.runAgentSessionMutation({
    binding,
    campaignFollow: true,
    mutate: async () => ({ ok: true, after: { ready: true } }),
    prepare: async () => {
      prepareCount += 1
      preparationStarted()
      await preparationRelease
    },
    profileId: 'profile-a',
    targetReady: true,
  })
  await preparationPending
  const duplicateEnable = monitor.runAgentSessionMutation({
    binding,
    campaignFollow: true,
    mutate: async () => {
      conflictingMutateCount += 1
      return { ok: true, after: { ready: true } }
    },
    prepare: async () => {
      prepareCount += 1
    },
    profileId: 'profile-b',
    targetReady: true,
  })
  releasePreparation()
  await firstEnable
  await assert.rejects(duplicateEnable, (error) => {
    assert.equal(error?.code, 'calltools_duty_active')
    return true
  })
  assert.equal(
    prepareCount,
    1,
    'a different-profile Available request must be rejected before provider sync or gateway rebinding',
  )
  assert.equal(conflictingMutateCount, 0)
  assert.equal(state.calltoolsDuty.profileId, 'profile-a')
  assert.equal(state.calltoolsDuty.binding.phoneId, binding.phoneId)
  await assert.rejects(
    monitor.runAgentSessionMutation({
      binding: { ...binding, phoneId: 'other-phone-id' },
      campaignFollow: true,
      mutate: async () => {
        conflictingMutateCount += 1
        return { ok: true, after: { ready: true } }
      },
      prepare: async () => {
        prepareCount += 1
      },
      profileId: 'profile-a',
      targetReady: true,
    }),
    (error) => {
      assert.equal(error?.code, 'calltools_duty_active')
      return true
    },
  )
  assert.equal(prepareCount, 1, 'a different binding must not run provider preparation')
  assert.equal(conflictingMutateCount, 0, 'a different binding must not touch native AgentStatus')
  await assert.rejects(
    monitor.runAgentSessionMutation({
      binding,
      expectedLeaseId: state.calltoolsDuty.leaseId,
      mutate: async () => {
        conflictingMutateCount += 1
        return { ok: true, after: { ready: false } }
      },
      profileId: 'profile-b',
      targetReady: false,
    }),
    (error) => {
      assert.equal(error?.code, 'calltools_duty_assignment_mismatch')
      return true
    },
  )
  assert.equal(
    state.calltoolsDuty.status,
    'on',
    'another profile cannot release the selected profile\'s Available lease',
  )
  assert.equal(conflictingMutateCount, 0)
  await monitor.runAgentSessionMutation({
    binding,
    expectedLeaseId: state.calltoolsDuty.leaseId,
    mutate: async () => ({ ok: true, after: { ready: false } }),
    profileId: 'profile-a',
    targetReady: false,
  })

  await monitor.runAgentSessionMutation({
    binding,
    campaignFollow: true,
    mutate: async () => ({ ok: true, after: { ready: true } }),
    profileId: 'profile-a',
    targetReady: true,
  })
  readProviderStatusImpl = async () => ({
    agentReady: null,
    campaignActive: null,
    originateCalls: null,
  })
  armResult = {
    ok: false,
    after: { ready: false },
    patchError: 'native boolean proof unavailable',
  }
  await monitor.reconcileNow()
  assert.equal(state.calltoolsDuty.status, 'on')
  assert.equal(state.calltoolsDuty.providerReadFailures, 1)
  await monitor.reconcileNow()
  assert.equal(
    state.calltoolsDuty.status,
    'on',
    'missing native boolean proof must retain Available for explicit operator release',
  )
  assert.equal(state.calltoolsDuty.providerReadFailures, 2)
  assert.ok(state.calltoolsDuty.leaseId)

  armResult = { ok: true, after: { ready: true } }
  await monitor.runAgentSessionMutation({
    binding,
    expectedLeaseId: state.calltoolsDuty.leaseId,
    mutate: async () => ({ ok: true, after: { ready: false } }),
    profileId: 'profile-a',
    targetReady: false,
  })
  providerStatus = healthyDutyStatus()
  readProviderStatusImpl = async () => structuredClone(providerStatus)
  await monitor.runAgentSessionMutation({
    binding,
    campaignFollow: true,
    mutate: async () => ({ ok: true, after: { ready: true } }),
    profileId: 'profile-a',
    targetReady: true,
  })
  assert.equal(state.calltoolsDuty.status, 'on')
  await monitor.runAgentSessionMutation({
    binding,
    expectedLeaseId: state.calltoolsDuty.leaseId,
    mutate: async () => ({ ok: true, after: { ready: false } }),
    profileId: 'profile-a',
    targetReady: false,
  })

  await monitor.runAgentSessionMutation({
    binding,
    campaignFollow: true,
    mutate: async () => ({ ok: true, after: { ready: true } }),
    profileId: 'profile-a',
    targetReady: true,
  })
  providerStatus = healthyDutyStatus({ gatewayHealthy: false })
  armResult = {
    ok: false,
    after: { ready: false },
    patchError: 'media gateway unavailable',
  }
  await monitor.reconcileNow()
  assert.equal(state.calltoolsDuty.status, 'on')
  assert.equal(state.calltoolsDuty.providerReadFailures, 1)
  await monitor.reconcileNow()
  assert.equal(state.calltoolsDuty.status, 'on')
  assert.equal(state.calltoolsDuty.providerReadFailures, 2)
  await monitor.reconcileNow()
  assert.equal(
    state.calltoolsDuty.status,
    'on',
    'sustained media-gateway loss must retain Available until explicit operator release',
  )
  assert.equal(state.calltoolsDuty.providerReadFailures, 3)
  assert.ok(state.calltoolsDuty.leaseId)
  await monitor.runAgentSessionMutation({
    binding,
    expectedLeaseId: state.calltoolsDuty.leaseId,
    mutate: async () => ({ ok: true, after: { ready: false } }),
    profileId: 'profile-a',
    targetReady: false,
  })

  await monitor.runAgentSessionMutation({
    binding,
    campaignFollow: true,
    mutate: async () => ({ ok: true, after: { ready: true } }),
    profileId: 'profile-a',
    targetReady: true,
  })
  const armCountBeforeFailedUnavailable = armCount
  const disarmCountBeforeFailedUnavailable = disarmCount
  await assert.rejects(
    monitor.runAgentSessionMutation({
      binding,
      expectedLeaseId: state.calltoolsDuty.leaseId,
      mutate: async () => {
        throw new Error('temporary unavailable transition failure')
      },
      profileId: 'profile-a',
      targetReady: false,
    }),
    /temporary unavailable transition failure/,
  )
  assert.equal(
    state.calltoolsDuty.status,
    'disarming',
    'an explicit Unavailable request must durably retain the release target while retrying',
  )
  assert.ok(state.calltoolsDuty.leaseId, 'a failed release must keep its durable retry lease')
  await monitor.reconcileNow()
  assert.equal(
    armCount,
    armCountBeforeFailedUnavailable,
    'a failed explicit Unavailable request must never be reconciled back to Available',
  )
  assert.equal(
    disarmCount,
    disarmCountBeforeFailedUnavailable + 1,
    'the monitor must retry the Unavailable transition',
  )
  assert.equal(state.calltoolsDuty.status, 'off')
  assert.equal(state.calltoolsDuty.leaseId, '')

  const mutationCountBeforeOffRelease = disarmCount
  let replayMutationCount = 0
  await assert.rejects(
    monitor.runAgentSessionMutation({
      binding,
      expectedLeaseId: 'lease-1',
      mutate: async () => {
        replayMutationCount += 1
        return { ok: true, after: { ready: false } }
      },
      profileId: 'profile-a',
      targetReady: false,
    }),
    (error) => {
      assert.equal(error?.code, 'calltools_duty_release_scope_mismatch')
      return true
    },
  )
  assert.equal(replayMutationCount, 0, 'a replayed stale release must not touch native state')
  assert.equal(disarmCount, mutationCountBeforeOffRelease)
  assert.equal(state.calltoolsDuty.status, 'off')
  assert.equal(state.calltoolsDuty.leaseId, '')

  let humanActiveMutationCount = 0
  proveUnavailableImpl = async () => ({
    agentReady: false,
    agentLoggedIn: true,
    agentLiveCallsCount: 0,
    binding: {
      appUserId: binding.appUserId,
      campaignId: binding.campaignId,
    },
    campaignAgentReady: false,
    humanSeatActive: true,
    liveCallsCount: 0,
    seatClaimProofRead: true,
    seatClaimSafe: false,
  })
  await assert.rejects(
    monitor.runAgentSessionMutation({
      binding,
      mutate: async () => {
        humanActiveMutationCount += 1
        return { ok: true, after: { ready: false } }
      },
      profileId: 'profile-a',
      targetReady: false,
    }),
    (error) => {
      assert.equal(error?.code, 'calltools_duty_release_requires_active_lease')
      return true
    },
  )
  assert.equal(
    humanActiveMutationCount,
    0,
    'Unavailable while off must never pause a logged-in human seat',
  )
  assert.equal(state.calltoolsDuty.status, 'off')
  assert.equal(state.calltoolsDuty.leaseId, '')

  proveUnavailableImpl = async () => ({
    agentReady: false,
    agentLoggedIn: false,
    agentLiveCallsCount: 0,
    binding: {
      appUserId: binding.appUserId,
      campaignId: binding.campaignId,
    },
    campaignAgentReady: false,
    humanSeatActive: false,
    liveCallsCount: 0,
    seatClaimProofRead: true,
    seatClaimSafe: true,
  })
  let idempotentMutationCount = 0
  const idempotentUnavailable = await monitor.runAgentSessionMutation({
    binding,
    mutate: async () => {
      idempotentMutationCount += 1
      return { ok: true, after: { ready: false } }
    },
    profileId: 'profile-a',
    targetReady: false,
  })
  assert.equal(idempotentUnavailable.session.ok, true)
  assert.equal(idempotentUnavailable.session.idempotent, true)
  assert.equal(idempotentUnavailable.session.mutationPerformed, false)
  assert.equal(idempotentMutationCount, 0)
  assert.equal(state.calltoolsDuty.status, 'off')
  assert.equal(state.calltoolsDuty.leaseId, '')
  monitor.stop()
}

function healthyDutyStatus({ agentReady = true, gatewayHealthy = true } = {}) {
  return {
    agentReady,
    campaignActive: true,
    gatewayHealthy,
    gatewayStatus: gatewayHealthy ? 'registered' : 'unhealthy',
    originateCalls: true,
  }
}

function pausedDutyStatus() {
  return {
    agentReady: true,
    campaignActive: false,
    gatewayHealthy: true,
    gatewayStatus: 'registered',
    originateCalls: false,
  }
}

async function checkFocusedCallToolsDutyStatusReader() {
  const priorFetch = globalThis.fetch
  const paths = []
  globalThis.fetch = async (url) => {
    const pathname = new URL(url).pathname
    paths.push(pathname)
    if (pathname.endsWith('/agentstatuses/agent-user-id/')) {
      return jsonResponse({
        app_user: 'agent-user-id',
        ready: true,
        logged_in: true,
        live_calls_count: 0,
        full_name: 'Private Agent Name',
        web_phone_status: 'Registered',
      })
    }
    if (pathname.endsWith('/campaignagents/agent-user-id/')) {
      return jsonResponse({
        app_user: 'agent-user-id',
        campaign: 'campaign-id',
        ready: true,
      })
    }
    if (pathname.endsWith('/campaignstatuses/campaign-id/')) {
      return jsonResponse({
        campaign: 'campaign-id',
        active: true,
        originate_calls: true,
        name: 'Private Campaign Name',
      })
    }
    if (pathname.endsWith('/livephonecalls/')) return jsonResponse({ results: [] })
    return jsonResponse({ detail: 'not found' }, 404)
  }
  try {
    const result = await readCallToolsDutyStatus({
      includeSeatClaimProof: true,
      binding: {
        appUserId: 'agent-user-id',
        campaignId: 'campaign-id',
      },
    })
    assert.deepEqual(paths.sort(), [
      '/api/agentstatuses/agent-user-id/',
      '/api/campaignagents/agent-user-id/',
      '/api/campaignstatuses/campaign-id/',
      '/api/livephonecalls/',
    ])
    assert.equal(result.agentReady, true)
    assert.equal(result.campaignActive, true)
    assert.equal(result.originateCalls, true)
    assert.equal(result.humanSeatActive, true)
    assert.equal(result.seatClaimSafe, false)
    assert.equal(JSON.stringify(result).includes('Private Agent Name'), false)
    assert.equal(JSON.stringify(result).includes('Private Campaign Name'), false)

    globalThis.fetch = async (url) => {
      const pathname = new URL(url).pathname
      if (pathname.endsWith('/agentstatuses/agent-user-id/')) {
        return jsonResponse({ app_user: 'agent-user-id' })
      }
      if (pathname.endsWith('/campaignagents/agent-user-id/')) {
        return jsonResponse({
          app_user: 'agent-user-id',
          campaign: 'campaign-id',
          ready: false,
        })
      }
      if (pathname.endsWith('/campaignstatuses/campaign-id/')) {
        return jsonResponse({
          campaign: 'campaign-id',
          active: true,
          originate_calls: true,
        })
      }
      if (pathname.endsWith('/livephonecalls/')) return jsonResponse({ results: [] })
      return jsonResponse({ detail: 'not found' }, 404)
    }
    const incomplete = await readCallToolsDutyStatus({
      includeSeatClaimProof: true,
      binding: {
        appUserId: 'agent-user-id',
        campaignId: 'campaign-id',
      },
    })
    assert.equal(incomplete.agentReady, null)
    assert.equal(
      incomplete.agentReadError,
      '',
      'an incomplete 200 payload stays unproven without inventing a provider error',
    )
    assert.equal(incomplete.seatClaimSafe, false)

    globalThis.fetch = async (url) => {
      const pathname = new URL(url).pathname
      if (pathname.endsWith('/agentstatuses/agent-user-id/')) {
        return jsonResponse({
          app_user: 'agent-user-id',
          ready: false,
          logged_in: false,
          live_calls_count: 0,
        })
      }
      if (pathname.endsWith('/campaignagents/agent-user-id/')) {
        return jsonResponse({
          app_user: 'agent-user-id',
          campaign: 'campaign-id',
          ready: false,
        })
      }
      if (pathname.endsWith('/campaignstatuses/campaign-id/')) {
        return jsonResponse({
          campaign: 'campaign-id',
          active: true,
          originate_calls: true,
        })
      }
      if (pathname.endsWith('/livephonecalls/')) return jsonResponse({ results: [] })
      return jsonResponse({ detail: 'not found' }, 404)
    }
    const loggedOut = await readCallToolsDutyStatus({
      includeSeatClaimProof: true,
      binding: {
        appUserId: 'agent-user-id',
        campaignId: 'campaign-id',
      },
    })
    assert.equal(loggedOut.humanSeatActive, false)
    assert.equal(loggedOut.seatClaimSafe, true)

    globalThis.fetch = async (url) => {
      const pathname = new URL(url).pathname
      if (pathname.endsWith('/agentstatuses/agent-user-id/')) {
        return jsonResponse({
          app_user: 'agent-user-id',
          ready: false,
          logged_in: true,
          live_calls_count: 0,
        })
      }
      if (pathname.endsWith('/campaignagents/agent-user-id/')) {
        return jsonResponse({
          app_user: 'agent-user-id',
          campaign: 'campaign-id',
          ready: false,
        })
      }
      if (pathname.endsWith('/campaignstatuses/campaign-id/')) {
        return jsonResponse({
          campaign: 'campaign-id',
          active: true,
          originate_calls: true,
        })
      }
      if (pathname.endsWith('/livephonecalls/')) return jsonResponse({ results: [] })
      return jsonResponse({ detail: 'not found' }, 404)
    }
    const loggedInButUnavailable = await readCallToolsDutyStatus({
      includeSeatClaimProof: true,
      binding: {
        appUserId: 'agent-user-id',
        campaignId: 'campaign-id',
      },
    })
    assert.equal(loggedInButUnavailable.agentLoggedIn, true)
    assert.equal(loggedInButUnavailable.humanSeatActive, false)
    assert.equal(loggedInButUnavailable.seatClaimSafe, true)
  } finally {
    globalThis.fetch = priorFetch
  }
}

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  if (start < 0) return ''
  const end = source.indexOf(endMarker, start + startMarker.length)
  return source.slice(start, end < 0 ? source.length : end)
}
