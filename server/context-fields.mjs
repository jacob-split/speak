import { createHash, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cheerio from 'cheerio'
import mammoth from 'mammoth'
import Papa from 'papaparse'
import { PDFParse } from 'pdf-parse'
import readXlsxFile from 'read-excel-file/node'
import { unzipSync } from 'fflate'
import { safeLeadText } from './runtime-config.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const workspaceDataDir = path.resolve(
  __dirname,
  '..',
  process.env.SPEAK_WORKSPACE_DATA_DIR || 'workspace-data',
)
const contextFilesDir = path.join(workspaceDataDir, 'context-files')
const contextUploadMaxBytes = Number(process.env.SPEAK_CONTEXT_FILE_UPLOAD_MAX_BYTES || 100 * 1024 * 1024)
const filePreviewMaxBytes = Number(process.env.SPEAK_CONTEXT_FILE_PREVIEW_BYTES || 16 * 1024)
const runtimeContextMaxChars = Number(process.env.SPEAK_RUNTIME_CONTEXT_CHARS || 12000)
const runtimeTextMaxChars = Number(process.env.SPEAK_RUNTIME_CONTEXT_TEXT_CHARS || 4000)
const toolContextMaxChars = Number(process.env.SPEAK_CONTEXT_TOOL_CHARS || 60000)
const toolContextItemChars = Number(process.env.SPEAK_CONTEXT_TOOL_ITEM_CHARS || 12000)
const extractedTextMaxChars = Number(process.env.SPEAK_CONTEXT_EXTRACTED_TEXT_CHARS || 200000)
const urlFetchMaxBytes = Number(process.env.SPEAK_CONTEXT_URL_FETCH_MAX_BYTES || 2 * 1024 * 1024)
const urlFetchTimeoutMs = Number(process.env.SPEAK_CONTEXT_URL_FETCH_TIMEOUT_MS || 2500)
const urlRefreshTtlMs = Number(process.env.SPEAK_CONTEXT_URL_REFRESH_TTL_MS || 5 * 60 * 1000)
const urlRefreshMaxCount = Number(process.env.SPEAK_CONTEXT_URL_REFRESH_MAX || 8)

export function emptyContextFields() {
  return {
    text: '',
    urls: [],
    urlSnapshots: [],
    files: [],
  }
}

export function normalizeContextFields(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    text: safeContextText(source.text),
    urls: normalizeUrlList(source.urls),
    urlSnapshots: normalizeUrlSnapshots(source.urlSnapshots),
    files: normalizeContextAttachments(source.files),
  }
}

export function normalizeUrlList(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean)
}

export function normalizeContextAttachments(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const id = String(item.id || '').trim()
      const name = safeFileName(item.name)
      if (!id || !name) return null
      return {
        id,
        name,
        type: String(item.type || '').trim(),
        size: Number.isFinite(Number(item.size)) ? Number(item.size) : 0,
        uploadedAt: String(item.uploadedAt || '').trim(),
        url: String(item.url || '').trim() || `/api/context-files/${encodeURIComponent(id)}/download`,
        preview: safeContextText(item.preview),
        extractedText: safeContextText(item.extractedText || item.content),
        extractionStatus: normalizeExtractionStatus(item.extractionStatus),
        extractionError: safeContextText(item.extractionError),
        extractedAt: String(item.extractedAt || '').trim(),
        contentHash: String(item.contentHash || '').trim(),
        contentChars: Number.isFinite(Number(item.contentChars))
          ? Number(item.contentChars)
          : safeContextText(item.extractedText || item.content).length,
      }
    })
    .filter(Boolean)
}

export function normalizeUrlSnapshots(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const url = normalizeContextUrl(item.url)
      if (!url || seen.has(url)) return null
      seen.add(url)
      return {
        url,
        title: safeContextText(item.title),
        text: safeContextText(item.text || item.content),
        status: normalizeUrlSnapshotStatus(item.status),
        error: safeContextText(item.error),
        contentType: String(item.contentType || '').trim(),
        fetchedAt: String(item.fetchedAt || '').trim(),
        contentHash: String(item.contentHash || '').trim(),
        contentChars: Number.isFinite(Number(item.contentChars))
          ? Number(item.contentChars)
          : safeContextText(item.text || item.content).length,
      }
    })
    .filter(Boolean)
}

