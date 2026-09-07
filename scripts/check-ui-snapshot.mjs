import 'dotenv/config'
import http from 'node:http'
import { renderSpeakUiSnapshot } from '../server/speak-mcp.mjs'

const failures = []
let delaySpeakOptionsMs = 0
const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1')
  response.setHeader('Content-Type', 'application/json')

  if (url.pathname === '/api/health') {
    response.end(
      JSON.stringify({
        ok: true,
        configured: true,
        missing: [],
        message: 'snapshot test health',
      }),
    )
    return
  }

  if (url.pathname === '/api/workspace') {
    response.end(
      JSON.stringify({
        version: 1,
        updatedAt: '2026-06-22T12:00:00.000Z',
        activeProfileId: 'profile-snapshot',
        leads: [
          {
            id: 'lead-snapshot',
            name: 'Pat Snapshot',
            company: 'Snapshot Co',
            phone: '+15551234567',
            status: 'Ready',
          },
        ],
        profiles: [
          {
            id: 'profile-snapshot',
            name: 'Snapshot Agent',
            updatedAt: '2026-06-22T12:00:00.000Z',
            config: { voice: 'Speak Voice' },
          },
        ],
        smartViews: [
          {
            id: 'smart-view-snapshot',
            name: 'Snapshot Ready',
            leadIds: ['lead-snapshot'],
            updatedAt: '2026-06-22T12:00:00.000Z',
          },
        ],
      }),
    )
    return
  }

  if (url.pathname === '/api/calls/recent') {
    response.end(
      JSON.stringify({
        calls: [
          {
            callControlId: 'call-snapshot',
            leadName: 'Pat Snapshot',
            startedAt: '2026-06-22T12:01:00.000Z',
            duration: '0:31',
            outcome: 'completed',
          },
        ],
      }),
    )
    return
  }

  if (url.pathname === '/api/communication-threads') {
    response.end(
      JSON.stringify({
        schemaVersion: 'speak.communication-threads.v1',
        threads: [
          {
            threadId: 'thread-snapshot',
            contactId: 'lead-snapshot',
            status: 'open',
            channels: ['call', 'sms'],
            participants: [{ role: 'contact', contactId: 'lead-snapshot', label: 'Pat Snapshot' }],
            summary: 'Pat asked for a pricing follow-up by text.',
            updatedAt: '2026-06-22T12:02:00.000Z',
          },
        ],
      }),
    )
    return
  }

  if (url.pathname === '/api/agent-configs/speak-options') {
    const sendOptions = () => {
      if (!response.writableEnded) {
        response.end(JSON.stringify({ ok: true, configs: [], voices: [] }))
      }
    }
    if (delaySpeakOptionsMs > 0) setTimeout(sendOptions, delaySpeakOptionsMs)
    else sendOptions()
    return
  }

  response.statusCode = 404
  response.end(JSON.stringify({ error: 'not found' }))
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

