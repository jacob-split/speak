import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { createServer as createViteServer } from 'vite'

export async function checkPlaygroundSessionLifecycle() {
  let browser
  let vite

  try {
    vite = await createViteServer({
      appType: 'custom',
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'speak-playground-session-lifecycle-check',
          resolveId(id) {
            return id === 'virtual:speak-playground-session-lifecycle-check'
              ? '\0virtual:speak-playground-session-lifecycle-check'
              : null
          },
          load(id) {
            if (id !== '\0virtual:speak-playground-session-lifecycle-check') return null
            return `
              import React from 'react'
              import * as ReactDOM from 'react-dom/client'
              import { useConfigurationTestSession } from '/src/useConfigurationTestSession.ts'

              export { React, ReactDOM, useConfigurationTestSession }
            `
          },
          configureServer(server) {
            server.middlewares.use((request, response, next) => {
              if (String(request.url || '').split('?')[0] !== '/__speak_playground_lifecycle__') {
                next()
                return
              }
              response.statusCode = 200
              response.setHeader('Content-Type', 'text/html; charset=utf-8')
              response.end('<!doctype html><html><body></body></html>')
            })
          },
        },
      ],
      root: process.cwd(),
      server: {
        host: '127.0.0.1',
        port: 0,
        strictPort: false,
      },
    })
    await vite.listen()
    const address = vite.httpServer?.address()
    if (!address || typeof address === 'string') {
      throw new Error('temporary Vite server did not expose a local port')
    }

    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${address.port}/__speak_playground_lifecycle__`, {
      waitUntil: 'domcontentloaded',
    })
    const result = await runHookLifecycleScenario(page)
    const failures = []

    if (!result.active.captureContextResumed) {
      failures.push('Browser microphone AudioContext remained suspended')
    }
    if (!result.active.playbackContextResumed) {
      failures.push('Browser playback AudioContext remained suspended')
    }
    if (!result.active.microphoneFramesAre20Ms) {
      failures.push('Browser microphone did not emit exact 20 ms PCM frames')
    }
    if (!result.active.remoteEndReleasedTransport) {
      failures.push('provider-ended Browser session retained microphone, socket, or audio context')
    }
    if (!result.active.remoteEndClearedSession) {
      failures.push('provider-ended Browser session remained locally live')
    }
    if (!result.pending.remoteEndInvalidatedStart) {
      failures.push('provider-ended Browser session raced pending getUserMedia back to live')
    }
    if (!result.pending.lateTrackReleased) {
      failures.push('late getUserMedia result retained a microphone track after provider end')
    }
    if (!result.orphan.pendingStartCanceledOnUnmount) {
      failures.push('pending Browser start was not canceled during unmount')
    }
    if (!result.orphan.lateStartEnded) {
      failures.push('late Browser start response was not reconciled as ended')
    }
    if (!result.canceled.pendingStartSettledStatus) {
      failures.push('canceled pending Browser start remained stuck in an ending status')
    }

    return {
      ok: failures.length === 0,
      schemaVersion: 'speak.playground-session-lifecycle-check.v1',
      failures,
      ...result,
    }
  } catch (error) {
    return {
      ok: false,
      schemaVersion: 'speak.playground-session-lifecycle-check.v1',
      failures: [error instanceof Error ? error.message : String(error)],
    }
  } finally {
    await browser?.close().catch(() => undefined)
    await vite?.close().catch(() => undefined)
  }
}

async function runHookLifecycleScenario(page) {
  return page.evaluate(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const {
      React,
      ReactDOM,
      useConfigurationTestSession,
    } = await import('/@id/__x00__virtual:speak-playground-session-lifecycle-check')
    const savedDescriptors = new Map(
      ['AudioContext', 'EventSource', 'WebSocket'].map((key) => [
        key,
        Object.getOwnPropertyDescriptor(globalThis, key),
      ]),
    )
    const savedMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
    const savedSendBeacon = Object.getOwnPropertyDescriptor(navigator, 'sendBeacon')
    const contexts = []
    const eventSources = []
    const immediateStreams = []
    const processors = []
    const sockets = []
    const pendingMedia = []
    let mediaMode = 'immediate'
    let nextSession = 0
    let deferredStartResponse = null
    const fetchCalls = []
    const beaconCalls = []

    function makeTrack(label) {
      return {
        label,
        stopCalls: 0,
        stop() {
          this.stopCalls += 1
        },
      }
    }

    function makeStream(label) {
      const track = makeTrack(label)
      return {
        label,
        track,
        getTracks() {
          return [track]
        },
      }
    }

    class MockAudioContext {
      constructor() {
        this.closeCalls = 0
        this.currentTime = 0
        this.destination = {}
        this.index = contexts.length
        this.kind = ''
        this.resumeCalls = 0
        this.sampleRate = 48_000
        this.state = 'suspended'
        contexts.push(this)
      }

      async close() {
        this.closeCalls += 1
        this.state = 'closed'
      }

      createBuffer(_channels, sampleCount, sampleRate) {
        this.kind = 'playback'
        return {
          duration: sampleCount / sampleRate,
          getChannelData() {
            return new Float32Array(sampleCount)
          },
        }
      }

      createBufferSource() {
        const source = {
          connect() {},
          disconnect() {},
          onended: null,
          start() {
            queueMicrotask(() => source.onended?.())
          },
          stop() {},
        }
        return source
      }

      createMediaStreamSource() {
        this.kind = 'capture'
        return {
          connect() {},
          disconnect() {},
        }
      }

      createScriptProcessor(bufferSize) {
        const processor = {
          bufferSize,
          connect() {},
          disconnect() {},
          onaudioprocess: null,
        }
        processors.push(processor)
        return processor
      }

      async resume() {
        this.resumeCalls += 1
        this.state = 'running'
      }
    }

    class MockEventSource {
      constructor(url) {
        this.closeCalls = 0
        this.onmessage = null
        this.onerror = null
        this.url = url
        eventSources.push(this)
      }

      close() {
        this.closeCalls += 1
      }

      emit(payload) {
        this.onmessage?.({ data: JSON.stringify(payload) })
      }
    }

    class MockWebSocket {
      static CLOSED = 3
      static CLOSING = 2
      static CONNECTING = 0
      static OPEN = 1

      constructor(url) {
        this.closeCalls = 0
        this.onmessage = null
        this.onopen = null
        this.onerror = null
        this.readyState = MockWebSocket.CONNECTING
        this.sent = []
        this.url = url
        sockets.push(this)
        queueMicrotask(() => {
          if (this.readyState !== MockWebSocket.CONNECTING) return
          this.readyState = MockWebSocket.OPEN
          this.onopen?.()
        })
      }

      close() {
        this.closeCalls += 1
        this.readyState = MockWebSocket.CLOSED
      }

      emitAudio() {
        this.onmessage?.({
          data: JSON.stringify({
            type: 'audio',
            data: 'AQACAAMABAA=',
            sampleRate: 16_000,
          }),
        })
      }

      send(data) {
        this.sent.push(data)
      }
    }

    const mockGetUserMedia = () => {
      const stream = makeStream(`stream-${pendingMedia.length + 1}`)
      if (mediaMode === 'immediate') {
        immediateStreams.push(stream)
        return Promise.resolve(stream)
      }
      return new Promise((resolve) => {
        pendingMedia.push({ resolve, stream })
      })
    }

    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: MockAudioContext,
      writable: true,
    })
    Object.defineProperty(globalThis, 'EventSource', {
      configurable: true,
      value: MockEventSource,
      writable: true,
    })
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: MockWebSocket,
      writable: true,
    })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: mockGetUserMedia },
    })
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: (url) => {
        beaconCalls.push(String(url))
        return true
      },
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (input, init = {}) => {
      const url = String(input)
      fetchCalls.push({ body: String(init.body || ''), method: init.method || 'GET', url })
      if (/\/config-tests\/start$/.test(url)) {
        nextSession += 1
        if (deferredStartResponse) {
          return new Promise((resolve) => {
            deferredStartResponse.resolve = resolve
          })
        }
        return Promise.resolve(
          new Response(JSON.stringify({ testId: `browser-${nextSession}` }), {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          }),
        )
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      )
    }

    async function flush(count = 6) {
      for (let index = 0; index < count; index += 1) await Promise.resolve()
    }

    async function mountSession() {
      const host = document.createElement('div')
      document.body.append(host)
      const root = ReactDOM.createRoot(host)
      let session

      function Harness() {
        session = useConfigurationTestSession({
          buildStartPayload: () => ({
            config: { sampleRate: 16_000 },
            testVariableKeys: [],
            testVariables: {},
          }),
        })
        return null
      }

      await React.act(async () => {
        root.render(React.createElement(Harness))
      })
      return {
        host,
        root,
        session: () => session,
      }
    }

    try {
      const activeMount = await mountSession()
      let activeStartResult
      await React.act(async () => {
        activeStartResult = await activeMount.session().start()
      })
      const activeProcessor = processors.at(-1)
      const microphoneInput = new Float32Array(activeProcessor?.bufferSize || 1024)
      microphoneInput.fill(0.1)
      activeProcessor?.onaudioprocess?.({
        inputBuffer: {
          getChannelData: () => microphoneInput,
        },
        outputBuffer: {
          getChannelData: () => new Float32Array(microphoneInput.length),
        },
      })
      await React.act(async () => {
        sockets.at(-1)?.emitAudio()
        await flush()
      })
      const activeContexts = contexts.slice()
      const activeStream = immediateStreams.at(-1)
      const activeSocket = sockets.at(-1)
      const activeEvents = eventSources.at(-1)
      await React.act(async () => {
        activeEvents.emit({
          notice: 'Playground test ended',
          patch: { phase: 'ended' },
        })
        await flush()
      })
      const activeState = activeMount.session()
      const active = {
        captureContextResumed: activeContexts.some(
          (context) => context.kind === 'capture' && context.resumeCalls > 0,
        ),
        playbackContextResumed: activeContexts.some(
          (context) => context.kind === 'playback' && context.resumeCalls > 0,
        ),
        microphoneFramesAre20Ms: activeSocket.sent.some(
          (frame) => frame instanceof ArrayBuffer && frame.byteLength === 640,
        ),
        remoteEndClearedSession:
          activeStartResult === 'browser-1' &&
          activeState.running === false &&
          activeState.sessionId === '',
        remoteEndReleasedTransport:
          activeSocket.closeCalls > 0 &&
          activeEvents.closeCalls > 0 &&
          activeContexts.length >= 2 &&
          activeContexts.every((context) => context.closeCalls > 0) &&
          activeStream.track.stopCalls > 0,
      }
      await React.act(async () => {
        activeMount.root.unmount()
      })
      activeMount.host.remove()

      mediaMode = 'deferred'
      const pendingMount = await mountSession()
      const pendingContextCount = contexts.length
      let pendingStart
      await React.act(async () => {
        pendingStart = pendingMount.session().start()
        await flush()
      })
      const lateMedia = pendingMedia.at(-1)
      const pendingSocket = sockets.at(-1)
      const pendingEvents = eventSources.at(-1)
      await React.act(async () => {
        pendingEvents.emit({
          notice: 'Playground test ended',
          patch: { phase: 'ended' },
        })
        await flush()
      })
      let pendingStartResult
      await React.act(async () => {
        lateMedia.resolve(lateMedia.stream)
        pendingStartResult = await pendingStart
        await flush()
      })
      const pendingState = pendingMount.session()
      const pending = {
        lateTrackReleased: lateMedia.stream.track.stopCalls > 0,
        remoteEndInvalidatedStart:
          pendingStartResult === null &&
          pendingState.running === false &&
          pendingState.sessionId === '' &&
          contexts.length === pendingContextCount &&
          pendingSocket.closeCalls > 0,
      }
      await React.act(async () => {
        pendingMount.root.unmount()
      })
      pendingMount.host.remove()

      deferredStartResponse = {}
      const canceledMount = await mountSession()
      let canceledStart
      await React.act(async () => {
        canceledStart = canceledMount.session().start()
        await flush()
      })
      await React.act(async () => {
        await canceledMount.session().end()
        await flush()
      })
      deferredStartResponse.resolve(
        new Response(JSON.stringify({ testId: 'browser-canceled-control' }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      )
      let canceledStartResult
      await React.act(async () => {
        canceledStartResult = await canceledStart
        await flush()
      })
      const canceledState = canceledMount.session()
      const canceled = {
        pendingStartSettledStatus:
          canceledStartResult === null &&
          canceledState.ending === false &&
          canceledState.status === 'Playground test ended',
      }
      await React.act(async () => {
        canceledMount.root.unmount()
      })
      canceledMount.host.remove()

      deferredStartResponse = {}
      const orphanMount = await mountSession()
      let orphanStart
      await React.act(async () => {
        orphanStart = orphanMount.session().start()
        await flush()
      })
      const orphanStartCall = fetchCalls.findLast((call) =>
        /\/config-tests\/start$/.test(call.url),
      )
      const orphanStartRequestId = JSON.parse(orphanStartCall?.body || '{}').startRequestId
      await React.act(async () => {
        orphanMount.root.unmount()
        await flush()
      })
      orphanMount.host.remove()
      deferredStartResponse.resolve(
        new Response(JSON.stringify({ testId: 'browser-orphan' }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      )
      let orphanStartResult
      await React.act(async () => {
        orphanStartResult = await orphanStart
        await flush()
      })
      const orphan = {
        lateStartEnded:
          orphanStartResult === null &&
          fetchCalls.some((call) => /\/config-tests\/browser-orphan\/end$/.test(call.url)),
        pendingStartCanceledOnUnmount:
          Boolean(orphanStartRequestId) &&
          beaconCalls.some((url) =>
            url.endsWith(
              `/playground-starts/${encodeURIComponent(orphanStartRequestId)}/cancel`,
            ),
          ),
      }

      return { active, canceled, orphan, pending }
    } finally {
      globalThis.fetch = originalFetch
      for (const [key, descriptor] of savedDescriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else delete globalThis[key]
      }
      if (savedMediaDevices) {
        Object.defineProperty(navigator, 'mediaDevices', savedMediaDevices)
      } else {
        delete navigator.mediaDevices
      }
      if (savedSendBeacon) {
        Object.defineProperty(navigator, 'sendBeacon', savedSendBeacon)
      } else {
        delete navigator.sendBeacon
      }
    }
  })
}

const directInvocation =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (directInvocation) {
  const result = await checkPlaygroundSessionLifecycle()
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}