export function contextHasContent(value) {
  const context = normalizeContextFields(value)
  return Boolean(
    context.text ||
      context.urls.length ||
      context.urlSnapshots.some((snapshot) => snapshot.text) ||
      context.files.length,
  )
}

export function contextCounts(value) {
  const context = normalizeContextFields(value)
  return {
    hasText: Boolean(context.text),
    urls: context.urls.length,
    files: context.files.length,
  }
}

export function buildContextToolPayload({ leadContext, profileContext, legacyNotes } = {}) {
  const lead = normalizeContextFields(leadContext)
  const profile = normalizeContextFields(profileContext)
  const payload = {
    lead_context: {
      ...contextForTool(lead),
      legacy_notes: safeContextText(legacyNotes),
      counts: contextCounts(lead),
    },
    agent_context: {
      ...contextForTool(profile),
      counts: contextCounts(profile),
    },
  }
  return truncateObjectText(payload, toolContextMaxChars)
}

export function renderRuntimeContext({
  leadContext,
  profileContext,
  legacyNotes,
  conversationMemory,
} = {}) {
  const lines = []
  const agentLines = renderContextBlock('agent_context', profileContext)
  const leadLines = renderContextBlock('lead_context', leadContext, {
    legacyNotes,
  })
  const memoryLines = renderConversationMemoryBlock(conversationMemory)

  if (agentLines.length) lines.push(...agentLines)
  if (leadLines.length) lines.push(...leadLines)
  if (memoryLines.length) lines.push(...memoryLines)

  const rendered = lines.join('\n')
  return truncateText(rendered, runtimeContextMaxChars)
}

export async function prepareRuntimeContextFields({ leadContext, profileContext } = {}) {
  const lead = await refreshContextUrlSnapshots(leadContext)
  const profile = await refreshContextUrlSnapshots(profileContext)
  return {
    leadContext: lead.context,
    leadChanged: lead.changed,
    profileContext: profile.context,
    profileChanged: profile.changed,
  }
}

export async function saveContextFileFromRequest(request, { basePath = '' } = {}) {
  const id = randomUUID()
  const name = safeFileName(decodeURIComponent(String(request.headers['x-speak-file-name'] || 'context-file')))
  const type = String(request.headers['content-type'] || request.headers['x-speak-file-type'] || '').trim()
  const fileName = `${id}-${name || 'context-file'}`
  const filePath = path.join(contextFilesDir, fileName)
  const metadataPath = path.join(contextFilesDir, `${id}.json`)
  const tempPath = `${filePath}.${process.pid}.tmp`
  let size = 0

  await mkdir(contextFilesDir, { recursive: true })

  try {
    await new Promise((resolve, reject) => {
      const output = createWriteStream(tempPath)
      output.on('error', reject)
      output.on('finish', resolve)
      request.on('error', reject)
      request.on('data', (chunk) => {
        size += chunk.length
        if (size > contextUploadMaxBytes) {
          output.destroy(new Error('Context file exceeds upload limit'))
          request.destroy()
          return
        }
        output.write(chunk)
      })
      request.on('end', () => {
        output.end()
      })
    })
    await rm(filePath, { force: true })
    await rename(tempPath, filePath)
  } catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }

  const extraction = await extractContextFileText(filePath, { type, name })
  const preview = extraction.text
    ? truncateText(extraction.text, filePreviewMaxBytes)
    : await readContextFilePreview(filePath, { type, name })
  const metadata = {
    id,
    name,
    type,
    size,
    uploadedAt: new Date().toISOString(),
    storageKey: fileName,
    url: `${basePath || ''}/api/context-files/${encodeURIComponent(id)}/download`,
    preview,
    extractedText: extraction.text,
    extractionStatus: extraction.status,
    extractionError: extraction.error,
    extractedAt: new Date().toISOString(),
    contentHash: extraction.text ? hashText(extraction.text) : '',
    contentChars: extraction.text.length,
  }
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)
  return publicContextAttachment(metadata)
}

export async function readContextFile(fileId) {
  const id = String(fileId || '').trim()
  if (!/^[a-f0-9-]{36}$/i.test(id)) return null
  const metadataPath = path.join(contextFilesDir, `${id}.json`)
  if (!existsSync(metadataPath)) return null
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
  const filePath = path.join(contextFilesDir, path.basename(metadata.storageKey || ''))
  if (!existsSync(filePath)) return null
  return {
    metadata,
    filePath,
  }
}

