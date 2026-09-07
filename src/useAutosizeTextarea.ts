import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'

export function useAutosizeTextarea(value: string) {
  const ref = useRef<HTMLTextAreaElement | null>(null)

  const resize = useCallback(() => {
    const textarea = ref.current
    if (!textarea) return

    const computed = window.getComputedStyle(textarea)
    const minHeight = Number.parseFloat(computed.minHeight)
    const maxHeight = Number.parseFloat(computed.maxHeight)
    const hasMaxHeight = Number.isFinite(maxHeight) && maxHeight > 0

    textarea.style.height = 'auto'

    const nextHeight = Math.max(
      Number.isFinite(minHeight) ? minHeight : 0,
      hasMaxHeight ? Math.min(textarea.scrollHeight, maxHeight) : textarea.scrollHeight,
    )

    textarea.style.height = `${nextHeight}px`
    textarea.style.overflowY =
      hasMaxHeight && textarea.scrollHeight > maxHeight + 1 ? 'auto' : 'hidden'
  }, [])

  useLayoutEffect(() => {
    resize()
  }, [resize, value])

  useEffect(() => {
    let frame = 0
    const handleResize = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(resize)
    }
    window.addEventListener('resize', handleResize)
    window.visualViewport?.addEventListener('resize', handleResize)

    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', handleResize)
      window.visualViewport?.removeEventListener('resize', handleResize)
    }
  }, [resize])

  return ref
}
