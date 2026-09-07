import http from 'node:http'
import { readFileSync } from 'node:fs'
import {
  buildSpeakAgentContract,
  buildSpeakAgentReadinessReport,
} from '../server/agent-contract.mjs'
import {
  callableRestAgentActions,
  invokeSpeakAgentAction,
} from '../server/agent-action-invoker.mjs'

const failures = []
const observed = []
const genericMockActions = []
const agentIntegrationDocs = readFileSync('docs/agent-integration.md', 'utf8')

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1')
  const body = await readJsonBody(request)
  observed.push({
    method: request.method,
    path: url.pathname,
    search: url.search,
    body,
  })
  response.setHeader('Content-Type', 'application/json')

  if (request.method === 'GET' && url.pathname === '/api/health') {
    response.end(
      JSON.stringify({
        ok: true,
        configured: true,
        missing: [],
        defaults: { phoneStreamCodec: 'L16' },
        delivery: { smsConfigured: true, emailConfigured: true },
        optimizations: { codec: 'L16', sampleRate: 16000 },
      }),
    )
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/calls/recent') {
    response.end(
      JSON.stringify({
        calls: [
          {
            callControlId: 'call-invoke',
            provider: 'calltools',
            providerIds: { callId: 'provider-call-invoke' },
            lead: {
              source: 'calltools',
              sourceId: 'calltools:campaign:invoke',
            },
            outcome: 'completed',
            transcript: [],
            diagnostic: { ok: true },
          },
        ],
      }),
    )
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/communication-threads') {
    response.end(
      JSON.stringify({
        schemaVersion: 'speak.communication-threads.v1',
        threads: [
          {
            threadId: 'thread-invoke',
            channels: ['call', 'sms'],
            summary: 'contact asked for a follow-up text',
            providerLinks: [{ provider: 'telnyx', kind: 'call_control', id: 'call-invoke' }],
          },
        ],
        nextCursor: null,
      }),
    )
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/calls/start') {
    response.end(
      JSON.stringify({
        callControlId: 'call-live-invoke',
        status: 'queued',
        leadId: body?.lead?.id || '',
        calltools: { agentSessionReady: true },
      }),
    )
    return
  }

  if (
    request.method === 'POST' &&
    /^\/api\/calls\/[^/]+\/instructions$/.test(url.pathname)
  ) {
    const callControlId = decodeURIComponent(url.pathname.split('/').at(-2) || '')
    response.end(
      JSON.stringify({
        ok: true,
        callControlId,
        event: {
          notice: 'Live instruction delivered to agent',
        },
      }),
    )
    return
  }

  if (
    request.method === 'POST' &&
    /^\/api\/calls\/[^/]+\/barge-in$/.test(url.pathname)
  ) {
    const callControlId = decodeURIComponent(url.pathname.split('/').at(-2) || '')
    response.end(
      JSON.stringify({
        ok: true,
        callControlId,
        event: {
          patch: {
            phase: 'handoff',
            takeover: true,
          },
          notice: 'Assistant paused',
        },
      }),
    )
    return
  }

  if (
    request.method === 'POST' &&
    /^\/api\/calls\/[^/]+\/resume$/.test(url.pathname)
  ) {
    const callControlId = decodeURIComponent(url.pathname.split('/').at(-2) || '')
    response.end(
      JSON.stringify({
        ok: true,
        callControlId,
        event: {
          patch: {
            phase: 'live',
            takeover: false,
          },
          notice: 'Assistant resumed',
        },
      }),
    )
    return
  }

  if (request.method === 'POST' && /^\/api\/calls\/[^/]+\/end$/.test(url.pathname)) {
    const callControlId = decodeURIComponent(url.pathname.split('/').at(-2) || '')
    response.end(
      JSON.stringify({
        ok: true,
        callControlId,
        alreadyEnded: false,
        outcome: body?.outcome || 'operator-ended',
        event: {
          patch: {
            phase: 'ended',
            takeover: false,
            outcome: body?.outcome || 'operator-ended',
          },
          notice: 'Call ended',
        },
      }),
    )
    return
  }

  if (
    request.method === 'GET' &&
    /^\/api\/calls\/[^/]+\/audio-link$/.test(url.pathname)
  ) {
    const callControlId = decodeURIComponent(url.pathname.split('/').at(-2) || '')
    response.end(
      JSON.stringify({
        status: 'available',
        callControlId,
        url: `/speak/api/calls/${encodeURIComponent(callControlId)}/audio`,
        source: 'local-mixed-wav',
      }),
    )
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/leads') {
    response.end(
      JSON.stringify({
        lead: {
          id: 'lead-invoke',
          ...(body?.lead || {}),
        },
      }),
    )
    return
  }

  if (request.method === 'PATCH' && /^\/api\/leads\/[^/]+$/.test(url.pathname)) {
    const leadId = decodeURIComponent(url.pathname.split('/').at(-1) || '')
    response.end(
      JSON.stringify({
        lead: {
          id: leadId,
          ...(body?.patch || {}),
        },
      }),
    )
    return
  }

  if (request.method === 'DELETE' && /^\/api\/leads\/[^/]+$/.test(url.pathname)) {
    const leadId = decodeURIComponent(url.pathname.split('/').at(-1) || '')
    response.end(
      JSON.stringify({
        deleted: [leadId],
        leads: [{ id: 'remaining-lead' }],
      }),
    )
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/leads/bulk-status') {
    response.end(
      JSON.stringify({
        patched: body?.ids || [],
        leads: (body?.ids || []).map((id) => ({ id, status: body?.status || '' })),
      }),
    )
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/leads/bulk-delete') {
    response.end(
      JSON.stringify({
        deleted: body?.ids || [],
        leads: [{ id: 'remaining-lead' }],
      }),
    )
    return
  }

  const genericMock = genericMockActionResponse(request.method, url.pathname)
  if (genericMock) {
    response.end(JSON.stringify(genericMock))
    return
  }

  response.statusCode = 404
  response.end(JSON.stringify({ error: 'not found' }))
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

