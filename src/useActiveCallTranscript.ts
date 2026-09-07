import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { TranscriptEntry } from './types'

export function useActiveCallTranscript(
  activeCallControlId: string | undefined,
  setTranscript: Dispatch<SetStateAction<TranscriptEntry[]>>,
) {
  const transcriptCallIdRef = useRef('')

  useEffect(() => {
    if (!activeCallControlId) return
    if (transcriptCallIdRef.current === activeCallControlId) return
    transcriptCallIdRef.current = activeCallControlId
    setTranscript([])
  }, [activeCallControlId, setTranscript])
}
