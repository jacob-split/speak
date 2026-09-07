import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'

async function writeClipboardText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the selection-based copy path for constrained browsers.
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  document.body.appendChild(textarea)
  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)
  try {
    return document.execCommand('copy')
  } finally {
    textarea.remove()
  }
}

export function useClipboardCopy(resetDelayMs = 1400) {
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<number | null>(null)

  const clearResetTimer = useCallback(() => {
    if (resetTimerRef.current === null) return
    window.clearTimeout(resetTimerRef.current)
    resetTimerRef.current = null
  }, [])

  const copyText = useCallback(
    async (text: string) => {
      clearResetTimer()
      try {
        const copied = await writeClipboardText(text)
        setCopied(copied)
        if (copied) {
          resetTimerRef.current = window.setTimeout(() => {
            setCopied(false)
            resetTimerRef.current = null
          }, resetDelayMs)
        }
      } catch {
        setCopied(false)
      }
    },
    [clearResetTimer, resetDelayMs],
  )

  useEffect(() => clearResetTimer, [clearResetTimer])

  return {
    copied,
    copyText,
  }
}
