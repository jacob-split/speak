import { getBrowserStorage, type BrowserStorage } from './browserStorage'

export type LibraryColumnKey =
  | 'company'
  | 'name'
  | 'status'
  | 'lastCall'
  | 'calltime'
  | 'state'
  | 'email'
  | 'phone'
  | 'tags'
  | 'notes'

export interface LibraryColumn {
  key: LibraryColumnKey
  label: string
  visible: boolean
}

export const libraryColumnsStorageKey = 'speak:library-columns:v1'

export const defaultLibraryColumns: LibraryColumn[] = [
  { key: 'company', label: 'Business', visible: true },
  { key: 'name', label: 'Contact', visible: true },
  { key: 'status', label: 'Status', visible: true },
  { key: 'lastCall', label: 'Last call', visible: true },
  { key: 'calltime', label: 'Call time', visible: true },
  { key: 'state', label: 'State', visible: true },
  { key: 'email', label: 'Email', visible: false },
  { key: 'phone', label: 'Phone', visible: false },
  { key: 'tags', label: 'Tags', visible: false },
  { key: 'notes', label: 'Notes', visible: false },
]

export function normalizeLibraryColumns(value: unknown): LibraryColumn[] {
  if (!Array.isArray(value)) return defaultLibraryColumns
  const byKey = new Map(defaultLibraryColumns.map((column) => [column.key, column]))
  const restored = value
    .map((column) => {
      if (!column || typeof column !== 'object') return null
      const storedColumn = column as Partial<LibraryColumn>
      const baseline = byKey.get(storedColumn.key as LibraryColumnKey)
      if (!baseline) return null
      byKey.delete(baseline.key)
      return {
        ...baseline,
        label: String(storedColumn.label || baseline.label),
        visible: Boolean(storedColumn.visible),
      }
    })
    .filter(Boolean) as LibraryColumn[]
  return [...restored, ...Array.from(byKey.values())]
}

export function loadLibraryColumns(
  storage: BrowserStorage | null = getBrowserStorage(),
): LibraryColumn[] {
  if (!storage) return defaultLibraryColumns
  try {
    return normalizeLibraryColumns(
      JSON.parse(storage.getItem(libraryColumnsStorageKey) || '[]'),
    )
  } catch {
    return defaultLibraryColumns
  }
}

export function saveLibraryColumns(
  columns: LibraryColumn[],
  storage: BrowserStorage | null = getBrowserStorage(),
) {
  if (!storage) return
  storage.setItem(libraryColumnsStorageKey, JSON.stringify(columns))
}
