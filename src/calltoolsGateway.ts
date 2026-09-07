import {
  Invitation,
  Registerer,
  RegistererState,
  SessionState,
  UserAgent,
  Web,
  type Session,
  type UserAgentDelegate,
} from 'sip.js'
import { formatOperationalDateTime } from './time'

type GatewayConfig = {
  gatewayInstanceId?: string
  profileId: string
  profileName: string
  registrationEnabled?: boolean
  sampleRate: number
  gatewayWebSocketUrl: string
  phone: {
    id: string
    server: string
    uri: string
    authorizationUsername: string
    authorizationPassword: string
    isWebRtc: boolean
    extension?: string
  }
}

type GatewayMessage = {
  type: string
  gatewayInstanceId?: string
  callControlId?: string
  streamId?: string
  profileId?: string
  profileName?: string
  phoneId?: string
  audio?: string
  sampleRate?: number
  frameMs?: number
  outcome?: string
  reason?: string
  code?: string
  error?: string
  ok?: boolean
  enabled?: boolean
  requestId?: string
  diagnostic?: Record<string, unknown>
}

type PlaybackSink = {
  enqueue(samples: Float32Array): void
  clear(): void
  dispose(): void
}

type CallPreparationOutcome = {
  status: 'prepared' | 'rejected'
  streamId: string
  callControlId?: string
  code?: string
  error?: string
}

type PendingCallPreparation = {
  streamId: string
  timeoutId: number
  resolve: (outcome: CallPreparationOutcome) => void
}

const params = new URLSearchParams(window.location.search)
const profileId = params.get('profileId') || ''
const token = params.get('token') || ''
const gatewayInstanceId = crypto.randomUUID()
const statusEl = document.getElementById('status')
const logEl = document.getElementById('log')
const CALLTOOLS_INPUT_FRAME_MS = 20
const CALLTOOLS_MAX_CAPTURE_BUFFER_MS = 250
const CALLTOOLS_PRE_READY_AUDIO_MAX_MS = 3000
const CALLTOOLS_REMOTE_TRACK_RECHECK_MS = 100
const CALLTOOLS_REMOTE_NONZERO_PEAK = 0.001
const CALLTOOLS_REMOTE_SILENCE_DIAGNOSTIC_FRAMES = 75
const CALLTOOLS_CONTROL_LOSS_UNREGISTER_MS = 8_000
const CALLTOOLS_PREPARE_ACK_TIMEOUT_MS = 1250

// CALLTOOLS_PRE_READY_AUDIO_BUFFER_START
function createPreReadyAudioBuffer(maxFrames = 1) {
  const frames = [new Uint8Array(0)]
  frames.length = 0
  const limit = Math.max(1, Math.floor(Number(maxFrames) || 1))
  let ready = false
  let maxBufferedFrames = 0
  let droppedFrames = 0
  let flushedFrames = 0
  let flushCount = 0

  return {
    push(frame = new Uint8Array(0)) {
      if (ready) return false
      frames.push(new Uint8Array(frame))
      if (frames.length > limit) {
        const overflow = frames.length - limit
        frames.splice(0, overflow)
        droppedFrames += overflow
      }
      maxBufferedFrames = Math.max(maxBufferedFrames, frames.length)
      return true
    },
    markReady() {
      if (ready) return []
      ready = true
      flushCount += 1
      const drained = frames.splice(0, frames.length)
      flushedFrames += drained.length
      return drained
    },
    clear() {
      frames.length = 0
      ready = false
      maxBufferedFrames = 0
      droppedFrames = 0
      flushedFrames = 0
      flushCount = 0
    },
    snapshot() {
      return {
        ready,
        bufferedFrames: frames.length,
        maxBufferedFrames,
        droppedFrames,
        flushedFrames,
        flushCount,
      }
    },
  }
}
// CALLTOOLS_PRE_READY_AUDIO_BUFFER_END

let config: GatewayConfig
let gatewaySocket: WebSocket | null = null
let userAgent: UserAgent | null = null
let registerer: Registerer | null = null
let activeSession: Session | null = null
let activeCallControlId = ''
let activeStreamId = ''
let activeCallToolsCallId = ''
let activeCallStarted = false
let activeCallEndedNotified = false
let activeCallRejected = false
let targetSampleRate = 16000
let audioContext: AudioContext
let localDestination: MediaStreamAudioDestinationNode
let playbackSink: PlaybackSink
let remoteCaptureCleanup: (() => void) | null = null
let outboundAudioStatsTimers: number[] = []
let playbackWorkletReady: Promise<void> | null = null
let recorderWorkletReady: Promise<void> | null = null
let gatewaySocketUrl = ''
let gatewayReconnectTimer = 0
let gatewayReconnectAttempts = 0
let gatewayHeartbeatTimer = 0
let gatewayReadyPublishedSocket: WebSocket | null = null
let gatewayControlConnectedOnce = false
let controlLossSipUnregisterTimer = 0
let gatewayRegistrationReconciledSocket: WebSocket | null = null
let registrationDesired = false
let sipConnected = false
let sipRegistered = false
let playbackMode = 'uninitialized'
let captureMode = 'uninitialized'
let syntheticStreamSerial = 0
let activeOutputPacketCount = 0
let lastOutputStatsDiagnosticAt = 0
let activeCallPrepared = false
let pendingCallPreparation: PendingCallPreparation | null = null
const preReadyAudioBuffer = createPreReadyAudioBuffer(
  Math.ceil(CALLTOOLS_PRE_READY_AUDIO_MAX_MS / CALLTOOLS_INPUT_FRAME_MS),
)