export async function deleteContextFile(fileId) {
  const stored = await readContextFile(fileId)
  if (!stored) return false
  const id = String(fileId || '').trim()
  await Promise.all([
    rm(stored.filePath, { force: true }),
    rm(path.join(contextFilesDir, `${id}.json`), { force: true }),
  ])
  return true
}

function publicContextAttachment(metadata) {
  return normalizeContextAttachments([metadata])[0]
}

function renderContextBlock(label, value, { legacyNotes = '' } = {}) {
  const context = normalizeContextFields(value)
  const lines = []
  const legacy = safeContextText(legacyNotes)
  const hasLegacy = Boolean(legacy)
  if (!contextHasContent(context) && !hasLegacy) return lines

  lines.push(`<${label}>`)
  if (context.text) {
    lines.push('text:', truncateText(context.text, runtimeTextMaxChars))
  }
  if (hasLegacy) {
    lines.push('notes:', truncateText(legacy, runtimeTextMaxChars))
  }
  if (context.urls.length) {
    lines.push('urls:')
    context.urls.forEach((url) => {
      const snapshot = context.urlSnapshots.find((item) => item.url === normalizeContextUrl(url))
      lines.push(`- ${url}`)
      if (snapshot?.title) lines.push(`  title: ${truncateText(snapshot.title, 240)}`)
      if (snapshot?.status) lines.push(`  status: ${snapshot.status}`)
      if (snapshot?.contentChars) lines.push(`  extracted_chars: ${snapshot.contentChars}`)
      if (snapshot?.status === 'error' && snapshot.error) {
        lines.push(`  retrieval_note: ${truncateText(snapshot.error, 240)}`)
      }
    })
  }
  if (context.files.length) {
    lines.push('files:')
    context.files.forEach((file) => {
      const fileLine = [file.name, file.type, file.size ? `${file.size} bytes` : ''].filter(Boolean).join(' / ')
      lines.push(`- ${fileLine}`)
      if (file.extractionStatus) lines.push(`  status: ${file.extractionStatus}`)
      if (file.contentChars) lines.push(`  extracted_chars: ${file.contentChars}`)
      if (file.extractionStatus === 'unsupported') {
        lines.push('  retrieval_note: unsupported file type')
      } else if (file.extractionStatus === 'error' && file.extractionError) {
        lines.push(`  retrieval_note: ${truncateText(file.extractionError, 240)}`)
      }
    })
  }
  lines.push(
    'Do not assume source contents from the inventory alone. If the conversation or the context text indicates a source is relevant, call get_lead_context before using file, URL, or prior-call details.',
    `</${label}>`,
  )
  return lines
}

function renderConversationMemoryBlock(value) {
  if (!Array.isArray(value) || !value.length) return []
  const lines = [
    '<conversation_memory>',
    'Prior conversations are available for this contact. Retrieve details with get_lead_context only when continuity is relevant to the conversation.',
  ]
  value.forEach((memory) => {
    const heading = [
      memory.date || memory.updatedAt || '',
      memory.agent ? `agent: ${memory.agent}` : '',
      memory.outcome ? `outcome: ${memory.outcome}` : '',
    ].filter(Boolean).join(' / ')
    lines.push(`- ${heading || 'prior call'}`)
  })
  lines.push('</conversation_memory>')
  return lines
}

function contextForTool(context) {
  const normalized = normalizeContextFields(context)
  return {
    text: normalized.text,
    urls: normalized.urls,
    url_snapshots: normalized.urlSnapshots.map((snapshot) => ({
      url: snapshot.url,
      title: snapshot.title,
      status: snapshot.status,
      fetched_at: snapshot.fetchedAt,
      content_type: snapshot.contentType,
      content: truncateText(snapshot.text, toolContextItemChars),
      error: snapshot.error,
    })),
    files: normalized.files.map((file) => ({
      id: file.id,
      name: file.name,
      type: file.type,
      size: file.size,
      uploadedAt: file.uploadedAt,
      url: file.url,
      extractionStatus: file.extractionStatus,
      extractedAt: file.extractedAt,
      contentChars: file.contentChars,
      content: truncateText(file.extractedText || file.preview, toolContextItemChars),
      extractionError: file.extractionError,
    })),
  }
}