try {
  const address = server.address()
  const apiRoot = `http://127.0.0.1:${address.port}/api`
  const options = {
    apiRoot,
    basePath: '/speak',
    publicBaseUrl: 'https://speak.example.com/speak',
    limit: 12,
    authorizationMode: 'yolo',
  }
  const library = await renderSpeakUiSnapshot({ ...options, surface: 'library' })
  const dialer = await renderSpeakUiSnapshot({ ...options, surface: 'dialer' })
  const configs = await renderSpeakUiSnapshot({ ...options, surface: 'configs' })

  validateSnapshot('library', library)
  validateSnapshot('dialer', dialer)
  validateSnapshot('configs', configs)

  if (library.structuredContent?.library?.smartViewCount !== 1) {
    failures.push('library snapshot did not include test smart view count')
  }
  if (library.structuredContent?.communicationThreads?.total !== 1) {
    failures.push('library snapshot did not include communication thread count')
  }
  if (dialer.structuredContent?.queue?.total !== 1) {
    failures.push('dialer snapshot did not include test lead count')
  }
  if (dialer.structuredContent?.communicationThreads?.items?.[0]?.threadId !== 'thread-snapshot') {
    failures.push('dialer snapshot did not include communication thread item')
  }
  if (configs.structuredContent?.profiles?.total !== 1) {
    failures.push('configs snapshot did not include test profile count')
  }
  if (!configs.structuredContent?.profiles?.optionsAvailable) {
    failures.push('configs snapshot did not include Speak options availability')
  }

  delaySpeakOptionsMs = 250
  const degradedStartedAt = Date.now()
  const degradedConfigs = await renderSpeakUiSnapshot({
    ...options,
    surface: 'configs',
    providerOptionsTimeoutMs: 25,
  })
  const degradedElapsedMs = Date.now() - degradedStartedAt
  if (degradedElapsedMs >= 150) {
    failures.push(`configs snapshot waited ${degradedElapsedMs}ms for provider options`)
  }
  if (degradedConfigs.structuredContent?.profiles?.optionsAvailable) {
    failures.push('configs snapshot did not degrade cleanly when provider options timed out')
  }

  if (failures.length > 0) {
    console.error(JSON.stringify({ ok: false, failures }, null, 2))
    process.exitCode = 1
  } else {
    console.log(
      JSON.stringify(
        {
          ok: true,
          schemaVersion: dialer.schemaVersion,
          surfaces: [library.surface, dialer.surface, configs.surface],
          dialerEvents: dialer.agUi.events.map((event) => event.type),
          configsMessages: configs.a2ui.messages.map((message) => message.type),
        },
        null,
        2,
      ),
    )
  }
} finally {
  await new Promise((resolve) => server.close(resolve))
}

function validateSnapshot(expectedSurface, snapshot) {
  if (snapshot.schemaVersion !== 'speak.ui-runtime-snapshot.v1') {
    failures.push(`${expectedSurface} snapshot schema mismatch`)
  }
  if (snapshot.surface !== expectedSurface) {
    failures.push(`${expectedSurface} snapshot returned surface ${snapshot.surface}`)
  }
  if (snapshot.genericHost?.hydrateMessage?.detail?.structuredContent?.surface !== expectedSurface) {
    failures.push(`${expectedSurface} generic hydrate message missing structuredContent`)
  }
  ;['RunStarted', 'ToolCallStart', 'ToolCallArgs', 'ToolCallEnd', 'ToolCallResult', 'StateSnapshot', 'RunFinished'].forEach(
    (type) => {
      if (!snapshot.agUi?.events?.some((event) => event.type === type)) {
        failures.push(`${expectedSurface} AG-UI snapshot missing ${type}`)
      }
    },
  )
  const stateSnapshot = snapshot.agUi?.events?.find((event) => event.type === 'StateSnapshot')
  if (stateSnapshot?.snapshot?.surface !== expectedSurface) {
    failures.push(`${expectedSurface} AG-UI StateSnapshot missing live snapshot`)
  }
  const dataModel = snapshot.a2ui?.messages?.find((message) => message.type === 'updateDataModel')
  if (dataModel?.value?.surface !== expectedSurface) {
    failures.push(`${expectedSurface} A2UI updateDataModel missing live value`)
  }
  if (snapshot.aiSdk?.props?.surface !== expectedSurface) {
    failures.push(`${expectedSurface} AI SDK props missing live structuredContent`)
  }
  if (snapshot.mcpUi?.hydrateMessageType !== 'speak:hydrate') {
    failures.push(`${expectedSurface} MCP UI snapshot missing hydrate bridge`)
  }
  if (snapshot.jsonRender?.props?.surface !== expectedSurface) {
    failures.push(`${expectedSurface} JSON Render props missing live structuredContent`)
  }
  if (snapshot.copilotKit?.props?.surface !== expectedSurface) {
    failures.push(`${expectedSurface} CopilotKit props missing live structuredContent`)
  }
}