void boot().catch((error) => {
  updateStatus('Gateway failed')
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`)
})

async function boot() {
  if (!token) throw new Error('token query parameter is required')
  config = await readGatewayConfig()
  registrationDesired = config.registrationEnabled === true
  targetSampleRate = Number(config.sampleRate || 16000)
  await setupSyntheticLocalAudio()
  await connectGatewaySocket(config.gatewayWebSocketUrl)
  initializeSipPhone()
  document.body.dataset.gatewayProcessReady = 'true'
  if (registrationDesired) {
    await setSipPhoneRegistration(true)
  }
  syncGatewayReadinessUi()
  updateStatus(
    sipRegistered
      ? `Registered ${config.profileName || config.profileId}`
      : `Registering ${config.profileName || config.profileId}`,
  )
}

async function readGatewayConfig(): Promise<GatewayConfig> {
  const url = new URL('api/calltools/gateway-config', window.location.href)
  if (profileId) url.searchParams.set('profileId', profileId)
  url.searchParams.set('instanceId', gatewayInstanceId)
  url.searchParams.set('token', token)
  const response = await fetch(url)
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload.error || `Gateway config failed (${response.status})`)
  }
  return response.json()
}

async function setupSyntheticLocalAudio() {
  audioContext = createAudioContext()
  audioContext.addEventListener('statechange', () => {
    publishGatewayHealth()
  })
  await resetSyntheticLocalAudioForCall('startup')
  await audioContext.resume()
}

async function resetSyntheticLocalAudioForCall(reason: string) {
  playbackSink?.dispose()
  localDestination?.stream.getTracks().forEach((track) => track.stop())
  localDestination = audioContext.createMediaStreamDestination()
  playbackSink = await createPlaybackSink(audioContext, localDestination)
  await audioContext.resume()
  syntheticStreamSerial += 1
  document.body.dataset.localStreamSerial = String(syntheticStreamSerial)
  log(
    `audio: synthetic local stream reset ${reason} serial=${syntheticStreamSerial} tracks=${
      localDestination.stream.getAudioTracks().length
    }`,
  )
  publishGatewayHealth()
}

async function connectGatewaySocket(url: string) {
  gatewaySocketUrl = url
  while (true) {
    try {
      await connectGatewaySocketOnce(url)
      return
    } catch (error) {
      const delay = nextGatewayReconnectDelay()
      updateStatus('Speak gateway reconnecting')
      log(`gateway: reconnect in ${Math.round(delay / 1000)}s after ${errorMessage(error)}`)
      await wait(delay)
    }
  }
}

async function connectGatewaySocketOnce(url: string) {
  stopGatewayHeartbeat()
  clearGatewayReconnect()
  const socket = new WebSocket(url)
  gatewaySocket = socket
  socket.addEventListener('message', (event) => {
    handleGatewayMessage(JSON.parse(String(event.data)) as GatewayMessage)
  })

  await new Promise<void>((resolve, reject) => {
    let opened = false
    socket.addEventListener(
      'open',
      () => {
        const reconnecting = gatewayControlConnectedOnce
        opened = true
        gatewayControlConnectedOnce = true
        gatewayReconnectAttempts = 0
        gatewayReadyPublishedSocket = null
        if (!reconnecting) gatewayRegistrationReconciledSocket = socket
        sendGatewayReady()
        sendGatewayHeartbeat()
        startGatewayHeartbeat()
        resolve()
        if (reconnecting) {
          void reconcileRegistrationDesiredFromBackend(socket).catch((error) => {
            log(`gateway: registration reconciliation failed ${errorMessage(error)}`)
          })
        }
      },
      { once: true },
    )
    socket.addEventListener(
      'error',
      () => reject(new Error('Gateway socket connection failed')),
      { once: true },
    )
    socket.addEventListener('close', () => {
      if (gatewaySocket !== socket) return
      stopGatewayHeartbeat()
      gatewayReadyPublishedSocket = null
      if (gatewayRegistrationReconciledSocket === socket) {
        gatewayRegistrationReconciledSocket = null
      }
      scheduleControlLossSipUnregister()
      updateStatus('Speak gateway disconnected')
      document.body.dataset.gatewayReady = 'false'
      if (activeSession && activeSession.state !== SessionState.Terminated) {
        void hangupActiveCall('failed')
      }
      if (!opened) {
        reject(new Error('Gateway socket closed before registration'))
        return
      }
      if (opened) scheduleGatewayReconnect()
    })
  })
}

function sendGatewayReady() {
  if (!sipRegistered) return
  if (!gatewayTransportHealthy()) return
  if (gatewayReadyPublishedSocket === gatewaySocket) return
  gatewayReadyPublishedSocket = gatewaySocket
  sendGateway({
    type: 'gateway.ready',
    profileId: config.profileId,
    profileName: config.profileName,
    phoneId: config.phone.id,
    sampleRate: targetSampleRate,
    ...gatewayHealthPayload(),
  })
}

function sendGatewayHeartbeat() {
  sendGateway({
    type: 'gateway.heartbeat',
    profileId: config.profileId,
    profileName: config.profileName,
    phoneId: config.phone.id,
    sampleRate: targetSampleRate,
    ...gatewayHealthPayload(),
  })
}

function startGatewayHeartbeat() {
  stopGatewayHeartbeat()
  gatewayHeartbeatTimer = window.setInterval(() => {
    sendGatewayHeartbeat()
  }, 15000)
}

function gatewayHealthPayload() {
  const localAudioTracks = localDestination?.stream.getAudioTracks() || []
  const localAudioTrackHealthy = localAudioTracks.some(
    (track) => track.enabled && track.readyState === 'live',
  )
  return {
    gatewayInstanceId,
    sipConnected,
    sipRegistered,
    audioContextState: audioContext?.state || 'unavailable',
    localAudioTrackHealthy,
    localAudioTrackLive: localAudioTrackHealthy,
    localAudioTrackCount: localAudioTracks.length,
    playbackMode,
    captureMode,
    localAudioTracks: localAudioTracks.map((track) => ({
      enabled: track.enabled,
      muted: track.muted,
      readyState: track.readyState,
    })),
  }
}

function gatewayTransportHealthy() {
  const health = gatewayHealthPayload()
  return Boolean(
    gatewaySocket?.readyState === WebSocket.OPEN &&
      health.sipConnected &&
      health.sipRegistered &&
      health.audioContextState === 'running' &&
      health.localAudioTrackHealthy,
  )
}

function syncGatewayReadinessUi() {
  document.body.dataset.gatewayReady = String(gatewayTransportHealthy())
}

function publishGatewayHealth() {
  syncGatewayReadinessUi()
  if (gatewayTransportHealthy()) {
    sendGatewayReady()
  } else {
    gatewayReadyPublishedSocket = null
  }
  sendGatewayHeartbeat()
}

function stopGatewayHeartbeat() {
  if (!gatewayHeartbeatTimer) return
  window.clearInterval(gatewayHeartbeatTimer)
  gatewayHeartbeatTimer = 0
}

function scheduleGatewayReconnect() {
  if (!gatewaySocketUrl || gatewayReconnectTimer) return
  const delay = nextGatewayReconnectDelay()
  gatewayReconnectTimer = window.setTimeout(() => {
    gatewayReconnectTimer = 0
    void connectGatewaySocketOnce(gatewaySocketUrl)
      .then(() => {
        syncGatewayReadinessUi()
        updateStatus(
          gatewayTransportHealthy()
            ? `Registered ${config.profileName || config.profileId}`
            : `Speak gateway connected; SIP unavailable`,
        )
      })
      .catch((error) => {
        log(`gateway: reconnect failed ${errorMessage(error)}`)
        scheduleGatewayReconnect()
      })
  }, delay)
}

function clearGatewayReconnect() {
  if (!gatewayReconnectTimer) return
  window.clearTimeout(gatewayReconnectTimer)
  gatewayReconnectTimer = 0
}

async function reconcileRegistrationDesiredFromBackend(expectedSocket = gatewaySocket) {
  const nextConfig = await readGatewayConfig()
  if (
    !expectedSocket ||
    gatewaySocket !== expectedSocket ||
    expectedSocket.readyState !== WebSocket.OPEN
  ) {
    throw new Error('Gateway control changed before registration reconciliation completed')
  }
  const samePhone = String(nextConfig.phone?.id || '') === String(config.phone?.id || '')
  registrationDesired = Boolean(nextConfig.registrationEnabled && samePhone)
  if (samePhone) {
    config = {
      ...config,
      profileId: nextConfig.profileId,
      profileName: nextConfig.profileName,
      registrationEnabled: nextConfig.registrationEnabled,
      sampleRate: nextConfig.sampleRate,
    }
    targetSampleRate = Number(nextConfig.sampleRate || targetSampleRate)
  }
  await setSipPhoneRegistration(registrationDesired)
  if (gatewaySocket !== expectedSocket || expectedSocket.readyState !== WebSocket.OPEN) {
    throw new Error('Gateway control changed while registration reconciliation was applied')
  }
  gatewayRegistrationReconciledSocket = expectedSocket
  clearControlLossSipUnregister()
}

function scheduleControlLossSipUnregister() {
  if (controlLossSipUnregisterTimer) return
  controlLossSipUnregisterTimer = window.setTimeout(() => {
    controlLossSipUnregisterTimer = 0
    if (
      gatewaySocket?.readyState === WebSocket.OPEN &&
      gatewayRegistrationReconciledSocket === gatewaySocket
    ) return
    registrationDesired = false
    void setSipPhoneRegistration(false).catch((error) => {
      log(`gateway: control-loss SIP release deferred ${errorMessage(error)}`)
    })
  }, CALLTOOLS_CONTROL_LOSS_UNREGISTER_MS)
}

function clearControlLossSipUnregister() {
  if (!controlLossSipUnregisterTimer) return
  window.clearTimeout(controlLossSipUnregisterTimer)
  controlLossSipUnregisterTimer = 0
}

function nextGatewayReconnectDelay() {
  const delay = Math.min(30000, 1000 * 2 ** Math.min(gatewayReconnectAttempts, 5))
  gatewayReconnectAttempts += 1
  return delay
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function initializeSipPhone() {
  const uri = UserAgent.makeURI(config.phone.uri)
  if (!uri) throw new Error('CallTools SIP URI is invalid')
  if (!config.phone.server.startsWith('wss://')) {
    throw new Error('CallTools phone must expose a SIP over WSS server URL')
  }

  const delegate: UserAgentDelegate = {
    onConnect: () => {
      sipConnected = true
      log('sip: connected')
      publishGatewayHealth()
    },
    onDisconnect: (error) => {
      sipConnected = false
      sipRegistered = false
      gatewayReadyPublishedSocket = null
      sendGatewayHeartbeat()
      syncGatewayReadinessUi()
      log(`sip: disconnected${error ? ` ${error.message}` : ''}`)
    },
    onInvite: (invitation) => {
      void answerInvitation(invitation).catch((error) => {
        log(`sip: invite handling failed ${errorMessage(error)}`)
        if (invitation === activeSession) void hangupActiveCall('failed')
      })
    },
  }

  userAgent = new UserAgent({
    uri,
    authorizationUsername: config.phone.authorizationUsername,
    authorizationPassword: config.phone.authorizationPassword,
    delegate,
    displayName: 'Speak',
    logBuiltinEnabled: false,
    logConfiguration: false,
    logLevel: 'warn',
    sessionDescriptionHandlerFactory: Web.defaultSessionDescriptionHandlerFactory(
      async () => localDestination.stream,
    ),
    sessionDescriptionHandlerFactoryOptions: {
      // CallTools cancels the post-AMD agent leg in roughly two seconds if the
      // phone has not sent its 200 response. SIP.js otherwise waits up to five
      // seconds for ICE gathering, which guarantees an abandoned human call.
      iceGatheringTimeout: 500,
      constraints: {
        audio: true,
        video: false,
      },
    },
    transportOptions: {
      server: config.phone.server,
    },
    userAgentString: 'Speak CallTools Gateway',
  })
  registerer = new Registerer(userAgent)
  registerer.stateChange.addListener((state) => {
    sipRegistered = state === RegistererState.Registered
    if (sipRegistered) {
      log(`sip: registered ${maskDialDestination(config.phone.uri)}`)
      sendGatewayReady()
    } else {
      gatewayReadyPublishedSocket = null
      sendGatewayHeartbeat()
    }
    syncGatewayReadinessUi()
  })
}

async function answerInvitation(invitation: Invitation) {
  if (!registrationDesired) {
    log('sip: rejected inbound call while Speak is Unavailable')
    await invitation.reject({ statusCode: 480, reasonPhrase: 'Speak agent unavailable' })
    return
  }
  if (!gatewayTransportHealthy()) {
    log('sip: rejected inbound call while Speak gateway transport is unavailable')
    await invitation.reject({ statusCode: 480, reasonPhrase: 'Speak gateway unavailable' })
    return
  }

  if (activeSession && activeSession.state !== SessionState.Terminated) {
    await invitation.reject({ statusCode: 486, reasonPhrase: 'Speak gateway busy' })
    return
  }

  activeSession = invitation
  activeCallControlId = ''
  activeStreamId = invitation.id || invitation.request.callId || crypto.randomUUID()
  activeCallToolsCallId = invitation.request.callId || activeStreamId
  activeCallStarted = false
  activeCallEndedNotified = false
  activeCallRejected = false
  activeCallPrepared = false
  activeOutputPacketCount = 0
  lastOutputStatsDiagnosticAt = 0
  preReadyAudioBuffer.clear()
  const inviteReceivedAt = performance.now()
  invitation.delegate = {
    onCancel: () => {
      log(`call: canceled ${activeCallToolsCallId} state=${invitation.state}`)
    },
  }
  invitation.stateChange.addListener((state) => {
    log(`call: sip state ${state.toLowerCase()} ${activeCallToolsCallId}`)
    handleSessionState(invitation, state)
  })
  const preparationPromise = waitForCallPreparation(activeStreamId)
  announceCallPrepare(invitation)
  const preparation = await preparationPromise
  if (!callPreparationAccepted(preparation)) {
    activeCallRejected = true
    log(`call: backend rejected ${activeCallToolsCallId} ${preparation.code || 'prepare-failed'}`)
    if (
      invitation === activeSession &&
      invitation.state !== SessionState.Terminated
    ) {
      await invitation.reject({
        statusCode: 480,
        reasonPhrase: 'Speak voice runtime unavailable',
      })
    }
    if (invitation === activeSession) resetActiveCall()
    return
  }
  activeCallControlId = preparation.callControlId || activeCallControlId
  if (
    activeCallRejected ||
    invitation !== activeSession ||
    invitation.state === SessionState.Terminated
  ) return
  log(`call: accepting ${activeCallToolsCallId}`)
  await invitation.accept({
    sessionDescriptionHandlerOptions: {
      constraints: {
        audio: true,
        video: false,
      },
    },
  })
  const acceptDurationMs = Math.round(performance.now() - inviteReceivedAt)
  if (invitation.state === SessionState.Established) {
    log(`call: accepted ${activeCallToolsCallId} in ${acceptDurationMs}ms`)
  } else {
    log(`call: accept aborted ${activeCallToolsCallId} state=${invitation.state} in ${acceptDurationMs}ms`)
  }
}

// CALLTOOLS_PREPARATION_ACCEPTANCE_START
function callPreparationAccepted(result = { status: '' }) {
  return result.status === 'prepared'
}
// CALLTOOLS_PREPARATION_ACCEPTANCE_END

function waitForCallPreparation(streamId: string): Promise<CallPreparationOutcome> {
  cancelPendingCallPreparation('', 'calltools_gateway_prepare_superseded')
  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(() => {
      const pending = pendingCallPreparation
      if (!pending || pending.streamId !== streamId) return
      pendingCallPreparation = null
      pending.resolve({
        status: 'rejected',
        streamId,
        code: 'calltools_gateway_prepare_timeout',
        error: 'Speak backend preparation timed out',
      })
    }, CALLTOOLS_PREPARE_ACK_TIMEOUT_MS)
    pendingCallPreparation = { streamId, timeoutId, resolve }
  })
}

function settleCallPreparation(message: GatewayMessage) {
  const pending = pendingCallPreparation
  if (
    !pending ||
    !message.streamId ||
    message.streamId !== pending.streamId ||
    !['call.prepared', 'call.rejected'].includes(message.type)
  ) return false

  pendingCallPreparation = null
  window.clearTimeout(pending.timeoutId)
  pending.resolve({
    status: message.type === 'call.prepared' ? 'prepared' : 'rejected',
    streamId: pending.streamId,
    callControlId: message.callControlId,
    code: message.code,
    error: message.error,
  })
  return true
}

function cancelPendingCallPreparation(streamId = '', code = 'calltools_gateway_prepare_canceled') {
  const pending = pendingCallPreparation
  if (!pending || (streamId && pending.streamId !== streamId)) return false
  pendingCallPreparation = null
  window.clearTimeout(pending.timeoutId)
  pending.resolve({
    status: 'rejected',
    streamId: pending.streamId,
    code,
  })
  return true
}

function maskDialDestination(value = '') {
  if (/^sip:/i.test(value) || value.includes('@')) {
    return value.replace(/^sip:/i, 'sip:').replace(/sip:[^@]+@/i, 'sip:***@')
  }
  const digits = value.replace(/\D/g, '')
  if (digits.length <= 4) return value ? '****' : ''
  return `***${digits.slice(-4)}`
}

function handleSessionState(session: Session, state: SessionState) {
  if (session !== activeSession) return
  if (state === SessionState.Established) {
    announceCallStart(session)
    void attachRemoteAudio(session)
    return
  }

  if (state === SessionState.Terminated) {
    notifyCallEnded('provider-ended')
    resetActiveCall()
  }
}

function announceCallStart(session: Session) {
  if (activeCallStarted) return
  activeCallStarted = true
  sendGateway({
    type: 'call.start',
    profileId: config.profileId,
    profileName: config.profileName,
    callControlId: activeCallControlId,
    streamId: activeStreamId,
    calltoolsCallId: activeCallToolsCallId,
    ...callIdentityFields(session),
    sampleRate: targetSampleRate,
    answeredAt: new Date().toISOString(),
  })
  log(`call: started ${activeCallToolsCallId}`)
}

function announceCallPrepare(session: Session) {
  if (activeCallPrepared) return
  activeCallPrepared = true
  sendGateway({
    type: 'call.prepare',
    profileId: config.profileId,
    profileName: config.profileName,
    callControlId: activeCallControlId,
    streamId: activeStreamId,
    calltoolsCallId: activeCallToolsCallId,
    ...callIdentityFields(session),
    sampleRate: targetSampleRate,
    preparedAt: new Date().toISOString(),
  })
  log(`call: preparing ${activeCallToolsCallId}`)
}

function callIdentityFields(session: Session) {
  const fromUri = session.remoteIdentity.uri.toString()
  const toUri = session.localIdentity.uri.toString()
  return {
    from: session.remoteIdentity.uri.user || fromUri,
    fromName: session.remoteIdentity.displayName || '',
    fromUri,
    to: session.localIdentity.uri.user || toUri,
    toUri,
  }
}

async function attachRemoteAudio(session: Session) {
  const handler = session.sessionDescriptionHandler
  if (!(handler instanceof Web.SessionDescriptionHandler)) {
    log('call: remote audio handler unavailable')
    return
  }
  remoteCaptureCleanup?.()
  const packetizer = createPcm16Packetizer({
    sourceRate: audioContext.sampleRate,
    targetRate: targetSampleRate,
    frameMs: CALLTOOLS_INPUT_FRAME_MS,
    onFrame: (pcmFrame) => {
      if (preReadyAudioBuffer.push(new Uint8Array(pcmFrame))) return
      sendCallToolsInputFrame(pcmFrame)
    },
  })
  const captureCleanup = await startRemoteCapture(
    handler.remoteMediaStream,
    (input) => {
      packetizer.push(input)
    },
    {
      label: 'calltools-contact',
      peerConnection: handler.peerConnection,
      onDiagnostic: (diagnostic) => sendCallAudioDiagnostic(diagnostic),
    },
  )
  remoteCaptureCleanup = () => {
    captureCleanup()
    packetizer.clear()
  }
}

async function resetSipPhoneRuntime(reason: string) {
  const stoppedUserAgent = userAgent
  userAgent = null
  registerer = null
  sipConnected = false
  sipRegistered = false
  gatewayReadyPublishedSocket = null
  try {
    await stoppedUserAgent?.stop()
  } catch (error) {
    log(`sip: reset ${reason} stop deferred ${errorMessage(error)}`)
  }
  syncGatewayReadinessUi()
  if (reason === 'registration_retry') initializeSipPhone()
}

async function registerSipPhoneWithRecovery() {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!registerer || !userAgent) initializeSipPhone()
    const currentRegisterer = registerer
    const currentUserAgent = userAgent
    if (!currentRegisterer || !currentUserAgent) {
      throw new Error('CallTools SIP phone could not be initialized')
    }
    try {
      await currentUserAgent.start()
      await currentRegisterer.register()
      log(`sip: registration requested ${maskDialDestination(config.phone.uri)}`)
      const deadline = Date.now() + 8_000
      while (
        currentRegisterer === registerer &&
        currentRegisterer.state !== RegistererState.Registered &&
        Date.now() < deadline
      ) {
        await wait(50)
      }
      if (
        currentRegisterer === registerer &&
        currentRegisterer.state === RegistererState.Registered
      ) return
      throw new Error('CallTools SIP registration was not confirmed')
    } catch (error) {
      lastError = error
      if (attempt >= 1) throw error
      log(`sip: registration recovery ${errorMessage(error)}`)
      await resetSipPhoneRuntime('registration_retry')
    }
  }
  throw lastError
}

async function setSipPhoneRegistration(enabled: boolean, requestId = '') {
  registrationDesired = enabled
  if (activeSession && activeSession.state !== SessionState.Terminated) {
    throw new Error('CallTools SIP registration cannot change during a call')
  }
  if (enabled && (!registerer || !userAgent)) initializeSipPhone()
  if (!registerer || !userAgent) {
    sendGateway({
      type: 'gateway.registration.changed',
      requestId,
      enabled,
      ok: !enabled,
      ...gatewayHealthPayload(),
    })
    return
  }

  if (enabled) {
    await registerSipPhoneWithRecovery()
  } else if (registerer.state === RegistererState.Registered) {
    await registerer.unregister()
  }
  const expectedState = enabled ? RegistererState.Registered : RegistererState.Unregistered
  const deadline = Date.now() + 8_000
  while (
    (enabled ? registerer.state !== expectedState : registerer.state === RegistererState.Registered) &&
    Date.now() < deadline
  ) {
    await wait(50)
  }
  if (enabled ? registerer.state !== expectedState : registerer.state === RegistererState.Registered) {
    throw new Error(
      enabled
        ? 'CallTools SIP registration was not confirmed'
        : 'CallTools SIP unregistration was not confirmed',
    )
  }
  if (!enabled) {
    await resetSipPhoneRuntime('unavailable')
  }
  sendGatewayHeartbeat()
  sendGateway({
    type: 'gateway.registration.changed',
    requestId,
    enabled,
    ok: enabled ? sipRegistered : !sipRegistered,
    ...gatewayHealthPayload(),
  })
}

function handleGatewayMessage(message: GatewayMessage) {
  if (message.type === 'gateway.ack') {
    log(`gateway: acknowledged at ${message.sampleRate || targetSampleRate} Hz`)
    return
  }
  if (message.type === 'gateway.heartbeat.ack') {
    return
  }
  if (message.type === 'gateway.registration.set') {
    const controlSocket = gatewaySocket
    void setSipPhoneRegistration(message.enabled === true, message.requestId)
      .then(() => {
        if (
          controlSocket &&
          gatewaySocket === controlSocket &&
          controlSocket.readyState === WebSocket.OPEN
        ) {
          gatewayRegistrationReconciledSocket = controlSocket
          clearControlLossSipUnregister()
        }
      })
      .catch((error) => {
        sendGateway({
          type: 'gateway.registration.changed',
          requestId: message.requestId,
          enabled: message.enabled === true,
          ok: false,
          error: errorMessage(error),
          ...gatewayHealthPayload(),
        })
      })
    return
  }
  if (message.type === 'gateway.profile.select') {
    const nextProfileId = String(message.profileId || '').trim()
    const nextPhoneId = String(message.phoneId || '').trim()
    const selectable = Boolean(
      nextProfileId &&
      !activeSession &&
      (!nextPhoneId || nextPhoneId === config.phone.id),
    )
    if (selectable) {
      config = {
        ...config,
        profileId: nextProfileId,
        profileName: String(message.profileName || nextProfileId).trim(),
        sampleRate: Number(message.sampleRate || config.sampleRate || targetSampleRate),
      }
      targetSampleRate = config.sampleRate
      gatewayReadyPublishedSocket = null
      updateStatus(`Registered ${config.profileName || config.profileId}`)
      log(`gateway: selected ${config.profileName || config.profileId}`)
    }
    sendGateway({
      type: 'gateway.profile.selected',
      ok: selectable,
      profileId: selectable ? config.profileId : nextProfileId,
      profileName: selectable ? config.profileName : String(message.profileName || '').trim(),
      phoneId: config.phone.id,
      sampleRate: targetSampleRate,
      ...gatewayHealthPayload(),
    })
    if (selectable) sendGatewayReady()
    return
  }
  if (message.type === 'call.ready') {
    if (!isCurrentCallMessage(message, 'ready')) return
    activeCallControlId = message.callControlId || activeCallControlId
    flushPreReadyAudio()
    log(`call: ready ${activeCallControlId || activeStreamId}`)
    return
  }
  if (message.type === 'call.prepared') {
    if (!isCurrentCallMessage(message, 'prepared')) return
    settleCallPreparation(message)
    log(`call: prepared ${activeStreamId}`)
    return
  }
  if (message.type === 'call.rejected') {
    if (!isCurrentCallMessage(message, 'rejected')) return
    log(`call: rejected ${message.code || 'calltools_gateway_prepare_failed'}`)
    activeCallRejected = true
    if (settleCallPreparation(message)) return
    void hangupActiveCall('failed')
    return
  }
  if (message.type === 'audio.output' && message.audio) {
    if (!isCurrentCallMessage(message, 'audio.output')) return
    enqueueOutputPcm(message.audio, Number(message.sampleRate || targetSampleRate))
    return
  }
  if (message.type === 'audio.clear') {
    if (!isCurrentCallMessage(message, 'audio.clear')) return
    playbackSink.clear()
    return
  }
  if (message.type === 'call.end') {
    if (!isCurrentCallMessage(message, 'call.end')) return
    void hangupActiveCall(message.outcome || 'operator-ended')
  }
}

function isCurrentCallMessage(message: GatewayMessage, label: string) {
  if (callMessageMatchesActiveStream(message, Boolean(activeSession), activeStreamId)) return true
  log(`call: ignored stale ${label} ${message.streamId || 'missing-stream'}`)
  return false
}

// CALLTOOLS_ACTIVE_STREAM_MATCH_START
function callMessageMatchesActiveStream(
  message = {},
  sessionActive = false,
  streamId = '',
) {
  const messageStreamId = 'streamId' in message ? message.streamId : ''
  return Boolean(sessionActive && streamId && messageStreamId === streamId)
}
// CALLTOOLS_ACTIVE_STREAM_MATCH_END

async function hangupActiveCall(outcome: string) {
  const session = activeSession
  if (!session) return
  try {
    if (session.state === SessionState.Established) {
      await session.bye()
    } else if (session.state !== SessionState.Terminated) {
      if (session instanceof Invitation) {
        await session.reject({ statusCode: 480, reasonPhrase: 'Speak call ended' })
      }
    }
  } finally {
    if (session === activeSession) {
      notifyCallEnded(outcome)
      resetActiveCall()
    }
  }
}

function notifyCallEnded(outcome: string, reason = '') {
  if (activeCallEndedNotified) return
  activeCallEndedNotified = true
  sendGateway({
    type: 'call.ended',
    callControlId: activeCallControlId,
    streamId: activeStreamId,
    calltoolsCallId: activeCallToolsCallId,
    outcome,
    reason,
  })
}

function resetActiveCall() {
  cancelPendingCallPreparation(activeStreamId, 'calltools_gateway_call_ended')
  remoteCaptureCleanup?.()
  remoteCaptureCleanup = null
  clearOutboundAudioStatsTimers()
  activeSession = null
  activeCallControlId = ''
  activeStreamId = ''
  activeCallToolsCallId = ''
  activeCallStarted = false
  activeCallPrepared = false
  activeCallRejected = false
  activeOutputPacketCount = 0
  lastOutputStatsDiagnosticAt = 0
  preReadyAudioBuffer.clear()
  playbackSink?.clear()
  void restoreSyntheticLocalAudioAfterCall('post-call')
  if (!registrationDesired && sipRegistered) {
    void setSipPhoneRegistration(false).catch((error) => {
      log(`sip: deferred Unavailable release failed ${errorMessage(error)}`)
    })
  }
}

async function restoreSyntheticLocalAudioAfterCall(reason: string) {
  await Promise.resolve()
  if (activeSession) return
  if (gatewayHealthPayload().localAudioTrackHealthy) {
    publishGatewayHealth()
    return
  }
  try {
    await resetSyntheticLocalAudioForCall(reason)
  } catch (error) {
    log(`audio: synthetic local stream recovery failed ${errorMessage(error)}`)
    publishGatewayHealth()
  }
}

function sendCallToolsInputFrame(pcmFrame: Uint8Array) {
  sendGateway({
    type: 'audio.input',
    callControlId: activeCallControlId,
    streamId: activeStreamId,
    audio: pcm16ToBase64(pcmFrame),
    sampleRate: targetSampleRate,
    frameMs: CALLTOOLS_INPUT_FRAME_MS,
  })
}

function flushPreReadyAudio() {
  const before = preReadyAudioBuffer.snapshot()
  if (before.ready) return
  const frames = preReadyAudioBuffer.markReady()
  for (const frame of frames) sendCallToolsInputFrame(frame)
  sendCallAudioDiagnostic({
    event: 'pre_ready_audio_flushed',
    maxBufferMs: CALLTOOLS_PRE_READY_AUDIO_MAX_MS,
    frameMs: CALLTOOLS_INPUT_FRAME_MS,
    ...preReadyAudioBuffer.snapshot(),
  })
}

function enqueueOutputPcm(base64: string, sourceRate: number) {
  const pcm = base64ToBytes(base64)
  const samples = pcm16BytesToFloat(pcm)
  playbackSink.enqueue(resampleFloat32(samples, sourceRate, audioContext.sampleRate))
  activeOutputPacketCount += 1
  if (shouldReportOutboundAudioStats()) {
    scheduleOutboundAudioStatsDiagnostic('audio.output', activeOutputPacketCount)
  }
}

function shouldReportOutboundAudioStats() {
  const now = Date.now()
  if (activeOutputPacketCount <= 3 || now - lastOutputStatsDiagnosticAt >= 2000) {
    lastOutputStatsDiagnosticAt = now
    return true
  }
  return false
}

function scheduleOutboundAudioStatsDiagnostic(reason: string, outputPacket: number) {
  const session = activeSession
  const streamSerial = syntheticStreamSerial
  const delays = outputPacket === 1 ? [500, 1800] : [500]
  for (const delayMs of delays) {
    const timer = window.setTimeout(() => {
      outboundAudioStatsTimers = outboundAudioStatsTimers.filter((value) => value !== timer)
      void sendOutboundAudioStatsDiagnostic(session, reason, outputPacket, streamSerial, delayMs)
    }, delayMs)
    outboundAudioStatsTimers.push(timer)
  }
}

async function sendOutboundAudioStatsDiagnostic(
  session: Session | null,
  reason: string,
  outputPacket: number,
  streamSerial: number,
  delayMs: number,
) {
  if (!session || session !== activeSession) return
  const handler = session.sessionDescriptionHandler
  const peerConnection =
    handler instanceof Web.SessionDescriptionHandler ? handler.peerConnection : undefined
  sendCallAudioDiagnostic({
    event: 'local_audio_outbound_stats',
    label: 'calltools-local-output',
    reason,
    outputPacket,
    delayMs,
    streamSerial,
    localTrackCount: localDestination.stream.getAudioTracks().length,
    localTracks: describeAudioTracks(localDestination.stream),
    webrtc: await readPeerConnectionAudioStats(peerConnection),
  })
}

function clearOutboundAudioStatsTimers() {
  for (const timer of outboundAudioStatsTimers) {
    window.clearTimeout(timer)
  }
  outboundAudioStatsTimers = []
}

function sendCallAudioDiagnostic(diagnostic: Record<string, unknown>) {
  logRemoteCaptureDiagnostic(diagnostic)
  sendGateway({
    type: 'audio.diagnostic',
    callControlId: activeCallControlId,
    streamId: activeStreamId,
    diagnostic,
  })
}

function logRemoteCaptureDiagnostic(diagnostic: Record<string, unknown>) {
  const event = String(diagnostic.event || 'remote_audio')
  const peak = typeof diagnostic.peak === 'number' ? ` peak=${diagnostic.peak.toFixed(4)}` : ''
  const tracks =
    typeof diagnostic.trackCount === 'number' ? ` tracks=${diagnostic.trackCount}` : ''
  log(`${String(diagnostic.label || 'audio')}: ${event}${tracks}${peak}`)
}

async function createPlaybackSink(
  context: AudioContext,
  destination: MediaStreamAudioDestinationNode,
): Promise<PlaybackSink> {
  try {
    await ensurePlaybackWorklet(context)
    const node = new AudioWorkletNode(context, 'speak-calltools-playback', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    node.connect(destination)
    playbackMode = 'audio-worklet'
    return {
      enqueue(samples: Float32Array) {
        const copy = new Float32Array(samples)
        node.port.postMessage({ type: 'enqueue', samples: copy }, [copy.buffer])
      },
      clear() {
        node.port.postMessage({ type: 'clear' })
      },
      dispose() {
        node.port.postMessage({ type: 'clear' })
        node.disconnect()
      },
    }
  } catch {
    playbackMode = 'script-processor'
    return createScriptProcessorPlaybackSink(context, destination)
  }
}

function createScriptProcessorPlaybackSink(
  context: AudioContext,
  destination: MediaStreamAudioDestinationNode,
) {
  const node = context.createScriptProcessor(1024, 0, 1)
  const queue: Float32Array[] = []
  let queueOffset = 0
  node.onaudioprocess = (event) => {
    fillPlaybackBuffer(event.outputBuffer.getChannelData(0), queue, () => queueOffset, (next) => {
      queueOffset = next
    })
  }
  node.connect(destination)
  return {
    enqueue(samples: Float32Array) {
      queue.push(samples)
    },
    clear() {
      queue.length = 0
      queueOffset = 0
    },
    dispose() {
      queue.length = 0
      queueOffset = 0
      node.disconnect()
    },
  }
}

async function startRemoteCapture(
  stream: MediaStream,
  onSamples: (samples: Float32Array) => void,
  options: {
    label?: string
    peerConnection?: RTCPeerConnection
    onDiagnostic?: (diagnostic: Record<string, unknown>) => void
  } = {},
) {
  let stopped = false
  let activeTrackId = ''
  let startingTrackId = ''
  let startGeneration = 0
  let recheckTimer = 0
  let captureCleanup: (() => void) | null = null
  let activeTrackCleanup: (() => void) | null = null
  let activeElementCleanup: (() => void) | null = null

  const emitDiagnostic = (diagnostic: Record<string, unknown>) => {
    options.onDiagnostic?.({
      ...diagnostic,
      label: options.label || 'remote-audio',
      trackCount: stream.getAudioTracks().length,
      tracks: describeAudioTracks(stream),
    })
  }

  const startForTrack = async (track: MediaStreamTrack, reason: string) => {
    if (stopped || !isUsableRemoteAudioTrack(track)) return
    const nextTrackId = track.id
    if (nextTrackId === activeTrackId || nextTrackId === startingTrackId) return
    const generation = ++startGeneration
    startingTrackId = nextTrackId
    const captureStream = new MediaStream([track])
    let frames = 0
    let maxPeak = 0
    let nonzeroReported = false
    const nextTrackCleanup = watchRemoteTrack(track, emitDiagnostic)
    const nextElementCleanup = attachRemoteAudioElement(captureStream, emitDiagnostic)
    emitDiagnostic({
      event: 'remote_capture_start',
      reason,
      trackId: track.id,
      muted: track.muted,
      readyState: track.readyState,
    })

    let nextCaptureCleanup: () => void
    try {
      nextCaptureCleanup = await startRemoteCaptureGraph(captureStream, (samples) => {
        frames += 1
        const peak = peakAbs(samples)
        if (peak > maxPeak) maxPeak = peak
        if (!nonzeroReported && peak >= CALLTOOLS_REMOTE_NONZERO_PEAK) {
          nonzeroReported = true
          emitDiagnostic({
            event: 'remote_audio_nonzero',
            peak,
            packetCount: frames,
            trackId: nextTrackId,
          })
        } else if (
          frames === CALLTOOLS_REMOTE_SILENCE_DIAGNOSTIC_FRAMES &&
          maxPeak < CALLTOOLS_REMOTE_NONZERO_PEAK
        ) {
          void readPeerConnectionAudioStats(options.peerConnection).then((webrtc) => {
            emitDiagnostic({
              event: 'remote_audio_still_silent',
              peak: maxPeak,
              packetCount: frames,
              trackId: nextTrackId,
              webrtc,
            })
          })
        }
        onSamples(samples)
      })
    } catch (error) {
      nextTrackCleanup()
      nextElementCleanup()
      if (startingTrackId === nextTrackId) startingTrackId = ''
      emitDiagnostic({
        event: 'remote_capture_failed',
        reason,
        trackId: nextTrackId,
        error: errorMessage(error),
      })
      return
    }

    if (stopped || generation !== startGeneration) {
      nextCaptureCleanup()
      nextTrackCleanup()
      nextElementCleanup()
      return
    }
    captureCleanup?.()
    activeTrackCleanup?.()
    activeElementCleanup?.()
    captureCleanup = nextCaptureCleanup
    activeTrackCleanup = nextTrackCleanup
    activeElementCleanup = nextElementCleanup
    activeTrackId = nextTrackId
    startingTrackId = ''
  }

  const handleAddTrack = (event: Event) => {
    const track = (event as MediaStreamTrackEvent).track
    if (track?.kind !== 'audio') return
    void startForTrack(track, 'addtrack')
  }

  const handlePeerConnectionTrack = (event: Event) => {
    const track = (event as RTCTrackEvent).track
    if (track?.kind !== 'audio') return
    void startForTrack(track, 'peerconnection-track')
  }

  stream.addEventListener('addtrack', handleAddTrack)
  options.peerConnection?.addEventListener('track', handlePeerConnectionTrack)
  const initialTrack = findRemoteAudioTrack(stream, options.peerConnection)
  if (initialTrack) {
    void startForTrack(initialTrack, 'initial-track')
  } else {
    emitDiagnostic({ event: 'remote_track_pending', reason: 'initial' })
    recheckTimer = window.setTimeout(() => {
      recheckTimer = 0
      const track = findRemoteAudioTrack(stream, options.peerConnection)
      if (track) {
        void startForTrack(track, 'short-recheck')
      } else {
        emitDiagnostic({ event: 'remote_track_pending', reason: 'short-recheck' })
      }
    }, CALLTOOLS_REMOTE_TRACK_RECHECK_MS)
  }
  return () => {
    stopped = true
    startGeneration += 1
    if (recheckTimer) window.clearTimeout(recheckTimer)
    stream.removeEventListener('addtrack', handleAddTrack)
    options.peerConnection?.removeEventListener('track', handlePeerConnectionTrack)
    activeTrackCleanup?.()
    activeElementCleanup?.()
    captureCleanup?.()
  }
}

function findRemoteAudioTrack(stream: MediaStream, peerConnection?: RTCPeerConnection) {
  const streamTrack = stream.getAudioTracks().find(isUsableRemoteAudioTrack)
  if (streamTrack) return streamTrack
  return peerConnection
    ?.getReceivers()
    .map((receiver) => receiver.track)
    .find(isUsableRemoteAudioTrack)
}

function isUsableRemoteAudioTrack(track?: MediaStreamTrack | null): track is MediaStreamTrack {
  return Boolean(track?.kind === 'audio' && track.readyState !== 'ended')
}

function attachRemoteAudioElement(
  stream: MediaStream,
  emitDiagnostic: (diagnostic: Record<string, unknown>) => void,
) {
  const element = document.createElement('audio')
  element.autoplay = true
  element.setAttribute('playsinline', 'true')
  element.volume = 0
  element.srcObject = stream
  element.style.display = 'none'
  document.body.appendChild(element)
  void element
    .play()
    .then(() => {
      emitDiagnostic({ event: 'remote_audio_element_playing' })
    })
    .catch((error) => {
      emitDiagnostic({
        event: 'remote_audio_element_play_failed',
        error: errorMessage(error),
      })
    })
  return () => {
    element.pause()
    element.srcObject = null
    element.remove()
  }
}

async function readPeerConnectionAudioStats(peerConnection?: RTCPeerConnection) {
  if (!peerConnection?.getStats) return null
  try {
    const report = await peerConnection.getStats()
    const inbound: Record<string, unknown>[] = []
    const outbound: Record<string, unknown>[] = []
    const transportRoundTripTime = readSelectedCandidatePairRoundTripTime(report)
    report.forEach((stat) => {
      const item = stat as RTCInboundRtpStreamStats & Record<string, unknown>
      if (item.type === 'inbound-rtp' && item.kind === 'audio') {
        inbound.push({
          id: item.id,
          packetsReceived: item.packetsReceived,
          packetsLost: item.packetsLost,
          bytesReceived: item.bytesReceived,
          audioLevel: item.audioLevel,
          totalAudioEnergy: item.totalAudioEnergy,
          totalSamplesDuration: item.totalSamplesDuration,
          concealedSamples: item.concealedSamples,
          silentConcealedSamples: item.silentConcealedSamples,
          jitter: finiteRtcMetric(item.jitter),
          jitterBufferDelay: finiteRtcMetric(item.jitterBufferDelay),
          jitterBufferEmittedCount: finiteRtcMetric(item.jitterBufferEmittedCount),
          packetsDiscarded: finiteRtcMetric(item.packetsDiscarded),
          codec: summarizeRtcCodec(report, item.codecId),
          roundTripTime: readRtcRoundTripTime(report, item, transportRoundTripTime),
        })
        return
      }
      const outboundItem = stat as RTCOutboundRtpStreamStats & Record<string, unknown>
      if (outboundItem.type !== 'outbound-rtp' || outboundItem.kind !== 'audio') return
      outbound.push({
        id: outboundItem.id,
        packetsSent: outboundItem.packetsSent,
        bytesSent: outboundItem.bytesSent,
        retransmittedPacketsSent: outboundItem.retransmittedPacketsSent,
        retransmittedBytesSent: outboundItem.retransmittedBytesSent,
        audioLevel: outboundItem.audioLevel,
        totalAudioEnergy: outboundItem.totalAudioEnergy,
        totalSamplesDuration: outboundItem.totalSamplesDuration,
        codec: summarizeRtcCodec(report, outboundItem.codecId),
        roundTripTime: readRtcRoundTripTime(report, outboundItem, transportRoundTripTime),
      })
    })
    return { inbound, outbound }
  } catch (error) {
    return { error: errorMessage(error) }
  }
}

function summarizeRtcCodec(report: RTCStatsReport, codecId?: string) {
  if (!codecId) return undefined
  const codec = report.get(codecId) as (RTCStats & Record<string, unknown>) | undefined
  if (!codec || codec.type !== 'codec') return undefined
  return {
    mimeType: String(codec.mimeType || '').slice(0, 80),
    clockRate: finiteRtcMetric(codec.clockRate),
    channels: finiteRtcMetric(codec.channels),
    payloadType: finiteRtcMetric(codec.payloadType),
  }
}

function readRtcRoundTripTime(
  report: RTCStatsReport,
  item: Record<string, unknown>,
  transportRoundTripTime?: number,
) {
  const direct = finiteRtcMetric(item.roundTripTime)
  if (direct !== undefined) return direct
  const remoteId = typeof item.remoteId === 'string' ? item.remoteId : ''
  const remote = remoteId ? (report.get(remoteId) as Record<string, unknown> | undefined) : undefined
  return finiteRtcMetric(remote?.roundTripTime) ?? transportRoundTripTime
}

function readSelectedCandidatePairRoundTripTime(report: RTCStatsReport) {
  let roundTripTime: number | undefined
  report.forEach((stat) => {
    const pair = stat as RTCIceCandidatePairStats & Record<string, unknown>
    if (pair.type !== 'candidate-pair' || pair.state !== 'succeeded') return
    if (pair.nominated === false) return
    const candidateRoundTripTime = finiteRtcMetric(pair.currentRoundTripTime)
    if (candidateRoundTripTime !== undefined) roundTripTime = candidateRoundTripTime
  })
  return roundTripTime
}

function finiteRtcMetric(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function watchRemoteTrack(
  track: MediaStreamTrack,
  emitDiagnostic: (diagnostic: Record<string, unknown>) => void,
) {
  const onMute = () => {
    emitDiagnostic({ event: 'remote_track_muted', trackId: track.id, readyState: track.readyState })
  }
  const onUnmute = () => {
    emitDiagnostic({ event: 'remote_track_unmuted', trackId: track.id, readyState: track.readyState })
  }
  const onEnded = () => {
    emitDiagnostic({ event: 'remote_track_ended', trackId: track.id, readyState: track.readyState })
  }
  track.addEventListener('mute', onMute)
  track.addEventListener('unmute', onUnmute)
  track.addEventListener('ended', onEnded)
  return () => {
    track.removeEventListener('mute', onMute)
    track.removeEventListener('unmute', onUnmute)
    track.removeEventListener('ended', onEnded)
  }
}

function describeAudioTracks(stream: MediaStream) {
  return stream.getAudioTracks().map((track) => ({
    id: track.id,
    enabled: track.enabled,
    muted: track.muted,
    readyState: track.readyState,
  }))
}

async function startRemoteCaptureGraph(
  stream: MediaStream,
  onSamples: (samples: Float32Array) => void,
) {
  const source = audioContext.createMediaStreamSource(stream)
  try {
    await ensureRecorderWorklet(audioContext)
    const capture = new AudioWorkletNode(audioContext, 'speak-calltools-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    const silent = audioContext.createGain()
    silent.gain.value = 0
    capture.port.onmessage = (event) => onSamples(new Float32Array(event.data))
    source.connect(capture)
    capture.connect(silent)
    silent.connect(audioContext.destination)
    captureMode = 'audio-worklet'
    publishGatewayHealth()
    return () => {
      source.disconnect()
      capture.disconnect()
      silent.disconnect()
    }
  } catch {
    captureMode = 'script-processor'
    publishGatewayHealth()
    return startScriptProcessorCapture(source, onSamples)
  }
}

function startScriptProcessorCapture(
  source: MediaStreamAudioSourceNode,
  onSamples: (samples: Float32Array) => void,
) {
  const capture = audioContext.createScriptProcessor(4096, 1, 1)
  const silent = audioContext.createGain()
  silent.gain.value = 0
  capture.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0)
    event.outputBuffer.getChannelData(0).fill(0)
    onSamples(new Float32Array(input))
  }
  source.connect(capture)
  capture.connect(silent)
  silent.connect(audioContext.destination)
  return () => {
    source.disconnect()
    capture.disconnect()
    silent.disconnect()
  }
}

function fillPlaybackBuffer(
  output: Float32Array,
  queue: Float32Array[],
  getOffset: () => number,
  setOffset: (offset: number) => void,
) {
  output.fill(0)
  let cursor = 0
  let offset = getOffset()
  while (cursor < output.length && queue.length) {
    const current = queue[0]
    const available = current.length - offset
    const needed = output.length - cursor
    const count = Math.min(available, needed)
    output.set(current.subarray(offset, offset + count), cursor)
    cursor += count
    offset += count
    if (offset >= current.length) {
      queue.shift()
      offset = 0
    }
  }
  setOffset(offset)
}

function createPcm16Packetizer({
  sourceRate,
  targetRate,
  frameMs,
  onFrame,
}: {
  sourceRate: number
  targetRate: number
  frameMs: number
  onFrame: (frame: Uint8Array) => void
}) {
  const safeSourceRate = Math.max(1, Number(sourceRate || targetRate || 16000))
  const safeTargetRate = Math.max(1, Number(targetRate || 16000))
  const frameSampleCount = Math.max(1, Math.round((safeTargetRate * frameMs) / 1000))
  const sourceStep = safeSourceRate / safeTargetRate
  const maxBufferedSourceSamples = Math.max(
    Math.ceil((safeSourceRate * CALLTOOLS_MAX_CAPTURE_BUFFER_MS) / 1000),
    Math.ceil(sourceStep * frameSampleCount * 2),
  )
  let sourceBuffer = new Float32Array(0)
  let readIndex = 0
  let frame = new Uint8Array(frameSampleCount * 2)
  let frameView = new DataView(frame.buffer)
  let frameOffset = 0

  return {
    push(input: Float32Array) {
      if (!input.length) return
      sourceBuffer = appendFloat32(sourceBuffer, input)
      trimCaptureBuffer()
      while (readIndex + 1 < sourceBuffer.length) {
        const lower = Math.floor(readIndex)
        const upper = Math.min(sourceBuffer.length - 1, lower + 1)
        const fraction = readIndex - lower
        const sample = (sourceBuffer[lower] || 0) * (1 - fraction) + (sourceBuffer[upper] || 0) * fraction
        writePcm16Sample(frameView, frameOffset, sample)
        frameOffset += 1
        if (frameOffset >= frameSampleCount) emitFrame()
        readIndex += sourceStep
      }
      dropConsumedCaptureSamples()
    },
    clear() {
      sourceBuffer = new Float32Array(0)
      readIndex = 0
      frame = new Uint8Array(frameSampleCount * 2)
      frameView = new DataView(frame.buffer)
      frameOffset = 0
    },
  }

  function emitFrame() {
    onFrame(frame)
    frame = new Uint8Array(frameSampleCount * 2)
    frameView = new DataView(frame.buffer)
    frameOffset = 0
  }

  function trimCaptureBuffer() {
    if (sourceBuffer.length <= maxBufferedSourceSamples) return
    const drop = sourceBuffer.length - maxBufferedSourceSamples
    sourceBuffer = sourceBuffer.slice(drop)
    readIndex = Math.max(0, readIndex - drop)
  }

  function dropConsumedCaptureSamples() {
    const consumed = Math.max(0, Math.floor(readIndex) - 1)
    if (!consumed) return
    sourceBuffer = sourceBuffer.slice(consumed)
    readIndex -= consumed
  }
}

function appendFloat32(left: Float32Array, right: Float32Array) {
  if (!left.length) return new Float32Array(right)
  const next = new Float32Array(left.length + right.length)
  next.set(left)
  next.set(right, left.length)
  return next
}

function writePcm16Sample(view: DataView, sampleIndex: number, value: number) {
  const clamped = Math.max(-1, Math.min(1, value || 0))
  view.setInt16(sampleIndex * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
}

function ensurePlaybackWorklet(context: AudioContext) {
  playbackWorkletReady ??= context.audioWorklet.addModule(
    URL.createObjectURL(new Blob([playbackProcessorSource()], { type: 'text/javascript' })),
  )
  return playbackWorkletReady
}

function ensureRecorderWorklet(context: AudioContext) {
  recorderWorkletReady ??= context.audioWorklet.addModule(
    URL.createObjectURL(new Blob([recorderProcessorSource()], { type: 'text/javascript' })),
  )
  return recorderWorkletReady
}

function playbackProcessorSource() {
  return `
    class SpeakCallToolsPlayback extends AudioWorkletProcessor {
      constructor() {
        super();
        this.queue = [];
        this.offset = 0;
        this.port.onmessage = (event) => {
          if (event.data.type === 'enqueue') this.queue.push(event.data.samples);
          if (event.data.type === 'clear') {
            this.queue = [];
            this.offset = 0;
          }
        };
      }
      process(_inputs, outputs) {
        const output = outputs[0][0];
        output.fill(0);
        let cursor = 0;
        while (cursor < output.length && this.queue.length) {
          const current = this.queue[0];
          const count = Math.min(output.length - cursor, current.length - this.offset);
          output.set(current.subarray(this.offset, this.offset + count), cursor);
          cursor += count;
          this.offset += count;
          if (this.offset >= current.length) {
            this.queue.shift();
            this.offset = 0;
          }
        }
        return true;
      }
    }
    registerProcessor('speak-calltools-playback', SpeakCallToolsPlayback);
  `
}

function recorderProcessorSource() {
  return `
    class SpeakCallToolsRecorder extends AudioWorkletProcessor {
      process(inputs, outputs) {
        const input = inputs[0] && inputs[0][0];
        if (input && input.length) {
          const copy = new Float32Array(input);
          this.port.postMessage(copy, [copy.buffer]);
        }
        if (outputs[0] && outputs[0][0]) outputs[0][0].fill(0);
        return true;
      }
    }
    registerProcessor('speak-calltools-recorder', SpeakCallToolsRecorder);
  `
}

function pcm16BytesToFloat(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const output = new Float32Array(Math.floor(bytes.byteLength / 2))
  for (let index = 0; index < output.length; index += 1) {
    output[index] = view.getInt16(index * 2, true) / 0x8000
  }
  return output
}

function resampleFloat32(input: Float32Array, sourceRate: number, sampleRate: number) {
  if (!input.length || sourceRate === sampleRate) return input
  const ratio = sourceRate / sampleRate
  const outputLength = Math.max(1, Math.round(input.length / ratio))
  const output = new Float32Array(outputLength)
  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio
    const lower = Math.floor(sourceIndex)
    const upper = Math.min(input.length - 1, lower + 1)
    const fraction = sourceIndex - lower
    output[index] = (input[lower] || 0) * (1 - fraction) + (input[upper] || 0) * fraction
  }
  return output
}

function base64ToBytes(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function pcm16ToBase64(bytes: Uint8Array) {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index])
  }
  return btoa(binary)
}

function peakAbs(input: Float32Array) {
  let peak = 0
  for (const sample of input) {
    peak = Math.max(peak, Math.abs(sample || 0))
  }
  return peak
}

function sendGateway(message: Record<string, unknown>) {
  if (gatewaySocket?.readyState !== WebSocket.OPEN) return
  gatewaySocket.send(JSON.stringify({ gatewayInstanceId, ...message }))
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function createAudioContext() {
  const Constructor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Constructor) throw new Error('Web Audio API is not available')
  return new Constructor({ latencyHint: 'interactive' })
}

function updateStatus(value: string) {
  if (statusEl) statusEl.textContent = value
}

function log(value: string) {
  console.log(value)
  if (!logEl) return
  const line = `[${formatOperationalDateTime(new Date(), {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })}] ${value}`
  logEl.textContent = `${line}\n${logEl.textContent || ''}`.slice(0, 6000)
}
