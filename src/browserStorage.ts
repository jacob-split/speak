export type BrowserStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>

export function getBrowserStorage(): BrowserStorage | null {
  try {
    return globalThis.localStorage || null
  } catch {
    return null
  }
}
