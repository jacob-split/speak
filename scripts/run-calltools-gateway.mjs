import { chromium } from 'playwright'
import { writeSync } from 'node:fs'
import { normalizeBasePath } from '../server/runtime-config.mjs'

const secret = process.env.CALLTOOLS_MEDIA_GATEWAY_SHARED_SECRET || ''
const profileId = process.env.CALLTOOLS_GATEWAY_PROFILE_ID || process.argv[2] || ''
const headless = process.env.CALLTOOLS_GATEWAY_HEADLESS !== 'false'
const startAttempts = Math.max(1, Number(process.env.CALLTOOLS_GATEWAY_START_ATTEMPTS || 6))
const readyTimeoutMs = Math.max(
  5_000,
  Number(process.env.CALLTOOLS_GATEWAY_READY_TIMEOUT_MS || 60_000),
)
const pageLoadTimeoutMs = Math.max(
  3_000,
  Math.min(
    readyTimeoutMs,
    Number(process.env.CALLTOOLS_GATEWAY_PAGE_LOAD_TIMEOUT_MS || 15_000),
  ),
)
const retryDelayMs = Math.max(1_000, Number(process.env.CALLTOOLS_GATEWAY_RETRY_DELAY_MS || 5_000))

if (!secret) {
  throw new Error('CALLTOOLS_MEDIA_GATEWAY_SHARED_SECRET is required')
}

let browser = null
try {
  await waitForGatewayPageShell()
  browser = await chromium.launch({
    headless,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
    ],
  })
  await registerGatewayWithRetry(browser)
  console.log(
    profileId
      ? `CallTools gateway process ready for profile ${profileId}`
      : 'CallTools gateway process ready for the active Speak profile',
  )
} catch (error) {
  writeErrorLine(error instanceof Error ? error.message : String(error))
  if (browser) {
    void browser.close().catch(() => {})
    process.kill(process.pid, 'SIGKILL')
  }
  process.exit(1)
}

const shutdown = async () => {
  await closeBrowserQuietly(browser)
  process.exit(0)
}
process.once('SIGINT', () => {
  void shutdown()
})
process.once('SIGTERM', () => {
  void shutdown()
})
await new Promise(() => {})

