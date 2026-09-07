import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

function distanceFromBottom(element: HTMLElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight
}

export function useChatScroll<T extends HTMLElement>(
  revision: unknown,
  threshold = 96,
) {
  const ref = useRef<T | null>(null)
  const userDetachedRef = useRef(false)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const element = ref.current
    if (!element) return
    element.scrollTo({
      top: element.scrollHeight,
      behavior,
    })
    userDetachedRef.current = false
    setShowJumpToLatest(false)
  }, [])

  useEffect(() => {
    const element = ref.current
    if (!element) return undefined

    const updateDetachedState = () => {
      const detached = distanceFromBottom(element) > threshold
      userDetachedRef.current = detached
      setShowJumpToLatest(detached)
    }

    updateDetachedState()
    element.addEventListener('scroll', updateDetachedState, { passive: true })
    return () => element.removeEventListener('scroll', updateDetachedState)
  }, [threshold])

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const nearBottom = distanceFromBottom(element) <= threshold
    if (!userDetachedRef.current || nearBottom) {
      scrollToLatest('auto')
      return
    }
    setShowJumpToLatest(true)
  }, [revision, scrollToLatest, threshold])

  return {
    ref,
    scrollToLatest,
    showJumpToLatest,
  }
}
