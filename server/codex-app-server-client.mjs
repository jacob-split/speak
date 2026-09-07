import { spawn } from 'node:child_process'

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

function cleanText(value) {
  return String(value || '').trim()
}

export class CodexAppServerError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'CodexAppServerError'
    this.details = details
  }
}

class CodexAppServerClient {
  constructor() {
    this.child = null
    this.initialized = null
    this.nextRequestId = 1
    this.pending = new Map()
    this.stdoutBuffer = ''
    this.listeners = new Set()
  }

  async ensureStarted() {
    if (this.initialized) return this.initialized

    this.initialized = new Promise((resolve, reject) => {
      const child = spawn(
        process.env.SPEAK_CODEX_APP_SERVER_BIN || 'codex',
        ['app-server', '--stdio'],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            NO_COLOR: '1',
            TERM: process.env.TERM || 'xterm-256color',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
      this.child = child

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => this.handleStdout(chunk))
      child.stderr.on('data', (chunk) => {
        const text = cleanText(chunk)
        if (text) this.emit({ method: 'stderr', params: { text } })
      })
      child.on('error', (error) => {
        this.rejectAll(error)
        reject(error)
      })
      child.on('close', (code, signal) => {
        this.child = null
        this.initialized = null
        this.rejectAll(
          new CodexAppServerError('Codex app-server exited.', { code, signal }),
        )
      })

      this.request('initialize', {
        clientInfo: {
          name: 'speak-smart-config',
          version: '1.0.0',
        },
        capabilities: null,
      })
        .then((result) => {
          this.notify('initialized')
          resolve(result)
        })
        .catch(reject)
    })

    return this.initialized
  }

  addListener(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onNotification(listener) {
    return this.addListener(listener)
  }

  async request(method, params, options = {}) {
    if (!this.child && method !== 'initialize') {
      await this.ensureStarted()
    }

    if (!this.child?.stdin.writable) {
      throw new CodexAppServerError('Codex app-server is not writable.')
    }

    const id = this.nextRequestId
    this.nextRequestId += 1
    const timeoutMs = Number(options.timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS
    const payload = { id, method, params }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new CodexAppServerError(`Codex app-server request timed out: ${method}`),
        )
      }, timeoutMs)

      this.pending.set(id, {
        method,
        reject,
        resolve,
        timer,
      })
      this.child.stdin.write(`${JSON.stringify(payload)}\n`)
    })
  }

  notify(method, params) {
    if (!this.child?.stdin.writable) return
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`)
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk
    let newlineIndex = this.stdoutBuffer.indexOf('\n')

    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)
      if (line) this.handleMessageLine(line)
      newlineIndex = this.stdoutBuffer.indexOf('\n')
    }
  }

  handleMessageLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.emit({ method: 'stdout', params: { text: line } })
      return
    }

    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) {
        pending.reject(
          new CodexAppServerError(
            message.error.message || `${pending.method} failed`,
            message.error,
          ),
        )
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (message.id && message.method) {
      this.handleServerRequest(message)
      return
    }

    this.emit(message)
  }

  handleServerRequest(message) {
    this.emit(message)
    this.child?.stdin.write(
      `${JSON.stringify({
        id: message.id,
        error: {
          code: -32000,
          message: 'Smart Config does not handle interactive Codex requests.',
        },
      })}\n`,
    )
  }

  emit(message) {
    this.listeners.forEach((listener) => {
      try {
        listener(message)
      } catch {
        // Notification listeners are best-effort and must not break the bridge.
      }
    })
  }

  rejectAll(error) {
    this.pending.forEach((pending) => {
      clearTimeout(pending.timer)
      pending.reject(error)
    })
    this.pending.clear()
  }
}

export const codexAppServer = new CodexAppServerClient()