async function waitForGatewayPageShell() {
  let lastError = null
  for (let attempt = 1; attempt <= startAttempts; attempt += 1) {
    try {
      await assertGatewayPageShellAvailable(callToolsGatewayPageUrl())
      return
    } catch (error) {
      lastError = error
      writeErrorLine(
        `[calltools-gateway:page-retry] attempt ${attempt}/${startAttempts} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      if (attempt < startAttempts) {
        await delay(retryDelayMs)
      }
    }
  }
  throw lastError || new Error('CallTools gateway page did not become available')
}

async function assertGatewayPageShellAvailable(pageUrl) {
  const response = await fetch(pageUrl.href, {
    signal: AbortSignal.timeout(pageLoadTimeoutMs),
  })
  const status = response.status
  if (status >= 500 || !response.ok) {
    throw new Error(`Gateway page returned HTTP ${status} for ${safeGatewayResponseUrl(pageUrl.href)}`)
  }
}

async function registerGatewayWithRetry(browserInstance) {
  let lastError = null
  for (let attempt = 1; attempt <= startAttempts; attempt += 1) {
    const page = await browserInstance.newPage({
      viewport: { width: 520, height: 720 },
    })
    attachPageLogging(page)
    const pageUrl = callToolsGatewayPageUrl()
    const pageFailureMonitor = createGatewayPageFailureMonitor(page, pageUrl)
    try {
      const response = await waitForGatewayStep(
        page.goto(pageUrl.href, {
          waitUntil: 'domcontentloaded',
          timeout: pageLoadTimeoutMs,
        }),
        pageFailureMonitor,
      )
      pageFailureMonitor.throwIfFailed()
      const status = response?.status?.() || 0
      if (status >= 500) {
        throw new Error(`Gateway page returned HTTP ${status}`)
      }
      await waitForGatewayStep(
        page.waitForFunction(() => document.body.dataset.gatewayProcessReady === 'true', {
          timeout: readyTimeoutMs,
        }),
        pageFailureMonitor,
      )
      return page
    } catch (error) {
      lastError = error
      await logGatewayPageFailure(page, attempt, error)
      void page.close().catch(() => {})
      if (attempt < startAttempts) {
        await delay(retryDelayMs)
      }
    } finally {
      pageFailureMonitor.stop()
    }
  }
  throw lastError || new Error('CallTools gateway process startup failed')
}

function attachPageLogging(page) {
  page.on('console', (message) => {
    console.log(`[calltools-gateway:${message.type()}] ${message.text()}`)
  })
  page.on('pageerror', (error) => {
    writeErrorLine(`[calltools-gateway:error] ${error.message}`)
  })
}

function createGatewayPageFailureMonitor(page, pageUrl) {
  const pageOrigin = pageUrl.origin
  let failureError = null
  let notifyFailure = null
  const failureSignal = new Promise((resolve) => {
    notifyFailure = resolve
  })
  const handleResponse = (response) => {
    const status = response.status()
    if (status < 500) return
    const responseUrl = response.url()
    if (!isSameOrigin(responseUrl, pageOrigin)) return
    if (failureError) return
    failureError = new Error(
      `Gateway page returned HTTP ${status} for ${safeGatewayResponseUrl(responseUrl)}`,
    )
    failureError.gatewayPageFailure = true
    notifyFailure(failureError)
  }
  page.on('response', handleResponse)
  return {
    failureSignal,
    throwIfFailed() {
      if (failureError) throw failureError
    },
    stop() {
      page.off('response', handleResponse)
    },
  }
}

async function waitForGatewayStep(stepPromise, pageFailureMonitor) {
  const step = Promise.resolve(stepPromise)
  step.catch(() => {})
  const result = await Promise.race([step, pageFailureMonitor.failureSignal])
  if (result?.gatewayPageFailure) {
    throw result
  }
  pageFailureMonitor.throwIfFailed()
  return result
}

function isSameOrigin(rawUrl, origin) {
  try {
    return new URL(rawUrl).origin === origin
  } catch {
    return false
  }
}

function safeGatewayResponseUrl(rawUrl) {
  try {
    const url = new URL(rawUrl)
    if (url.searchParams.has('token')) {
      url.searchParams.set('token', '[redacted]')
    }
    return url.toString()
  } catch {
    return String(rawUrl).replace(/([?&]token=)[^&]+/g, '$1[redacted]')
  }
}

async function logGatewayPageFailure(page, attempt, error) {
  const status = await page.locator('#status').innerText().catch(() => '')
  const log = await page.locator('#log').innerText().catch(() => '')
  writeErrorLine(
    `[calltools-gateway:retry] attempt ${attempt}/${startAttempts} failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  )
  if (status) writeErrorLine(`[calltools-gateway:status] ${status}`)
  if (log) writeErrorLine(`[calltools-gateway:log]\n${log}`)
}

function writeErrorLine(message) {
  writeSync(2, `${message}\n`)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function closeBrowserQuietly(browserInstance) {
  await Promise.race([browserInstance.close(), delay(2_000)]).catch(() => {})
}

function callToolsGatewayPageUrl() {
  const explicit = process.env.CALLTOOLS_GATEWAY_PAGE_URL || ''
  if (explicit) {
    const explicitUrl = new URL(explicit)
    const pathname = explicitUrl.pathname.replace(/\/+$/g, '')
    if (pathname.endsWith('/calltools-gateway.html')) {
      if (profileId) explicitUrl.searchParams.set('profileId', profileId)
      else explicitUrl.searchParams.delete('profileId')
      explicitUrl.searchParams.set('token', secret)
      return explicitUrl
    }
  }
  const base =
    explicit ||
    process.env.PUBLIC_BASE_URL ||
    `http://127.0.0.1:${process.env.PORT || 8787}${normalizeBasePath(
      process.env.BASE_PATH || '',
    )}`
  const root = base.endsWith('/') ? base : `${base}/`
  const url = new URL('calltools-gateway.html', root)
  if (profileId) url.searchParams.set('profileId', profileId)
  url.searchParams.set('token', secret)
  return url
}
