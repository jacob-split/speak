import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = ['README.md', ...fs.readdirSync(path.join(root, 'docs')).filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`), 'docs/index.html']
const failures = []
const privateHost = /^(?:sales|files|control|crm|personal|hermes|sign|macro)\.split-llc\.com$/i
const allowedAbsoluteHosts = new Set(['speak.split-llc.com','github.com','127.0.0.1','localhost','speak.example.com','your-silo.calltools.io','api.telnyx.com'])
const ignoredSchemes = /^(?:mailto:|tel:|data:|javascript:)/i

function inspectUrl(sourceFile, raw) {
  const value = raw.replace(/&amp;/g, '&').trim()
  if (!value || value.startsWith('#') || ignoredSchemes.test(value) || value.includes('{') || value.includes('}')) return
  if (/^https?:\/\//i.test(value)) {
    let url
    try { url = new URL(value) } catch { failures.push(`${sourceFile}: invalid URL ${value}`); return }
    if (privateHost.test(url.hostname)) failures.push(`${sourceFile}: private/shared Split host ${url.hostname}`)
    if (url.hostname.endsWith('.split-llc.com') && url.hostname !== 'speak.split-llc.com') failures.push(`${sourceFile}: non-docs Split host ${url.hostname}`)
    if (!allowedAbsoluteHosts.has(url.hostname)) failures.push(`${sourceFile}: unexpected external host ${url.hostname}`)
    return
  }
  const clean = value.split(/[?#]/, 1)[0]
  if (!clean || clean.startsWith('/')) return
  const target = path.resolve(root, path.dirname(sourceFile), clean)
  if (!fs.existsSync(target)) failures.push(`${sourceFile}: broken local link ${value}`)
}

for (const file of files) {
  const text = fs.readFileSync(path.join(root, file), 'utf8')
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) inspectUrl(file, match[1])
  if (file.endsWith('.html')) {
    for (const match of text.matchAll(/(?:href|src)="([^"]+)"/g)) inspectUrl(file, match[1])
  }
  if (/https?:\/\/(?:sales|files|control|crm|personal|hermes|sign|macro)\.split-llc\.com/i.test(text)) failures.push(`${file}: contains private/shared Split URL text`)
  if (/@split-llc\.com|\/home\/jacob|\/srv\/split-target|\/etc\/split-target/i.test(text)) failures.push(`${file}: contains private deployment identity`)
}

if (failures.length) { console.error(JSON.stringify({ ok:false, failures }, null, 2)); process.exit(1) }
console.log(JSON.stringify({ ok:true, files: files.length, canonicalHost:'speak.split-llc.com', allowedExternalHosts:[...allowedAbsoluteHosts] }, null, 2))
