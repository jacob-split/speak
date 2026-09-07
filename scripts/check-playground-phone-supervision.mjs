import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createPlaygroundCallSupervision } from '../server/playground-call-supervision.mjs'

class FakeSocket extends EventEmitter {
  constructor() {
    super()
    this.readyState = 1
    this.sent = []
    this.closed = null
  }

  send(value) {
    this.sent.push(value)
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return
    this.readyState = 3
    this.closed = { code, reason }
    this.emit('close', code, reason)
  }
}

const transcriptionSockets = []
const instructions = []
const delivered = []
const supervision = createPlaygroundCallSupervision({
  createTranscriptionSocket: (options) => {
    const socket = new FakeSocket()
    socket.options = options
    socket.readyState = 0
    transcriptionSockets.push(socket)
    return socket
  },
  getDeepgramApiKey: () => 'test-deepgram-key',
  sendInstruction: async (state, instruction) => {
    instructions.push({ callControlId: state.callControlId, instruction })
  },
  onWhisperDelivered: async (state, instruction) => {
    delivered.push({ callControlId: state.callControlId, instruction })
  },
  whisperFinalizeWaitMs: 50,
})

const state = {
  callControlId: 'playground-phone-1',
  callProvider: 'telnyx_texml',
  chatId: 'chat-1',
  origin: 'playground_phone',
  playgroundSupervisionToken: 'supervision-token-1',
  sampleRate: 16_000,
  streamId: 'stream-1',
  telnyxWs: { readyState: 1 },
}
const client = new FakeSocket()
assert.equal(supervision.canAttach(state, 'supervision-token-1'), true)
assert.equal(supervision.canAttach(state, 'wrong-token'), false)
assert.equal(supervision.attach(client, state, 'supervision-token-1'), true)
assert.deepEqual(clientMessages(client)[0], {
  type: 'ready',
  audioWhisperAvailable: true,
  maxWhisperMs: 30_000,
  spyAvailable: true,
})

client.emit('message', Buffer.from(JSON.stringify({
  type: 'monitor.set',
  enabled: true,
})), false)
await flushEvents()
assert.ok(clientMessages(client).some((message) =>
  message.type === 'monitor.updated' && message.enabled === true))

const pcm = Buffer.from([0x01, 0x00, 0xff, 0x7f])
assert.equal(supervision.publishAudio(state, 'contact', pcm, 16_000), 1)
assert.ok(clientMessages(client).some((message) =>
  message.type === 'audio' &&
  message.source === 'contact' &&
  message.sampleRate === 16_000 &&
  message.data === pcm.toString('base64')))
supervision.clearAudio(state, 'agent', 'barge')
assert.ok(clientMessages(client).some((message) =>
  message.type === 'audio.clear' && message.source === 'agent'))

client.emit('message', Buffer.from(JSON.stringify({
  type: 'whisper.start',
  sampleRate: 16_000,
})), false)
await flushEvents()
assert.equal(transcriptionSockets.length, 1)
const transcription = transcriptionSockets[0]
assert.equal(transcription.options.apiKey, 'test-deepgram-key')
assert.equal(transcription.options.sampleRate, 16_000)
transcription.readyState = 1
transcription.emit('open')
assert.ok(clientMessages(client).some((message) => message.type === 'whisper.ready'))

client.emit('message', pcm, true)
assert.ok(transcription.sent.some((value) => Buffer.isBuffer(value) && value.equals(pcm)))
client.emit('message', Buffer.from(JSON.stringify({ type: 'whisper.stop' })), false)
await flushEvents()
assert.ok(transcription.sent.some((value) =>
  typeof value === 'string' && JSON.parse(value).type === 'Finalize'))
