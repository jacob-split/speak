import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const sourceRoot = 'src'
const failures = []

function collectFiles(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      collectFiles(fullPath, files)
    } else if (/\.(tsx?|css)$/.test(entry)) {
      files.push(fullPath)
    }
  }
  return files
}

const iconSource = readFileSync('src/SpeakIcons.tsx', 'utf8')

for (const token of [
  "from 'lucide-react'",
  'const SPEAK_ICON_STROKE = 1.65',
  'fill="none"',
  'strokeWidth={SPEAK_ICON_STROKE}',
  'absoluteStrokeWidth={false}',
]) {
  if (!iconSource.includes(token)) {
    failures.push(`src/SpeakIcons.tsx: missing icon-system token ${token}`)
  }
}

for (const file of collectFiles(sourceRoot)) {
  const text = readFileSync(file, 'utf8')
  if (
    file !== 'src/SpeakIcons.tsx' &&
    (text.includes("from 'lucide-react'") || text.includes('from "lucide-react"'))
  ) {
    failures.push(`${file}: app-owned icons must import from ./SpeakIcons, not lucide-react`)
  }
  if (file !== 'src/SpeakIcons.tsx' && /strokeWidth=\{(?:2|2\.\d+|3|3\.\d+)\}/.test(text)) {
    failures.push(`${file}: contains an explicit heavy icon strokeWidth prop`)
  }
  if (file !== 'src/SpeakIcons.tsx' && /fill="currentColor"/.test(text)) {
    failures.push(`${file}: contains an explicit filled icon override`)
  }
  if (/stroke-width=['"](?:2|2\.\d+|3|3\.\d+)['"]/.test(text)) {
    failures.push(`${file}: contains a heavy embedded SVG stroke width`)
  }
}

const branding = readFileSync('BRANDING.md', 'utf8')
for (const token of [
  'SpeakIcons',
  '1.65',
  'app-owned action, route, and status icons',
]) {
  if (!branding.includes(token)) {
    failures.push(`BRANDING.md: missing Speak icon-system guidance token ${token}`)
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2))
  process.exit(1)
}

console.log(JSON.stringify({ ok: true }, null, 2))
