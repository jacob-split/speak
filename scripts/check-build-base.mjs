import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function normalizeBasePath(value) {
  let basePath = String(value || '/speak/').trim() || '/speak/'
  if (!basePath.startsWith('/')) basePath = `/${basePath}`
  if (!basePath.endsWith('/')) basePath = `${basePath}/`
  return basePath
}

const basePath = normalizeBasePath(
  process.env.VITE_BASE_PATH || process.env.BASE_PATH || '/speak/',
)
const htmlFiles = ['index.html', 'calltools-gateway.html']
const failures = []

for (const fileName of htmlFiles) {
  const htmlPath = join(process.cwd(), 'dist', fileName)
  if (!existsSync(htmlPath)) {
    failures.push(`dist/${fileName} is missing. Run the production build first.`)
    continue
  }

  const html = readFileSync(htmlPath, 'utf8')
  const assetRefs = Array.from(
    html.matchAll(/\b(?:src|href)="([^"]*assets\/[^"]+\.(?:js|css))"/g),
    (match) => match[1],
  )
  const expectedPrefix = `${basePath}assets/`
  const badRefs = assetRefs.filter((ref) => !ref.startsWith(expectedPrefix))

  if (assetRefs.length === 0) {
    failures.push(`No built JS/CSS asset references found in dist/${fileName}.`)
  }
  if (badRefs.length > 0) {
    failures.push(
      `Expected built assets in dist/${fileName} to start with ${expectedPrefix}; found ${badRefs.join(', ')}`,
    )
  }

  if (fileName === 'index.html') {
    const manifestRefs = Array.from(html.matchAll(/<link\b[^>]*>/gi), (match) => match[0])
      .filter((tag) => getHtmlAttribute(tag, 'rel') === 'manifest')
      .map((tag) => getHtmlAttribute(tag, 'href'))
      .filter(Boolean)
    if (!manifestRefs.includes(`${basePath}site.webmanifest`)) {
      failures.push(
        `Expected dist/index.html manifest link to be ${basePath}site.webmanifest; found ${manifestRefs.join(', ') || 'none'}`,
      )
    }
  }
}

const manifestPath = join(process.cwd(), 'dist', 'site.webmanifest')
if (!existsSync(manifestPath)) {
  failures.push('dist/site.webmanifest is missing. Run the production build first.')
} else {
  let manifest = null
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    failures.push(`dist/site.webmanifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (manifest) {
    if (manifest.start_url !== basePath) {
      failures.push(`Expected dist/site.webmanifest start_url to be ${basePath}; found ${manifest.start_url || 'missing'}`)
    }
    if (manifest.scope !== basePath) {
      failures.push(`Expected dist/site.webmanifest scope to be ${basePath}; found ${manifest.scope || 'missing'}`)
    }
    if (manifest.description !== "The director's seat for live autonomous agent and human voice calls.") {
      failures.push('dist/site.webmanifest description drifted from current Speak product copy.')
    }
    const icons = Array.isArray(manifest.icons) ? manifest.icons : []
    const requiredIcons = ['icon-192.png', 'icon-512.png', 'speak-icon.png']
    for (const iconSrc of requiredIcons) {
      if (!icons.some((icon) => icon?.src === iconSrc)) {
        failures.push(`dist/site.webmanifest missing icon ${iconSrc}`)
      }
    }
    const badIcons = icons
      .map((icon) => icon?.src)
      .filter((src) => typeof src === 'string' && (src.startsWith('/') || src.startsWith('http')))
    if (badIcons.length > 0) {
      failures.push(`dist/site.webmanifest icons must stay relative to ${basePath}; found ${badIcons.join(', ')}`)
    }
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, basePath, failures }, null, 2))
  process.exit(1)
}

console.log(JSON.stringify({ ok: true, basePath, manifest: 'dist/site.webmanifest' }, null, 2))

function getHtmlAttribute(tag, name) {
  const pattern = new RegExp(`\\b${name}="([^"]*)"`, 'i')
  return tag.match(pattern)?.[1] || ''
}
