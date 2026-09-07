import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { docScreenshotSpec, verifyDocScreenshots } from './check-doc-screenshots.mjs'

const root = process.cwd()
const screenshotDir = path.join(root, 'docs/assets/screenshots')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'speak-doc-screenshots-'))
const workspaceDir = path.join(tempRoot, 'workspace-data')
const callLogDir = path.join(tempRoot, 'call-logs')
const workspaceFixture = path.join(root, 'docs/fixtures/populated-workspace.json')
const callLogFixture = path.join(root, 'docs/fixtures/call-logs/events-2026-06-27.jsonl')

let apiServer = null
let uiServer = null
let browser = null

try {
  mkdirSync(workspaceDir, { recursive: true })
  mkdirSync(callLogDir, { recursive: true })
  mkdirSync(screenshotDir, { recursive: true })
  cpSync(workspaceFixture, path.join(workspaceDir, 'workspace.json'))
  cpSync(callLogFixture, path.join(callLogDir, 'events-2026-06-27.jsonl'))

  const apiPort = await findAvailablePort(8787)
  const uiPort = await findAvailablePort(5173, new Set([apiPort]))
  const apiBaseUrl = `http://127.0.0.1:${apiPort}`
  const uiBaseUrl = `http://127.0.0.1:${uiPort}/speak`

  apiServer = startProcess('api', process.execPath, ['server/index.mjs'], {
    PORT: String(apiPort),
    PUBLIC_BASE_URL: apiBaseUrl,
    SPEAK_WORKSPACE_DATA_DIR: workspaceDir,
    BACKGROUND_DELIVERY_OUTBOX_PATH: path.join(
      workspaceDir,
      'background-delivery-outbox.json',
    ),
    SPEAK_CALL_LOG_DIR: callLogDir,
    CALL_LOG_DIR: callLogDir,
    VOICE_RUNTIME_PROVIDER: 'hume',
    DIALER_PROVIDER: 'speak',
    HUME_API_KEY: 'docs-fixture-voice-key',
    HUME_CONFIG_ID: 'speak-config-docs-follow-up',
    TELNYX_API_KEY: 'docs-fixture-phone-key',
    TELNYX_API_BASE: 'http://127.0.0.1:1',
    TELNYX_CONNECTION_ID: 'telnyx-connection-fixture',
    TELNYX_FROM_NUMBER: '+17045550001',
    SPEAK_PHONE_NUMBER_OPTIONS: JSON.stringify([
      {
        id: 'docs-fixture-phone',
        label: 'Speak fixture number',
        phoneNumber: '+17045550001',
        connectionId: 'telnyx-connection-fixture',
        default: true,
      },
    ]),
  })
  uiServer = startProcess('ui', process.execPath, [
    'node_modules/vite/bin/vite.js',
    '--host',
    '127.0.0.1',
    '--port',
    String(uiPort),
    '--strictPort',
  ], {
    VITE_BASE_PATH: '/speak/',
    VITE_API_PROXY_TARGET: apiBaseUrl,
  })

  await waitForUrl(`${apiBaseUrl}/api/health`, 'API health')
  await waitForUrl(`${uiBaseUrl}/library`, 'Vite UI')

  browser = await chromium.launch({ headless: true })
  for (const capture of docScreenshotSpec.captures) {
    await captureScreenshot(browser, uiBaseUrl, capture)
  }

  const captures = captureManifestEntries()
  updateScreenshotReferences(captures)
  writeManifest(captures)

  const verification = verifyDocScreenshots({ root })
  console.log(JSON.stringify({
    ok: verification.ok,
    schemaVersion: docScreenshotSpec.schemaVersion,
    outputDir: 'docs/assets/screenshots',
    checked: verification.checked.map(({ file, dimensions }) => ({ file, dimensions })),
    failures: verification.failures,
  }, null, 2))
  if (!verification.ok) process.exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
  await stopProcess(uiServer)
  await stopProcess(apiServer)
  rmSync(tempRoot, { recursive: true, force: true })
}

