import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const docScreenshotSpec = {
  schemaVersion: 'speak.doc-screenshots.v1',
  generatedBy: 'npm run docs:screenshots',
  manifestPath: 'docs/assets/screenshots/manifest.json',
  viewport: {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
  },
  fixtureSources: [
    'docs/fixtures/populated-workspace.json',
    'docs/fixtures/call-logs/events-2026-06-27.jsonl',
  ],
  routeSelectorLabels: ['Library', 'Dialer', 'Playground'],
  libraryModeLabels: ['Contacts', 'Activity', 'Agents'],
  captures: [
    {
      file: 'library-contacts-light.png',
      route: '/speak/library',
      appearance: 'light',
      surface: 'library',
      mode: 'contacts',
      waitSelector: '.contact-library',
    },
    {
      file: 'library-contacts-dark.png',
      route: '/speak/library',
      appearance: 'dark',
      surface: 'library',
      mode: 'contacts',
      waitSelector: '.contact-library',
    },
    {
      file: 'library-agents-light.png',
      route: '/speak/library',
      appearance: 'light',
      surface: 'library',
      mode: 'agents',
      waitSelector: '.agent-library',
    },
    {
      file: 'library-agents-dark.png',
      route: '/speak/library',
      appearance: 'dark',
      surface: 'library',
      mode: 'agents',
      waitSelector: '.agent-library',
    },
    {
      file: 'library-activity-light.png',
      route: '/speak/library',
      appearance: 'light',
      surface: 'library',
      mode: 'activity',
      waitSelector: '[data-testid="speak-transcript-library"]',
    },
    {
      file: 'library-activity-dark.png',
      route: '/speak/library',
      appearance: 'dark',
      surface: 'library',
      mode: 'activity',
      waitSelector: '[data-testid="speak-transcript-library"]',
    },
    {
      file: 'dialer-light.png',
      route: '/speak/dialer',
      appearance: 'light',
      surface: 'dialer',
      mode: 'dialer',
      waitSelector: '[data-testid="speak-route-dialer"]',
    },
    {
      file: 'dialer-dark.png',
      route: '/speak/dialer',
      appearance: 'dark',
      surface: 'dialer',
      mode: 'dialer',
      waitSelector: '[data-testid="speak-route-dialer"]',
    },
    {
      file: 'playground-light.png',
      route: '/speak/configs',
      appearance: 'light',
      surface: 'playground',
      mode: 'playground',
      waitSelector: '[data-testid="speak-route-configs"]',
    },
    {
      file: 'playground-dark.png',
      route: '/speak/configs',
      appearance: 'dark',
      surface: 'playground',
      mode: 'playground',
      waitSelector: '[data-testid="speak-route-configs"]',
    },
  ],
}

const staleScreenshotHashes = new Set([
  'e13dca60b94449fe81857e670bc95f9074d92af2f9b52dbd93eccbdc736e3f2a',
  '87e02bc697c78ebc78b34b31312b65dca72f4cce5666bb07ef372051f4d3def6',
  'e4ff7e92243186fb5f0c2c5a709bea62f1d5112cf549933b30a4ef3ed112a273',
  '7f5f25438247654d592a23c5d51592089250bda54233a44d03adf369b199c842',
  'f0b0c66de34ce83e6c407f52166f9912e2774784641516edb629f5b9660d6544',
  'ed8f61520344392c1c3080c3ec1b5228e35ef96b763b8cfa4f0608d75109a34d',
  '2bcc660834ee18fa8479a6a48c8bfbd3aa86060d0b5d0d72f0980a0118ffd4df',
  'e4f42ad6af6b6c81b57634de84f0b66632d12fea63af25d562c09529ca318c1b',
  '5493a26b79d5cc76ac04811cca7262cc263a25ea598b62732d66ac43a487bcec',
  'ca792c375585ec2e36301fdc0c90825b43b574be179040940ef2d1414ed8b04d',
])

