import type { ContextAttachment, ContextFields } from './types'

export function emptyContextFields(): ContextFields {
  return {
    text: '',
    urls: [],
    files: [],
  }
}

export function normalizeContextFields(value: Partial<ContextFields> = {}) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    text: String(source.text || '').trim(),
    urls: normalizeUrlList(source.urls),
    urlSnapshots: normalizeUrlSnapshots(source.urlSnapshots),
    files: normalizeContextAttachments(source.files),
  } satisfies ContextFields
}

export function normalizeUrlList(value: unknown) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean)
}

export function parseContextUrlInput(value: string) {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export function contextUrlInputValue(context: ContextFields) {
  return normalizeContextFields(context).urls.join('\n')
}

export function normalizeContextAttachments(value: unknown) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const source = item as Partial<ContextAttachment>
      const id = String(source.id || '').trim()
      const name = String(source.name || '').trim()
      if (!id || !name) return null
      return {
        id,
        name,
        type: String(source.type || '').trim(),
        size: Number.isFinite(Number(source.size)) ? Number(source.size) : 0,
        uploadedAt: String(source.uploadedAt || '').trim(),
        url: String(source.url || '').trim(),
        preview: String(source.preview || '').trim(),
        extractedText: String(source.extractedText || '').trim(),
        extractionStatus: String(source.extractionStatus || '').trim(),
        extractionError: String(source.extractionError || '').trim(),
        extractedAt: String(source.extractedAt || '').trim(),
        contentHash: String(source.contentHash || '').trim(),
        contentChars: Number.isFinite(Number(source.contentChars))
          ? Number(source.contentChars)
          : undefined,
      } satisfies ContextAttachment
    })
    .filter(Boolean) as ContextAttachment[]
}

function normalizeUrlSnapshots(value: unknown) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const source = item as NonNullable<ContextFields['urlSnapshots']>[number]
      const url = String(source.url || '').trim()
      if (!url) return null
      return {
        url,
        title: String(source.title || '').trim(),
        text: String(source.text || '').trim(),
        status: String(source.status || '').trim(),
        error: String(source.error || '').trim(),
        contentType: String(source.contentType || '').trim(),
        fetchedAt: String(source.fetchedAt || '').trim(),
        contentHash: String(source.contentHash || '').trim(),
        contentChars: Number.isFinite(Number(source.contentChars))
          ? Number(source.contentChars)
          : undefined,
      }
    })
    .filter(Boolean) as ContextFields['urlSnapshots']
}

export function contextHasContent(value: Partial<ContextFields> | undefined) {
  const context = normalizeContextFields(value)
  return Boolean(
    context.text ||
      context.urls.length ||
      (context.urlSnapshots || []).some((snapshot) => snapshot.text) ||
      context.files.length,
  )
}

export function contextSummary(value: Partial<ContextFields> | undefined) {
  const context = normalizeContextFields(value)
  return [
    context.text ? 'text' : '',
    context.urls.length ? `${context.urls.length} URL${context.urls.length === 1 ? '' : 's'}` : '',
    context.files.length ? `${context.files.length} file${context.files.length === 1 ? '' : 's'}` : '',
  ]
    .filter(Boolean)
    .join(' / ') || 'No context'
}