async function captureScreenshot(browserInstance, uiBaseUrl, capture) {
  const context = await browserInstance.newContext({
    viewport: {
      width: docScreenshotSpec.viewport.width,
      height: docScreenshotSpec.viewport.height,
    },
    deviceScaleFactor: docScreenshotSpec.viewport.deviceScaleFactor,
    colorScheme: capture.appearance,
  })
  await context.addInitScript((appearance) => {
    window.localStorage.setItem('speak:appearance', appearance)
    document.documentElement.dataset.appearance = appearance
  }, capture.appearance)
  const page = await context.newPage()
  try {
    await page.goto(`${uiBaseUrl}${capture.route.replace(/^\/speak/, '')}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
    await page.waitForSelector('[data-testid="speak-route-switch"]', { timeout: 10_000 })
    await assertRouteSelector(page)

    if (capture.surface === 'library') {
      await assertLibraryModeSelector(page)
      if (capture.mode === 'agents') {
        await page.getByRole('tab', { name: 'Agents' }).click()
      } else if (capture.mode === 'activity') {
        await page.getByRole('tab', { name: 'Activity' }).click()
      } else {
        await page.getByRole('tab', { name: 'Contacts' }).click()
      }
    }

    await page.waitForSelector(capture.waitSelector, { timeout: 10_000 })
    await page.evaluate(() => document.fonts?.ready)
    await page.waitForTimeout(300)
    await page.screenshot({
      path: path.join(screenshotDir, capture.file),
      fullPage: false,
    })
  } finally {
    await context.close()
  }
}

async function assertRouteSelector(page) {
  const labels = await page.locator('.app-primary-nav [data-route-nav-id]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('aria-label')).filter(Boolean),
  )
  for (const expected of docScreenshotSpec.routeSelectorLabels) {
    if (!labels.includes(expected)) {
      throw new Error(`Route selector did not expose ${expected}`)
    }
  }
}

async function assertLibraryModeSelector(page) {
  const labels = await page.locator('.library-mode-switch [role="tab"]').evaluateAll((nodes) =>
    nodes.map((node) => node.textContent?.replace(/\s+/g, ' ').trim()).filter(Boolean),
  )
  for (const expected of docScreenshotSpec.libraryModeLabels) {
    if (!labels.includes(expected)) {
      throw new Error(`Library mode selector did not expose ${expected}`)
    }
  }
}

function captureManifestEntries() {
  return docScreenshotSpec.captures.map((capture) => {
    const hash = sha256(readFileSync(path.join(screenshotDir, capture.file)))
    return {
      file: capture.file,
      route: capture.route,
      appearance: capture.appearance,
      surface: capture.surface,
      mode: capture.mode,
      sha256: hash,
      cacheKey: hash.slice(0, 12),
    }
  })
}

function updateScreenshotReferences(captures) {
  const entries = new Map(captures.map((capture) => [capture.file, capture.cacheKey]))
  const referenceFiles = [
    { relativeFile: 'docs/index.html', prefix: 'assets/screenshots/' },
    { relativeFile: 'docs/index.md', prefix: 'assets/screenshots/' },
    { relativeFile: 'docs/ui-reference.md', prefix: 'assets/screenshots/' },
    { relativeFile: 'docs/agent-integration.md', prefix: 'docs/assets/screenshots/' },
  ]
  for (const { relativeFile, prefix } of referenceFiles) {
    const filePath = path.join(root, relativeFile)
    let text = readFileSync(filePath, 'utf8')
    for (const [file, cacheKey] of entries) {
      const escapedReference = escapeRegExp(`${prefix}${file}`)
      text = text.replace(
        new RegExp(`${escapedReference}(?:\\?v=[a-f0-9.-]+)?`, 'g'),
        `${prefix}${file}?v=${cacheKey}`,
      )
    }
    writeFileSync(filePath, text)
  }
}

function writeManifest(captures) {
  const fixtureSources = docScreenshotSpec.fixtureSources.map((fixture) => ({
    path: fixture,
    sha256: sha256(readFileSync(path.join(root, fixture))),
  }))
  writeFileSync(path.join(root, docScreenshotSpec.manifestPath), `${JSON.stringify({
    schemaVersion: docScreenshotSpec.schemaVersion,
    generatedBy: docScreenshotSpec.generatedBy,
    viewport: docScreenshotSpec.viewport,
    fixtureSources,
    routeSelectorLabels: docScreenshotSpec.routeSelectorLabels,
    libraryModeLabels: docScreenshotSpec.libraryModeLabels,
    captures,
  }, null, 2)}\n`)
}

function startProcess(label, command, args, env) {
  const child = spawn(command, args, {
    cwd: root,
    env: {
      ...process.env,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.output = ''
  const appendOutput = (chunk) => {
    child.output = `${child.output}${chunk.toString()}`
    if (child.output.length > 12_000) {
      child.output = child.output.slice(-12_000)
    }
  }
  child.stdout.on('data', appendOutput)
  child.stderr.on('data', appendOutput)
  child.on('error', (error) => {
    child.output = `${child.output}\n${label}: ${error.message}`
  })
  return child
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const stopped = await waitForExit(child, 3000)
  if (!stopped) {
    child.kill('SIGKILL')
    await waitForExit(child, 1000)
  }
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve(true)
    })
  })
}

async function waitForUrl(url, label) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Retry until the local server finishes booting.
    }
    await delay(500)
  }
  throw new Error(`${label} did not become ready at ${url}\nAPI output:\n${apiServer?.output || ''}\nUI output:\n${uiServer?.output || ''}`)
}

async function findAvailablePort(startPort, excluded = new Set()) {
  for (let port = startPort; port < startPort + 200; port += 1) {
    if (excluded.has(port)) continue
    if (await portAvailable(port)) return port
  }
  throw new Error(`No available port found from ${startPort}`)
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
