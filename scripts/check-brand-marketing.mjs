import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const failures = []
const requireFile = (p) => { if (!fs.existsSync(path.join(root,p))) failures.push(`missing ${p}`) }

for (const p of ['README.md','LICENSE','CONTRIBUTING.md','SECURITY.md','docs/index.html','docs/index.md','docs/assets/speak-logo-mark.svg','docs/assets/speak-share-card.png','docs/assets/screenshots/manifest.json']) requireFile(p)
const readme=read('README.md'), html=read('docs/index.html'), md=read('docs/index.md')
for (const [name,text] of [['README.md',readme],['docs/index.html',html],['docs/index.md',md]]) {
  if (/sales\.split-llc\.com|@split-llc\.com|\/home\/jacob|\/srv\/split-target|\/etc\/split-target|gizmo/i.test(text)) failures.push(`${name}: contains private deployment identity`)
}
for (const token of ['https://github.com/jacob-split/speak','Apache-2.0','Operator']) if (!readme.includes(token)) failures.push(`README.md missing ${token}`)
for (const token of ['data-theme-value="system"','data-theme-value="light"','data-theme-value="dark"','localStorage','Library','Dialer','Playground','Codex paths','MCP/ChatGPT Apps']) if (!html.includes(token)) failures.push(`docs/index.html missing ${token}`)
if (/here\.now|S-tier verification|Production routes|live product/i.test(html)) failures.push('docs/index.html contains deployment-only or retired showcase content')
for (const doc of ['ui-reference.md','agent-integration.md','backend-api-reference.md','communication-thread-model.md','configuration-options.md','voice-provider-integration.md','generative-ui-widgets.md','agent-reference.md','BRANDING.md']) if (!html.includes(`href="${doc}"`)) failures.push(`docs/index.html missing ${doc} link`)
const manifest=JSON.parse(read('docs/assets/screenshots/manifest.json'))
const serialized=html+'\n'+md
for (const item of manifest.screenshots || manifest.items || []) {
  const rel=item.relativePath || item.path || item.file || item.filename
  if (!rel) continue
  const normalized=String(rel).replace(/^docs\//,'')
  if (!fs.existsSync(path.join(root,'docs',normalized)) && !fs.existsSync(path.join(root,rel))) failures.push(`missing screenshot ${rel}`)
  if (!serialized.includes(path.basename(normalized))) failures.push(`docs index missing screenshot ${path.basename(normalized)}`)
}
if (process.argv.includes('--published')) {
  const base=process.env.SPEAK_PRODUCT_PAGE_URL || 'https://files.split-llc.com/speak/'
  const response=await fetch(base,{headers:{accept:'text/html'}}).catch(()=>null)
  if (!response?.ok) failures.push(`published docs returned HTTP ${response?.status || 'unavailable'}`)
  else {
    const live=await response.text()
    for (const token of ['View source on GitHub','Open source','Architecture','Integrations']) if (!live.includes(token)) failures.push(`published docs missing ${token}`)
  }
}
if (failures.length) { console.error(JSON.stringify({ok:false,failures},null,2)); process.exit(1) }
console.log(JSON.stringify({ok:true,checks:'public docs, brand, release metadata and synthetic screenshot inventory'},null,2))
