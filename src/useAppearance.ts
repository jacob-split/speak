import { useEffect, useState } from 'react'

import { getBrowserStorage } from './browserStorage'

export type Appearance = 'system' | 'light' | 'dark'

const appearanceStorageKey = 'speak:appearance'

function loadAppearance(): Appearance {
  if (typeof window === 'undefined') {
    return 'system'
  }

  try {
    const storage = getBrowserStorage()
    const saved = storage?.getItem(appearanceStorageKey)
    return saved === 'light' || saved === 'dark' || saved === 'system'
      ? saved
      : 'system'
  } catch {
    return 'system'
  }
}

export function useAppearance() {
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance)

  useEffect(() => {
    document.documentElement.dataset.appearance = appearance
    document.documentElement.style.colorScheme =
      appearance === 'system' ? 'light dark' : appearance
    try {
      getBrowserStorage()?.setItem(appearanceStorageKey, appearance)
    } catch {
      // Appearance should still apply even when storage is unavailable.
    }
  }, [appearance])

  return {
    appearance,
    setAppearance,
  }
}