async function refreshContextUrlSnapshots(value) {
  const context = normalizeContextFields(value)
  if (!context.urls.length) return { context, changed: false }

  const previous = new Map(context.urlSnapshots.map((snapshot) => [snapshot.url, snapshot]))
  const nextSnapshotJobs = []
  let changed = false
  let refreshes = 0

  for (const rawUrl of context.urls) {
    const url = normalizeContextUrl(rawUrl)
    if (!url) continue
    const existing = previous.get(url)
    if (shouldRefreshUrlSnapshot(existing) && refreshes < urlRefreshMaxCount) {
      refreshes += 1
      const snapshot = fetchUrlSnapshot(url).catch((error) => ({
        url,
        title: existing?.title || '',
        text: existing?.text || '',
        status: 'error',
        error: error instanceof Error ? error.message : 'URL fetch failed',
        contentType: existing?.contentType || '',
        fetchedAt: new Date().toISOString(),
        contentHash: existing?.contentHash || '',
        contentChars: existing?.contentChars || 0,
      }))
      nextSnapshotJobs.push(snapshot.then((item) => normalizeUrlSnapshots([item])[0]))
      changed = true
      continue
    }
    if (existing) {
      nextSnapshotJobs.push(Promise.resolve(existing))
    }
  }

  const nextSnapshots = await Promise.all(nextSnapshotJobs)
  const nextContext = normalizeContextFields({
    ...context,
    urlSnapshots: nextSnapshots.filter(Boolean),
  })
  return {
    context: nextContext,
    changed:
      changed ||
      JSON.stringify(nextContext.urlSnapshots) !== JSON.stringify(context.urlSnapshots),
  }
}

function shouldRefreshUrlSnapshot(snapshot) {
  if (!snapshot?.fetchedAt) return true
  if (!Number.isFinite(urlRefreshTtlMs) || urlRefreshTtlMs <= 0) return true
  const fetchedAt = Date.parse(snapshot.fetchedAt)
  if (!Number.isFinite(fetchedAt)) return true
  return Date.now() - fetchedAt > urlRefreshTtlMs
}

async function fetchUrlSnapshot(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(250, urlFetchTimeoutMs))
  let currentUrl = await resolvePublicContextUrl(url)
  try {
    let response = null
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      response = await fetch(currentUrl, {
        headers: {
          accept: 'text/html,application/pdf,text/plain,text/markdown,text/csv,application/json,application/xml,*/*;q=0.8',
          'user-agent': 'SpeakContextFetcher/1.0 (+https://speak.example.com/speak/)',
        },
        redirect: 'manual',
        signal: controller.signal,
      })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      const location = response.headers.get('location')
      if (!location) break
      currentUrl = await resolvePublicContextUrl(new URL(location, currentUrl).toString())
      if (redirects === 5) throw new Error('URL redirect limit exceeded')
    }
    if (!response.ok) {
      throw new Error(`URL returned HTTP ${response.status}`)
    }
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim()
    const buffer = await readResponseBuffer(response, urlFetchMaxBytes)
    const extraction = await extractContextBufferText(buffer, { type: contentType, name: url })
    return {
      url,
      title: extraction.title,
      text: extraction.text,
      status: extraction.status,
      error: extraction.error,
      contentType,
      fetchedAt: new Date().toISOString(),
      contentHash: extraction.text ? hashText(extraction.text) : '',
      contentChars: extraction.text.length,
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function resolvePublicContextUrl(value) {
  const url = new URL(normalizeContextUrl(value))
  if (!url.hostname) throw new Error('URL hostname is required')
  if (url.username || url.password) throw new Error('URL credentials are not allowed')
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true, verbatim: true })
  if (!addresses.length) throw new Error('URL hostname did not resolve')
  if (addresses.some((item) => isPrivateOrReservedAddress(item.address))) {
    throw new Error('URL resolves to a private or reserved network')
  }
  return url.toString()
}

function isPrivateOrReservedAddress(address) {
  const version = isIP(address)
  if (version === 4) return isPrivateOrReservedIpv4(address)
  if (version === 6) return isPrivateOrReservedIpv6(address)
  return true
}

function isPrivateOrReservedIpv4(address) {
  const parts = address.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true
  }
  const [a, b, c] = parts
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  )
}