transcription.emit('message', Buffer.from(JSON.stringify({
  type: 'Results',
  is_final: true,
  from_finalize: true,
  channel: {
    alternatives: [{ transcript: 'Ask whether Tuesday morning works.' }],
  },
})))
await flushEvents()
assert.deepEqual(instructions, [{
  callControlId: 'playground-phone-1',
  instruction: 'Ask whether Tuesday morning works.',
}])
assert.deepEqual(delivered, instructions)
assert.ok(clientMessages(client).some((message) =>
  message.type === 'whisper.delivered' &&
  message.transcript === 'Ask whether Tuesday morning works.'))

for (const ineligible of [
  { ...state, origin: '' },
  { ...state, browserTest: true },
  { ...state, callProvider: 'calltools' },
  { ...state, personalPhoneInboundCorrelationId: 'personal-phone-1' },
]) {
  const rejected = new FakeSocket()
  assert.equal(supervision.canAttach(ineligible, 'supervision-token-1'), false)
  assert.equal(supervision.attach(rejected, ineligible, 'supervision-token-1'), false)
  assert.equal(rejected.closed?.code, 1008)
}

const unavailableClient = new FakeSocket()
const unavailableSupervision = createPlaygroundCallSupervision({
  createTranscriptionSocket: () => {
    throw new Error('should not connect')
  },
  getDeepgramApiKey: () => '',
  sendInstruction: async () => undefined,
})
assert.equal(
  unavailableSupervision.attach(
    unavailableClient,
    state,
    'supervision-token-1',
  ),
  true,
)
assert.equal(clientMessages(unavailableClient)[0].audioWhisperAvailable, false)
unavailableClient.emit('message', Buffer.from(JSON.stringify({
  type: 'whisper.start',
  sampleRate: 16_000,
})), false)
await flushEvents()
assert.ok(clientMessages(unavailableClient).some((message) =>
  message.type === 'error' &&
  message.operation === 'whisper' &&
  /not configured/i.test(message.error)))

const serverIndex = readFileSync('server/index.mjs', 'utf8')
const workspace = readFileSync('src/AgentConfigWorkspace.tsx', 'utf8')
const sessionController = readFileSync('src/useConfigurationTestSession.ts', 'utf8')
for (const [source, pattern, message] of [
  [serverIndex, "pathname.match(/^\\/api\\/calls\\/(.+)\\/supervision$/)", 'supervision WebSocket route'],
  [serverIndex, /publishAudio\([\s\S]{0,120}'contact'/, 'contact audio monitor publication'],
  [serverIndex, /publishAudio\([\s\S]{0,120}'agent'/, 'agent audio monitor publication'],
  [serverIndex, /playgroundCallSupervision\.clearAudio/, 'agent audio clear propagation'],
  [serverIndex, /Text whisper to agent:/, 'Phone text Whisper event semantics'],
  [workspace, /togglePlaygroundSpy/, 'Phone Spy control'],
  [workspace, /togglePlaygroundBarge/, 'Phone Barge control'],
  [workspace, /togglePlaygroundAudioWhisper/, 'Phone Audio Whisper control'],
  [workspace, /testMode === 'phone'[\s\S]{0,120}Whisper to/, 'Phone composer private Whisper label'],
  [sessionController, /\/calls\/\$\{encodeURIComponent\(targetSessionId\)\}\/instructions/, 'Phone text Whisper instruction route'],
]) {
  if (typeof pattern === 'string') {
    assert.ok(source.includes(pattern), `Missing ${message}`)
  } else {
    assert.match(source, pattern, `Missing ${message}`)
  }
}

supervision.close(state)
assert.equal(client.closed?.code, 1000)

console.log(JSON.stringify({
  ok: true,
  schemaVersion: 'speak.playground-phone-supervision.v1',
  coverage: {
    audioWhisper: true,
    barge: true,
    browserExcluded: true,
    calltoolsExcluded: true,
    deviceExcluded: true,
    personalPhoneExcluded: true,
    spy: true,
    textWhisper: true,
  },
}, null, 2))

function clientMessages(socket) {
  return socket.sent
    .filter((value) => typeof value === 'string')
    .map((value) => JSON.parse(value))
}

function flushEvents() {
  return new Promise((resolve) => setImmediate(resolve))
}
