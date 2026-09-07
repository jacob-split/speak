import {
  type RefObject,
  useEffect,
  useRef,
} from 'react'

interface DismissibleLayerOptions {
  enabled: boolean
  onDismiss: () => void
  onEscapeDismiss?: () => void
  refs: Array<RefObject<HTMLElement | null>>
}

export function useDismissibleLayer({
  enabled,
  onDismiss,
  onEscapeDismiss,
  refs,
}: DismissibleLayerOptions) {
  const onDismissRef = useRef(onDismiss)
  const onEscapeDismissRef = useRef(onEscapeDismiss)
  const refsRef = useRef(refs)

  useEffect(() => {
    onDismissRef.current = onDismiss
    onEscapeDismissRef.current = onEscapeDismiss
    refsRef.current = refs
  })

  useEffect(() => {
    if (!enabled) return undefined

    function targetIsInsideLayer(target: EventTarget | null) {
      if (!(target instanceof Node)) return false
      return refsRef.current.some((ref) => ref.current?.contains(target))
    }

    function handlePointerDown(event: PointerEvent) {
      if (targetIsInsideLayer(event.target)) return
      onDismissRef.current()
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      const dismiss = onEscapeDismissRef.current || onDismissRef.current
      dismiss()
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [enabled])
}
