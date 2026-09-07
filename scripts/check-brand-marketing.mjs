import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const failures = []
const requireFile = (p) => { if (!fs.existsSync(path.join(root, p))) failures.push(`missing ${p}`) }

for (const p of ['README.md','LICENSE','CONTRIBUTING.md','SECURITY.md','docs/index.html','docs/assets/speak-logo-mark.svg','docs/assets/speak-share-card.png','docs/assets/screenshots/dialer-light.png','docs/assets/screenshots/dialer-dark.png']) requireFile(p)
const readme = read('README.md')
const html = read('docs/index.html')
const publicText = `${readme}\n${html}`
const forbidden = /sales\.split-llc\.com|files\.split-llc\.com|control\.split-llc\.com|crm\.split-llc\.com|personal\.split-llc\.com|hermes\.split-llc\.com|sign\.split-llc\.com|macro\.split-llc\.com|@split-llc\.com|\/home\/jacob|\/srv\/split-target|\/etc\/split-target|here\.now/i
if (forbidden.test(publicText)) failures.push('public overview contains a private/shared deployment reference')
for (const token of ['https://speak.split-llc.com/','https://github.com/jacob-split/speak','Apache-2.0','Library','Dialer','Playground','Run locally','Browse the source']) if (!publicText.includes(token)) failures.push(`public overview missing ${token}`)
for (const token of ['data-theme-value="system"','data-theme-value="light"','data-theme-value="dark"','localStorage']) if (!html.includes(token)) failures.push(`docs/index.html missing ${token}`)
if (!/<link rel="canonical" href="https:\/\/speak\.split-llc\.com\/">/.test(html)) failures.push('docs landing canonical URL must be speak.split-llc.com')
if (/href="(?:ui-reference|configuration-options|agent-integration|backend-api-reference|communication-thread-model|voice-provider-integration|agent-reference|generative-ui-widgets|BRANDING)\.md"/.test(html)) failures.push('docs landing should not expose the internal technical-doc inventory')

if (process.argv.includes('--published')) {
  const base = process.env.SPEAK_PRODUCT_PAGE_URL || 'https://speak.split-llc.com/'
  const response = await fetch(base, { headers: { accept: 'text/html', 'user-agent': 'SpeakPublicDocsCheck/1.0' } }).catch(() => null)
  if (!response?.ok) failures.push(`published docs returned HTTP ${response?.status || 'unavailable'}`)
  else {
    const live = await response.text()
    for (const token of ['Operate voice agents without losing control.','Browse the source','https://github.com/jacob-split/speak']) if (!live.includes(token)) failures.push(`published docs missing ${token}`)
    if (forbidden.test(live)) failures.push('published docs contain a private/shared deployment reference')
  }
}

if (failures.length) { console.error(JSON.stringify({ ok:false, failures }, null, 2)); process.exit(1) }
console.log(JSON.stringify({ ok:true, checks:'public overview, canonical URL, source links, privacy boundary and theme support' }, null, 2))