try {
  const address = server.address()
  const appRoot = `http://127.0.0.1:${address.port}`
  const contract = buildSpeakAgentContract({
    basePath: '/speak',
    publicBaseUrl: 'https://speak.example.com/speak',
  })
  genericMockActions.splice(0, genericMockActions.length, ...callableRestAgentActions(contract)
    .map((action) => ({
      action,
      pathRegex: pathTemplateRegex(action.path),
    })))
  const readiness = buildSpeakAgentReadinessReport({
    basePath: '/speak',
    publicBaseUrl: 'https://speak.example.com/speak',
  })

  if (!contract.agentAdapters.actionInvocation) {
    failures.push('contract missing agentAdapters.actionInvocation')
  }
  if (readiness.overallStatus !== 'pass') {
    failures.push(`readiness status ${readiness.overallStatus}`)
  }

  const health = await invokeSpeakAgentAction({
    contract,
    appRoot,
    actionId: 'read_runtime_health',
  })
  assert(health.ok, 'read_runtime_health did not succeed')
  assert(
    health.proofReturned.some((proof) => proof.field === 'ok' && proof.present),
    'read_runtime_health did not report ok proof',
  )

  const recent = await invokeSpeakAgentAction({
    contract,
    appRoot,
    actionId: 'read_recent_calls',
    query: { limit: 5 },
  })
  assert(recent.ok, 'read_recent_calls did not succeed')
  assert(
    observed.some((request) => request.path === '/api/calls/recent' && request.search === '?limit=5'),
    'read_recent_calls did not forward query params',
  )

  const threads = await invokeSpeakAgentAction({
    contract,
    appRoot,
    actionId: 'read_communication_threads',
    query: { contactId: 'lead-invoke', limit: 3 },
  })
  assert(threads.ok, 'read_communication_threads did not succeed')
  assert(
    threads.proofReturned.some((proof) => proof.field === 'threads[].threadId' && proof.present),
    'read_communication_threads did not report thread proof',
  )
  assert(
    observed.some(
      (request) =>
        request.path === '/api/communication-threads' &&
        request.search === '?contactId=lead-invoke&limit=3',
    ),
    'read_communication_threads did not forward query params',
  )

  const created = await invokeSpeakAgentAction({
    contract,
    appRoot,
    actionId: 'create_lead',
    authorizationMode: '--yolo',
    body: {
      lead: {
        name: 'Pat Invoke',
        phone: '+15551234567',
      },
    },
  })
  assert(created.ok, 'create_lead did not succeed')
  assert(created.authorizationMode === 'yolo', 'authorization alias did not normalize')
  assert(created.result?.lead?.id === 'lead-invoke', 'create_lead did not return lead proof')
  assert(
    observed.some(
      (request) =>
        request.path === '/api/leads' &&
        request.body?.authorizationMode === 'yolo' &&
        request.body?.lead?.phone === '+15551234567',
    ),
    'create_lead did not forward body with authorizationMode',
  )

  const encodedLeadId = 'lead invoke/encoded path'
  const updated = await invokeSpeakAgentAction({
    contract,
    appRoot,
    actionId: 'update_lead',
    path: { leadId: encodedLeadId },
    body: {
      patch: {
        company: 'Invoke Updated Co',
        status: 'follow-up',
      },
    },
  })
  assert(updated.ok, 'update_lead did not succeed with path parameters')
  assert(
    updated.resolvedPath === '/api/leads/lead%20invoke%2Fencoded%20path',
    'update_lead did not URL-encode path parameters',
  )
  assert(updated.result?.lead?.id === encodedLeadId, 'update_lead did not return the decoded lead id proof')
  assert(
    updated.proofReturned.some((proof) => proof.field === 'lead.id' && proof.present),
    'update_lead did not report lead.id proof',
  )
  assert(
    observed.some(
      (request) =>
        request.method === 'PATCH' &&
        request.path === '/api/leads/lead%20invoke%2Fencoded%20path' &&
        request.body?.authorizationMode === 'confirm_each' &&
        request.body?.patch?.company === 'Invoke Updated Co',
    ),
    'update_lead did not forward encoded path and patch body',
  )

  const bulkStatus = await invokeSpeakAgentAction({
    contract,
    appRoot,
    actionId: 'bulk_update_lead_status',
    body: {
      ids: ['lead-a', 'lead-b'],
      status: 'resolved',
    },
  })
  assert(bulkStatus.ok, 'bulk_update_lead_status did not succeed')
  assert(
    bulkStatus.proofReturned.some((proof) => proof.field === 'patched[]' && proof.present) &&
      bulkStatus.proofReturned.some((proof) => proof.field === 'leads[]' && proof.present),
    'bulk_update_lead_status did not report patched/leads proof',
  )
  assert(
    observed.some(
      (request) =>
        request.path === '/api/leads/bulk-status' &&
        request.body?.authorizationMode === 'confirm_each' &&
        request.body?.status === 'resolved' &&
        Array.isArray(request.body?.ids) &&
        request.body.ids.length === 2,
    ),
    'bulk_update_lead_status did not forward ids/status body',
  )

  const deleted = await invokeSpeakAgentAction({
    contract,
    appRoot,
    actionId: 'delete_lead',
    authorizationMode: 'session_preauthorized',
    path: { leadId: 'lead-delete' },
  })
  assert(deleted.ok, 'delete_lead did not succeed')
  assert(
    deleted.authorizationMode === 'session_preauthorized',
    'delete_lead did not preserve authorizationMode in envelope',
  )
  assert(
    deleted.proofReturned.some((proof) => proof.field === 'deleted[]' && proof.present) &&
      deleted.proofReturned.some((proof) => proof.field === 'leads[]' && proof.present),
    'delete_lead did not report deleted/leads proof',
  )
  assert(
    observed.some(
      (request) =>
        request.method === 'DELETE' &&
        request.path === '/api/leads/lead-delete' &&
        request.body === undefined,
    ),
    'delete_lead should invoke DELETE with encoded path and no JSON body',
  )

  const bulkDeleted = await invokeSpeakAgentAction({
    contract,
    appRoot,
    actionId: 'bulk_delete_leads',
    authorizationMode: 'dangerously_approve_everything',
    body: {
      ids: ['lead-delete-a', 'lead-delete-b'],
    },
  })
  assert(bulkDeleted.ok, 'bulk_delete_leads did not succeed')
  assert(
    bulkDeleted.authorizationMode === 'dangerously_approve_everything',
    'bulk_delete_leads did not preserve high-autonomy authorizationMode',
  )
  assert(
    bulkDeleted.proofReturned.some((proof) => proof.field === 'deleted[]' && proof.present) &&
      bulkDeleted.proofReturned.some((proof) => proof.field === 'leads[]' && proof.present),
    'bulk_delete_leads did not report deleted/leads proof',
  )
  assert(
    observed.some(
      (request) =>
        request.path === '/api/leads/bulk-delete' &&
        request.body?.authorizationMode === 'dangerously_approve_everything' &&
        Array.isArray(request.body?.ids) &&
        request.body.ids.length === 2,
    ),
    'bulk_delete_leads did not forward ids and authorizationMode',
  )

  const liveCall = await invokeSpeakAgentAction({
    contract,
    appRoot,
    actionId: 'start_live_call',
    authorizationMode: 'session_preauthorized',
    body: {
      lead: {
        id: 'lead-live-invoke',
        name: 'Riley Live',
        phone: '+15559876543',
      },
      config: {
        id: 'agent-config-invoke',
        name: 'Invoke Agent',
      },
      operatorInstructions: ['Verify action invocation proof only.'],
    },
  })
  assert(liveCall.ok, 'start_live_call did not succeed against mock backend')
  assert(liveCall.risk === 'high', 'start_live_call did not preserve high-risk metadata')
  assert(liveCall.externalSideEffect === true, 'start_live_call did not preserve externalSideEffect metadata')
  assert(
    liveCall.authorizationMode === 'session_preauthorized',
    'start_live_call did not preserve explicit authorizationMode',
  )
  assert(
    liveCall.proofReturned.some((proof) => proof.field === 'callControlId' && proof.present),
    'start_live_call did not report callControlId proof',
  )
  assert(
    observed.some(
      (request) =>
        request.path === '/api/calls/start' &&
        request.body?.authorizationMode === 'session_preauthorized' &&
        request.body?.lead?.phone === '+15559876543',
    ),
    'start_live_call did not forward body with authorizationMode',
  )

  const liveInstruction = await invokeSpeakAgentAction({
    contract,
    appRoot,
    actionId: 'send_live_instruction',
    authorizationMode: 'confirm_each',
    path: { callControlId: 'call-live-invoke' },
    body: {
      chatId: 'chat-live-invoke',
      instruction: 'Ask one concise follow-up question.',
    },
  })
  assert(liveInstruction.ok, 'send_live_instruction did not succeed against mock backend')
  assert(
    liveInstruction.externalSideEffect === true,
    'send_live_instruction did not preserve externalSideEffect metadata',
  )
  assert(
    liveInstruction.proofReturned.some(
      (proof) => proof.field === 'event.notice=Live instruction delivered to agent' && proof.present,
    ),
    'send_live_instruction did not report live instruction proof',
  )
  assert(
    observed.some(
      (request) =>
        request.method === 'POST' &&
        request.path === '/api/calls/call-live-invoke/instructions' &&
        request.body?.authorizationMode === 'confirm_each' &&
        request.body?.instruction === 'Ask one concise follow-up question.',
    ),
    'send_live_instruction did not forward call path, instruction, and authorizationMode',
  )

  const pauseTakeover = await invokeSpeakAgentAction({
    contract,
    appRoot,
    actionId: 'pause_agent_for_takeover',
    authorizationMode: 'session_preauthorized',
    path: { callControlId: 'call-live-invoke' },
    body: { chatId: 'chat-live-invoke' },
  })
  assert(pauseTakeover.ok, 'pause_agent_for_takeover did not succeed against mock backend')
  assert(
    pauseTakeover.risk === 'high' &&
      pauseTakeover.externalSideEffect === true &&
      typeof pauseTakeover.requiresHumanConfirmation === 'string' &&
      pauseTakeover.requiresHumanConfirmation.includes('live-call takeover'),
    'pause_agent_for_takeover did not preserve high-risk takeover metadata',
  )
  assert(
    pauseTakeover.proofReturned.some((proof) => proof.field === 'event.patch.takeover=true' && proof.present),
    'pause_agent_for_takeover did not report takeover proof',
  )
  assert(
    observed.some(
      (request) =>
        request.method === 'POST' &&
        request.path === '/api/calls/call-live-invoke/barge-in' &&
        request.body?.authorizationMode === 'session_preauthorized' &&
        request.body?.chatId === 'chat-live-invoke',
    ),
    'pause_agent_for_takeover did not forward call path, chatId, and authorizationMode',
  )

  const resumeTakeover = await invokeSpeakAgentAction({
    contract,
    appRoot,
    actionId: 'resume_agent_after_takeover',
    path: { callControlId: 'call-live-invoke' },
    body: { chatId: 'chat-live-invoke' },
  })
  assert(resumeTakeover.ok, 'resume_agent_after_takeover did not succeed against mock backend')
  assert(
    resumeTakeover.risk === 'medium' && resumeTakeover.externalSideEffect === true,
    'resume_agent_after_takeover did not preserve medium-risk externalSideEffect metadata',
  )
  assert(
    resumeTakeover.proofReturned.some((proof) => proof.field === 'event.patch.takeover=false' && proof.present),
    'resume_agent_after_takeover did not report resume proof',
  )
  assert(
    observed.some(
      (request) =>
        request.method === 'POST' &&
        request.path === '/api/calls/call-live-invoke/resume' &&
        request.body?.authorizationMode === 'confirm_each' &&
        request.body?.chatId === 'chat-live-invoke',
    ),
    'resume_agent_after_takeover did not forward call path, chatId, and authorizationMode',
  )

  const audioLink = await invokeSpeakAgentAction({
    contract,
    appRoot,
    actionId: 'read_call_audio_link',
    path: { callControlId: 'call live/audio invoke' },
  })
  assert(audioLink.ok, 'read_call_audio_link did not succeed against mock backend')
  assert(
    audioLink.risk === 'low' && audioLink.externalSideEffect === false,
    'read_call_audio_link did not preserve read-only metadata',
  )
  assert(
    audioLink.resolvedPath === '/api/calls/call%20live%2Faudio%20invoke/audio-link',
    'read_call_audio_link did not URL-encode path parameters',
  )
  assert(
    audioLink.proofReturned.some((proof) => proof.field === 'status' && proof.present) &&
      audioLink.proofReturned.some((proof) => proof.field === 'url' && proof.present) &&
      audioLink.proofReturned.some((proof) => proof.field === 'source' && proof.present),
    'read_call_audio_link did not report audio-link proof',
  )
  assert(
    observed.some(
      (request) =>
        request.method === 'GET' &&
        request.path === '/api/calls/call%20live%2Faudio%20invoke/audio-link' &&
        request.body === undefined,
    ),
    'read_call_audio_link should invoke GET with encoded path and no JSON body',
  )

  const endedCall = await invokeSpeakAgentAction({
    contract,
    appRoot,
    actionId: 'end_live_call',
    authorizationMode: 'session_preauthorized',
    path: { callControlId: 'call-live-invoke' },
    body: { outcome: 'operator-ended' },
  })
  assert(endedCall.ok, 'end_live_call did not succeed against mock backend')
  assert(
    endedCall.risk === 'high' &&
      endedCall.externalSideEffect === true &&
      typeof endedCall.requiresHumanConfirmation === 'string' &&
      endedCall.requiresHumanConfirmation.includes('ending the live call') &&
      endedCall.failureContract.includes('minimum hangup duration'),
    'end_live_call did not preserve high-risk hangup metadata',
  )
  assert(
    endedCall.proofReturned.some((proof) => proof.field === 'outcome' && proof.present) &&
      endedCall.proofReturned.some((proof) => proof.field === 'event.patch.phase=ended' && proof.present),
    'end_live_call did not report hangup proof',
  )
  assert(
    observed.some(
      (request) =>
        request.method === 'POST' &&
        request.path === '/api/calls/call-live-invoke/end' &&
        request.body?.authorizationMode === 'session_preauthorized' &&
        request.body?.outcome === 'operator-ended',
    ),
    'end_live_call did not forward call path, outcome, and authorizationMode',
  )

  const callableActions = callableRestAgentActions(contract)
  const allCallableCovered = []
  for (const action of callableActions) {
    const beforeCount = observed.length
    const result = await invokeSpeakAgentAction({
      contract,
      appRoot,
      actionId: action.id,
      ...sampleActionInvocationInput(action),
    })
    allCallableCovered.push(action.id)
    assert(result.ok, `${action.id} did not succeed in all-callable action invocation sweep`)
    assert(
      result.risk === action.risk &&
        result.kind === action.kind &&
        result.externalSideEffect === Boolean(action.externalSideEffect),
      `${action.id} did not preserve action metadata in all-callable sweep`,
    )
    assert(
      (result.proofReturned || []).every((proof) => proof.present),
      `${action.id} did not return every declared proof field in all-callable sweep`,
    )
    const observedRequest = observed
      .slice(beforeCount)
      .find((request) => request.method === action.method && request.path === result.resolvedPath)
    assert(
      Boolean(observedRequest),
      `${action.id} did not reach the expected mock route ${action.method} ${result.resolvedPath}`,
    )
    if (!['GET', 'DELETE'].includes(action.method)) {
      assert(
        observedRequest?.body?.authorizationMode === 'confirm_each',
        `${action.id} did not forward default authorizationMode in all-callable sweep`,
      )
    }
  }
  assert(
    allCallableCovered.length === contract.actionInvocation.callableActionCount,
    `all-callable sweep covered ${allCallableCovered.length} actions, expected ${contract.actionInvocation.callableActionCount}`,
  )

  const firstPartySend = await invokeSpeakAgentAction({
    contract,
    appRoot,
    actionId: 'send_communication_message',
    authorizationMode: 'session_preauthorized',
    body: {
      channel: 'sms',
      to: '+15551231234',
      body: 'Proof-only blocked send.',
    },
  })
  assert(!firstPartySend.ok, 'send_communication_message unexpectedly became action-invocable')
  assert(
    firstPartySend.error?.error === 'action_not_callable',
    'send_communication_message did not fail closed as action_not_callable',
  )
  assert(
    firstPartySend.risk === 'high' &&
      firstPartySend.externalSideEffect === true &&
      typeof firstPartySend.requiresHumanConfirmation === 'string' &&
      firstPartySend.requiresHumanConfirmation.includes('explicit operator UI confirmation') &&
      firstPartySend.authorizationMode === 'session_preauthorized',
    'send_communication_message blocked envelope did not preserve high-risk confirmation metadata',
  )
  assert(
    !observed.some((request) => request.path === '/api/communication-messages/send'),
    'send_communication_message action invocation reached the backend send route',
  )

  const missingPath = await invokeSpeakAgentAction({
    contract,
    appRoot,
    actionId: 'update_lead',
    body: { patch: { status: 'Ready' } },
  })
  assert(!missingPath.ok, 'missing update_lead path unexpectedly succeeded')
  assert(
    missingPath.error?.error === 'missing_path_parameters',
    'missing update_lead path did not return missing_path_parameters',
  )

  const blocked = await invokeSpeakAgentAction({
    contract,
    appRoot,
    actionId: 'phone_provider_webhook',
  })
  assert(!blocked.ok, 'provider webhook unexpectedly callable')
  assert(
    blocked.error?.error === 'action_not_callable',
    'provider webhook did not fail closed as action_not_callable',
  )

  const invalidAuthorization = await invokeSpeakAgentAction({
    contract,
    appRoot,
    actionId: 'create_lead',
    authorizationMode: 'approve_whatever',
    body: { lead: { phone: '+15550000000' } },
  })
  assert(!invalidAuthorization.ok, 'invalid authorizationMode unexpectedly succeeded')
  assert(
    invalidAuthorization.error?.error === 'invalid_authorization_mode',
    'invalid authorizationMode did not fail with the expected code',
  )

  assert(
    /speakInvoke\('bulk_update_lead_status',\s*\{\s*body:\s*\{\s*ids:\s*\['lead-orion',\s*'lead-northline'\]/.test(agentIntegrationDocs),
    'agent integration action-invocation example must wrap bulk status args in body.ids',
  )
  assert(
    /speakInvoke\('update_lead',\s*\{\s*path:\s*\{\s*leadId:\s*'lead-orion'\s*\},\s*body:\s*\{\s*patch:\s*\{/.test(agentIntegrationDocs),
    'agent integration update_lead example must use path/body action envelope',
  )
  assert(
    !/speakInvoke\('bulk_update_lead_status'[\s\S]{0,180}leadIds:/.test(agentIntegrationDocs),
    'agent integration action-invocation example must not use stale direct leadIds convenience args',
  )
  assert(
    agentIntegrationDocs.includes('Direct `fetch` callers must send the explicit action envelope'),
    'agent integration guide must distinguish direct fetch envelope from host-client convenience normalization',
  )

  if (failures.length > 0) {
    console.error(JSON.stringify({ ok: false, failures }, null, 2))
    process.exitCode = 1
  } else {
    console.log(
      JSON.stringify(
        {
          ok: true,
          schemaVersion: health.schemaVersion,
          endpoint: contract.agentAdapters.actionInvocation,
          callableActionCount: contract.actionInvocation.callableActionCount,
          readiness: readiness.summary,
        },
        null,
        2,
      ),
    )
  }
} finally {
  await new Promise((resolve) => server.close(resolve))
}

function assert(condition, message) {
  if (!condition) failures.push(message)
}

function readJsonBody(request) {
  return new Promise((resolve) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        resolve({ text })
      }
    })
  })
}

function genericMockActionResponse(method, pathname) {
  const match = genericMockActions.find(
    ({ action, pathRegex }) =>
      action.method === method &&
      pathRegex.test(pathname),
  )
  if (!match) return null
  return mockPayloadFromProof(match.action)
}

function mockPayloadFromProof(action) {
  const payload = {}
  for (const proof of action.proof || []) {
    const [pathPart, expectedPart = ''] = String(proof || '').split('=')
    const proofPath = pathPart.trim()
    if (!proofPath || /\s/.test(proofPath)) continue
    assignProofPath(payload, proofPath.split('.'), sampleProofValue(proofPath, expectedPart))
  }
  if (Object.keys(payload).length === 0) {
    payload.ok = true
  }
  return payload
}

function assignProofPath(target, parts, value) {
  if (!parts.length) return
  const [part, ...rest] = parts
  const isArray = part.endsWith('[]')
  const key = isArray ? part.slice(0, -2) : part
  if (isArray) {
    if (!Array.isArray(target[key])) target[key] = []
    if (rest.length === 0) {
      target[key].push(value)
      return
    }
    if (!target[key][0] || typeof target[key][0] !== 'object') target[key][0] = {}
    assignProofPath(target[key][0], rest, value)
    return
  }
  if (rest.length === 0) {
    target[key] = value
    return
  }
  if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
    target[key] = {}
  }
  assignProofPath(target[key], rest, value)
}

function sampleProofValue(path, expected) {
  const trimmedExpected = String(expected || '').trim()
  if (/^(true|false)$/i.test(trimmedExpected)) return /^true$/i.test(trimmedExpected)
  if (trimmedExpected) return trimmedExpected
  if (/(^|\.)(ok|configured|ready|campaignRunning)$/i.test(path)) return true
  if (/count|dispositions/i.test(path)) return 1
  if (/cursor/i.test(path)) return null
  if (/channels|missing|blockers/i.test(path)) return ['proof']
  return `proof-${path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'value'}`
}

function sampleActionInvocationInput(action) {
  const input = {}
  const path = sampleObjectFromSchema(action.pathSchema)
  if (Object.keys(path).length) input.path = path
  const query = sampleObjectFromSchema(action.querySchema)
  if (Object.keys(query).length) input.query = query
  if (!['GET', 'DELETE'].includes(action.method)) {
    input.body = sampleObjectFromSchema(action.requestSchema)
  }
  return input
}

function sampleObjectFromSchema(schema = {}) {
  if (!schema || schema.type !== 'object') return {}
  const output = {}
  const keys = new Set(schema.required || [])
  for (const [key, child] of Object.entries(schema.properties || {})) {
    if (keys.has(key)) output[key] = sampleFromSchema(child, key)
  }
  return output
}

function sampleFromSchema(schema = {}, key = 'value') {
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0]
  if (schema.type === 'array') return [sampleFromSchema(schema.items || { type: 'string' }, key)]
  if (schema.type === 'object') {
    const value = sampleObjectFromSchema(schema)
    return Object.keys(value).length ? value : { id: `${key}-invoke` }
  }
  if (schema.type === 'number' || schema.type === 'integer') return 1
  if (schema.type === 'boolean') return true
  return sampleStringForKey(key)
}

function sampleStringForKey(key) {
  const text = String(key || '').toLowerCase()
  if (text.includes('phone')) return '+15550123456'
  if (text.includes('email')) return 'invoke@example.com'
  if (text.includes('url')) return 'https://example.com/invoke'
  if (text.includes('id')) return `${key}-invoke/path`
  if (text.includes('message') || text.includes('text') || text.includes('instruction')) {
    return `Invoke ${key} message`
  }
  return `${key}-invoke`
}

function pathTemplateRegex(template) {
  const source = String(template || '')
    .split(/(\{[^}]+\})/g)
    .map((part) => part.startsWith('{') && part.endsWith('}')
      ? '[^/]+'
      : escapeRegex(part))
    .join('')
  return new RegExp(`^${source}$`)
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