export function verifyDocScreenshots({ root = process.cwd() } = {}) {
  const failures = []
  const manifestPath = path.join(root, docScreenshotSpec.manifestPath)
  const manifest = readJson(manifestPath, failures)
  const expectedFiles = docScreenshotSpec.captures.map((capture) => capture.file).sort()

  if (!manifest) {
    return {
      ok: false,
      schemaVersion: docScreenshotSpec.schemaVersion,
      checked: [],
      failures,
    }
  }

  if (manifest.schemaVersion !== docScreenshotSpec.schemaVersion) {
    failures.push(`${docScreenshotSpec.manifestPath}: unexpected schemaVersion ${manifest.schemaVersion || 'missing'}`)
  }
  if (manifest.generatedBy !== docScreenshotSpec.generatedBy) {
    failures.push(`${docScreenshotSpec.manifestPath}: generatedBy must be ${docScreenshotSpec.generatedBy}`)
  }
  if (JSON.stringify(manifest.viewport) !== JSON.stringify(docScreenshotSpec.viewport)) {
    failures.push(`${docScreenshotSpec.manifestPath}: viewport must stay ${docScreenshotSpec.viewport.width}x${docScreenshotSpec.viewport.height} at deviceScaleFactor ${docScreenshotSpec.viewport.deviceScaleFactor}`)
  }
  if (JSON.stringify(manifest.routeSelectorLabels) !== JSON.stringify(docScreenshotSpec.routeSelectorLabels)) {
    failures.push(`${docScreenshotSpec.manifestPath}: route selector labels must be Library / Dialer / Playground`)
  }
  if (JSON.stringify(manifest.libraryModeLabels) !== JSON.stringify(docScreenshotSpec.libraryModeLabels)) {
    failures.push(`${docScreenshotSpec.manifestPath}: library mode labels must be Contacts / Activity / Agents`)
  }

  const manifestFixturePaths = Array.isArray(manifest.fixtureSources)
    ? manifest.fixtureSources.map((entry) => entry.path).sort()
    : []
  if (JSON.stringify(manifestFixturePaths) !== JSON.stringify([...docScreenshotSpec.fixtureSources].sort())) {
    failures.push(`${docScreenshotSpec.manifestPath}: fixtureSources must list the docs workspace and call-log fixtures`)
  }
  for (const fixture of manifest.fixtureSources || []) {
    const fixturePath = path.join(root, fixture.path || '')
    if (!fixture.path || !existsSync(fixturePath)) {
      failures.push(`${docScreenshotSpec.manifestPath}: fixture source ${fixture.path || 'missing'} does not exist`)
      continue
    }
    const actualHash = sha256(readFileSync(fixturePath))
    if (fixture.sha256 !== actualHash) {
      failures.push(`${docScreenshotSpec.manifestPath}: fixture source ${fixture.path} hash is stale`)
    }
  }

  const manifestFiles = Array.isArray(manifest.captures)
    ? manifest.captures.map((capture) => capture.file).sort()
    : []
  if (JSON.stringify(manifestFiles) !== JSON.stringify(expectedFiles)) {
    failures.push(`${docScreenshotSpec.manifestPath}: captures must exactly match ${expectedFiles.join(', ')}`)
  }

  const capturesByFile = new Map((manifest.captures || []).map((capture) => [capture.file, capture]))
  const checked = []
  for (const expected of docScreenshotSpec.captures) {
    const capture = capturesByFile.get(expected.file)
    const screenshotPath = path.join(root, 'docs/assets/screenshots', expected.file)
    if (!capture) continue
    for (const field of ['route', 'appearance', 'surface', 'mode']) {
      if (capture[field] !== expected[field]) {
        failures.push(`${docScreenshotSpec.manifestPath}: ${expected.file} has stale ${field}`)
      }
    }
    if (!existsSync(screenshotPath)) {
      failures.push(`docs/assets/screenshots/${expected.file}: missing screenshot`)
      continue
    }
    const bytes = readFileSync(screenshotPath)
    const actualHash = sha256(bytes)
    const dimensions = pngDimensions(bytes)
    checked.push({
      file: expected.file,
      sha256: actualHash,
      dimensions,
    })
    if (!dimensions) {
      failures.push(`docs/assets/screenshots/${expected.file}: not a valid PNG`)
      continue
    }
    if (
      dimensions.width !== docScreenshotSpec.viewport.width ||
      dimensions.height !== docScreenshotSpec.viewport.height
    ) {
      failures.push(`docs/assets/screenshots/${expected.file}: expected ${docScreenshotSpec.viewport.width}x${docScreenshotSpec.viewport.height}, got ${dimensions.width}x${dimensions.height}`)
    }
    if (capture.sha256 !== actualHash) {
      failures.push(`docs/assets/screenshots/${expected.file}: hash does not match manifest`)
    }
    const expectedCacheKey = actualHash.slice(0, 12)
    if (capture.cacheKey !== expectedCacheKey) {
      failures.push(`${docScreenshotSpec.manifestPath}: ${expected.file} cacheKey must match the screenshot hash prefix`)
    }
    if (staleScreenshotHashes.has(actualHash)) {
      failures.push(`docs/assets/screenshots/${expected.file}: matches a known stale pre-route-selector screenshot hash`)
    }
  }

  const uiReferencePath = path.join(root, 'docs/ui-reference.md')
  const uiReference = existsSync(uiReferencePath) ? readFileSync(uiReferencePath, 'utf8') : ''
  for (const file of expectedFiles) {
    const capture = capturesByFile.get(file)
    const reference = `assets/screenshots/${file}?v=${capture?.cacheKey || ''}`
    if (!uiReference.includes(reference)) {
      failures.push(`docs/ui-reference.md: missing cache-busted reference ${reference}`)
    }
  }

  const agentIntegrationPath = path.join(root, 'docs/agent-integration.md')
  const agentIntegration = existsSync(agentIntegrationPath)
    ? readFileSync(agentIntegrationPath, 'utf8')
    : ''
  for (const file of expectedFiles) {
    const capture = capturesByFile.get(file)
    const reference = `docs/assets/screenshots/${file}?v=${capture?.cacheKey || ''}`
    if (!agentIntegration.includes(reference)) {
      failures.push(`docs/agent-integration.md: missing cache-busted reference ${reference}`)
    }
  }

  const docsHtmlPath = path.join(root, 'docs/index.html')
  const docsHtml = existsSync(docsHtmlPath) ? readFileSync(docsHtmlPath, 'utf8') : ''
  for (const file of expectedFiles) {
    const capture = capturesByFile.get(file)
    const reference = `assets/screenshots/${file}?v=${capture?.cacheKey || ''}`
    if (!docsHtml.includes(reference)) {
      failures.push(`docs/index.html: missing cache-busted reference ${reference}`)
    }
  }

  const indexMdPath = path.join(root, 'docs/index.md')
  const indexMd = existsSync(indexMdPath) ? readFileSync(indexMdPath, 'utf8') : ''
  for (const token of ['npm run docs:screenshots', 'npm run docs:check-screenshots']) {
    if (!indexMd.includes(token)) {
      failures.push(`docs/index.md: missing ${token}`)
    }
  }
  for (const file of expectedFiles) {
    const capture = capturesByFile.get(file)
    const reference = `assets/screenshots/${file}?v=${capture?.cacheKey || ''}`
    if (!indexMd.includes(reference)) {
      failures.push(`docs/index.md: missing cache-busted reference ${reference}`)
    }
  }

  return {
    ok: failures.length === 0,
    schemaVersion: docScreenshotSpec.schemaVersion,
    checked,
    failures,
  }
}

function readJson(file, failures) {
  if (!existsSync(file)) {
    failures.push(`${path.relative(process.cwd(), file)}: missing manifest`)
    return null
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    failures.push(`${path.relative(process.cwd(), file)}: invalid JSON (${error instanceof Error ? error.message : String(error)})`)
    return null
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function pngDimensions(bytes) {
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  ) {
    return null
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const payload = verifyDocScreenshots()
  console.log(JSON.stringify(payload, null, 2))
  if (!payload.ok) process.exit(1)
}