function isPrivateOrReservedIpv6(address) {
  const text = address.toLowerCase()
  const mappedIpv4 = text.match(/(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (mappedIpv4) return isPrivateOrReservedIpv4(mappedIpv4[1])
  return (
    text === '::' ||
    text === '::1' ||
    text.startsWith('fc') ||
    text.startsWith('fd') ||
    text.startsWith('fe8') ||
    text.startsWith('fe9') ||
    text.startsWith('fea') ||
    text.startsWith('feb') ||
    text.startsWith('ff')
  )
}

async function readResponseBuffer(response, maxBytes) {
  const reader = response.body?.getReader?.()
  if (!reader) {
    const arrayBuffer = await response.arrayBuffer()
    return Buffer.from(arrayBuffer).slice(0, maxBytes)
  }
  const chunks = []
  let total = 0
  while (total < maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value)
    const next = chunk.slice(0, Math.max(0, maxBytes - total))
    chunks.push(next)
    total += next.length
    if (chunk.length > next.length) break
  }
  await reader.cancel().catch(() => undefined)
  return Buffer.concat(chunks)
}

async function extractContextFileText(filePath, { type, name } = {}) {
  try {
    const buffer = await readFile(filePath)
    return await extractContextBufferText(buffer, { type, name })
  } catch (error) {
    return {
      text: '',
      title: '',
      status: 'error',
      error: error instanceof Error ? error.message : 'Context file extraction failed',
    }
  }
}

async function extractContextBufferText(buffer, { type, name } = {}) {
  const mime = String(type || '').toLowerCase()
  const fileName = String(name || '').toLowerCase()
  try {
    if (mime.includes('pdf') || /\.pdf(?:$|[?#])/i.test(fileName)) {
      const parser = new PDFParse({ data: buffer })
      try {
        const result = await parser.getText()
        return extractedTextResult(result?.text || result?.pages?.map((page) => page.text).join('\n\n'), 'pdf')
      } finally {
        await parser.destroy().catch(() => undefined)
      }
    }

    if (
      mime.includes('wordprocessingml.document') ||
      /\.docx(?:$|[?#])/i.test(fileName)
    ) {
      const result = await mammoth.extractRawText({ buffer })
      return extractedTextResult(result.value, 'docx')
    }

    if (
      mime.includes('spreadsheetml.sheet') ||
      /\.xlsx(?:$|[?#])/i.test(fileName)
    ) {
      const rows = await readXlsxFile(buffer)
      const text = rowsToText(rows) || xlsxZipTextFallback(buffer)
      return extractedTextResult(text, 'xlsx')
    }

    if (mime.includes('csv') || /\.csv(?:$|[?#])/i.test(fileName)) {
      return extractedTextResult(csvToText(buffer.toString('utf8')), 'csv')
    }

    if (mime.includes('html') || /\.html?(?:$|[?#])/i.test(fileName)) {
      return htmlToExtractedText(buffer.toString('utf8'))
    }

    if (
      mime.startsWith('text/') ||
      ['application/json', 'application/xml', 'application/javascript'].includes(mime) ||
      /\.(txt|md|markdown|json|xml|log)(?:$|[?#])/i.test(fileName)
    ) {
      return extractedTextResult(buffer.toString('utf8'), 'text')
    }

    if (/\.doc(?:$|[?#])/i.test(fileName)) {
      return {
        text: '',
        title: '',
        status: 'unsupported',
        error: 'Legacy .doc files are not text-extracted by this runtime. Convert to .docx or PDF.',
      }
    }

    return {
      text: '',
      title: '',
      status: 'unsupported',
      error: 'Unsupported context file type',
    }
  } catch (error) {
    return {
      text: '',
      title: '',
      status: 'error',
      error: error instanceof Error ? error.message : 'Context extraction failed',
    }
  }
}

function htmlToExtractedText(html) {
  const $ = cheerio.load(html || '')
  $('script,style,noscript,svg,canvas,iframe').remove()
  const title = safeContextText($('title').first().text())
  const body = safeContextText($('body').text().replace(/\s+/g, ' '))
  return {
    ...extractedTextResult(body || safeContextText($.root().text()), 'html'),
    title,
  }
}

function extractedTextResult(value, extractor) {
  const text = truncateText(safeContextText(value), extractedTextMaxChars)
  return {
    text,
    title: '',
    status: text ? 'ready' : 'empty',
    error: text ? '' : `No text content extracted from ${extractor}`,
  }
}

function rowsToText(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) =>
      (Array.isArray(row) ? row : [])
        .map((cell) => safeContextText(cell instanceof Date ? cell.toISOString() : cell))
        .join('\t'),
    )
    .join('\n')
}

function csvToText(text) {
  const parsed = Papa.parse(text, {
    skipEmptyLines: true,
  })
  if (parsed.errors?.length && !parsed.data?.length) return text
  return rowsToText(parsed.data)
}

function xlsxZipTextFallback(buffer) {
  try {
    const files = unzipSync(new Uint8Array(buffer))
    const sharedStrings = extractXlsxSharedStrings(files)
    return Object.entries(files)
      .filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
      .map(([, content]) => extractXlsxSheetText(Buffer.from(content).toString('utf8'), sharedStrings))
      .filter(Boolean)
      .join('\n\n')
  } catch {
    return ''
  }
}

function extractXlsxSharedStrings(files) {
  const raw = files['xl/sharedStrings.xml']
  if (!raw) return []
  const $ = cheerio.load(Buffer.from(raw).toString('utf8'), { xmlMode: true })
  return $('si')
    .toArray()
    .map((node) => safeContextText($(node).text()))
}

function extractXlsxSheetText(xml, sharedStrings) {
  const $ = cheerio.load(xml, { xmlMode: true })
  return $('row')
    .toArray()
    .map((row) =>
      $(row)
        .find('c')
        .toArray()
        .map((cell) => {
          const $cell = $(cell)
          const type = $cell.attr('t')
          if (type === 's') {
            const index = Number($cell.find('v').first().text())
            return safeContextText(sharedStrings[index])
          }
          return safeContextText($cell.find('is t').text() || $cell.find('v').text())
        })
        .filter(Boolean)
        .join('\t'),
    )
    .filter(Boolean)
    .join('\n')
}

async function readContextFilePreview(filePath, { type, name } = {}) {
  if (!isPreviewableContextFile({ type, name })) return ''
  return new Promise((resolve) => {
    const chunks = []
    let bytes = 0
    const stream = createReadStream(filePath, { highWaterMark: 4096 })
    stream.on('data', (chunk) => {
      if (bytes >= filePreviewMaxBytes) {
        stream.destroy()
        return
      }
      const next = chunk.slice(0, Math.max(0, filePreviewMaxBytes - bytes))
      chunks.push(next)
      bytes += next.length
    })
    stream.on('close', () => {
      resolve(safeContextText(Buffer.concat(chunks).toString('utf8')))
    })
    stream.on('error', () => resolve(''))
    stream.on('end', () => {
      resolve(safeContextText(Buffer.concat(chunks).toString('utf8')))
    })
  })
}

function isPreviewableContextFile({ type, name } = {}) {
  const mime = String(type || '').toLowerCase()
  const fileName = String(name || '').toLowerCase()
  return (
    mime.startsWith('text/') ||
    ['application/json', 'application/xml', 'application/javascript'].includes(mime) ||
    /\.(txt|md|markdown|csv|json|xml|html|htm|log)$/i.test(fileName)
  )
}

function normalizeExtractionStatus(value) {
  const status = String(value || '').trim()
  if (['ready', 'empty', 'unsupported', 'error'].includes(status)) return status
  return 'empty'
}

function normalizeUrlSnapshotStatus(value) {
  const status = String(value || '').trim()
  if (['ready', 'empty', 'unsupported', 'error'].includes(status)) return status
  return 'empty'
}

function normalizeContextUrl(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  try {
    const url = new URL(text)
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    url.hash = ''
    return url.toString()
  } catch {
    return ''
  }
}

function safeContextText(value) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .trim()
}

function safeFileName(value) {
  return safeLeadText(value).replace(/[^\w .@()+\-=]/g, '_').slice(0, 180)
}

function truncateText(value, maxChars) {
  const text = safeContextText(value)
  if (!text || text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 28)).trimEnd()}\n[truncated for runtime context]`
}

function truncateObjectText(value, maxChars) {
  const text = JSON.stringify(value)
  if (text.length <= maxChars) return value

  const compact = JSON.parse(text)
  ;['lead_context', 'agent_context'].forEach((key) => {
    const context = compact[key]
    if (!context) return
    context.url_snapshots = (context.url_snapshots || []).map((snapshot) => ({
      ...snapshot,
      content: truncateText(snapshot.content, 3000),
    }))
    context.files = (context.files || []).map((file, index) => ({
      ...file,
      content: index < 6 ? truncateText(file.content, 3000) : '',
      compacted: index >= 6,
    }))
  })
  compact.truncated = true
  compact.message =
    'Context payload was compacted for tool response size. File and URL names remain available; ask focused follow-up questions if more detail is needed.'
  return compact
}

function hashText(value) {
  return createHash('sha256').update(String(value || '')).digest('hex')
}
