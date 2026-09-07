import {
  type RefObject,
  useEffect,
  useState,
} from 'react'

interface UseVisibleScrollSectionOptions<T extends HTMLElement> {
  containerRef: RefObject<T | null>
  fallbackId: string | null
  sectionIds: readonly string[]
  revision?: unknown
  selector?: string
  datasetKey?: string
}

export function useVisibleScrollSection<T extends HTMLElement>({
  containerRef,
  datasetKey = 'callControlId',
  fallbackId,
  revision,
  sectionIds,
  selector = '[data-call-control-id]',
}: UseVisibleScrollSectionOptions<T>) {
  const [visibleId, setVisibleId] = useState<string | null>(fallbackId)

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      setVisibleId(fallbackId)
      return undefined
    }

    const validIds = new Set(sectionIds)
    const updateVisibleSection = () => {
      const containerRect = container.getBoundingClientRect()
      const candidates = Array.from(
        container.querySelectorAll<HTMLElement>(selector),
      )

      let bestId: string | null = null
      let bestDistance = Number.POSITIVE_INFINITY

      candidates.forEach((candidate) => {
        const sectionId = candidate.dataset[datasetKey]
        if (!sectionId || !validIds.has(sectionId)) return

        const rect = candidate.getBoundingClientRect()
        const visible =
          rect.bottom > containerRect.top && rect.top < containerRect.bottom
        if (!visible) return

        const distance = Math.abs(rect.top - containerRect.top)
        if (distance < bestDistance) {
          bestDistance = distance
          bestId = sectionId
        }
      })

      setVisibleId(bestId || fallbackId)
    }

    const frame = window.requestAnimationFrame(updateVisibleSection)
    container.addEventListener('scroll', updateVisibleSection, {
      passive: true,
    })
    window.addEventListener('resize', updateVisibleSection)

    return () => {
      window.cancelAnimationFrame(frame)
      container.removeEventListener('scroll', updateVisibleSection)
      window.removeEventListener('resize', updateVisibleSection)
    }
  }, [
    containerRef,
    datasetKey,
    fallbackId,
    revision,
    sectionIds,
    selector,
  ])

  return visibleId
}
