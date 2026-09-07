import {
  useEffect,
  useState,
} from 'react'
import { apiUrl } from './api'
import { makeTranscriptEntry } from './calls'
import type { TranscriptEntry } from './types'

interface PendingInstruction {
  id: string
  text: string
}

interface LiveInstructionTarget {
  callControlId: string
  chatId?: string
}

interface UseLiveInstructionsOptions {
  liveInstructionTarget?: LiveInstructionTarget | null
  setNotice: (message: string) => void
}

class InstructionSendError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function postInstructionToCall(
  target: LiveInstructionTarget,
  instruction: string,
) {
  const response = await fetch(
    apiUrl(`/calls/${target.callControlId}/instructions`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: target.chatId, instruction }),
    },
  )
  const payload = await response.json()

  if (!response.ok) {
    throw new InstructionSendError(
      payload.error || 'Instruction send failed',
      response.status,
    )
  }
}

function isStaleInstructionTarget(error: unknown) {
  return error instanceof InstructionSendError && error.status === 409
}

export function useLiveInstructions({
  liveInstructionTarget,
  setNotice,
}: UseLiveInstructionsOptions) {
  const [liveInstruction, setLiveInstruction] = useState('')
  const [liveInstructions, setLiveInstructions] = useState<TranscriptEntry[]>([])
  const [queuedInstructions, setQueuedInstructions] = useState<PendingInstruction[]>([])
  const [instructionSending, setInstructionSending] = useState(false)

  useEffect(() => {
    const targetCallControlId = liveInstructionTarget?.callControlId
    const targetChatId = liveInstructionTarget?.chatId
    if (!targetCallControlId || !targetChatId || queuedInstructions.length === 0) {
      return
    }

    const target: LiveInstructionTarget = {
      callControlId: targetCallControlId,
      chatId: targetChatId,
    }
    const nextInstruction = queuedInstructions[0]
    let cancelled = false

    async function flushQueuedInstruction() {
      try {
        await postInstructionToCall(target, nextInstruction.text)

        if (cancelled) return
        setQueuedInstructions((current) =>
          current.filter((instruction) => instruction.id !== nextInstruction.id),
        )
        setLiveInstructions((current) => [
          ...current,
          makeTranscriptEntry({
            speaker: 'System',
            text: `Queued instruction delivered: ${nextInstruction.text}`,
            tone: 'system',
          }),
        ])
        setNotice('Queued instruction sent to agent')
      } catch (error) {
        if (!cancelled) {
          setNotice(
            isStaleInstructionTarget(error)
              ? 'Operator guidance saved for the agent'
              : error instanceof Error
                ? error.message
                : 'Queued instruction send failed',
          )
        }
      }
    }

    void flushQueuedInstruction()

    return () => {
      cancelled = true
    }
  }, [
    liveInstructionTarget?.callControlId,
    liveInstructionTarget?.chatId,
    queuedInstructions,
    setNotice,
  ])

  async function sendLiveInstruction() {
    if (instructionSending) return
    const instruction = liveInstruction.trim()
    if (!instruction) return

    const entry = makeTranscriptEntry({
      speaker: 'You',
      text: `Live instruction to agent: ${instruction}`,
      tone: 'system',
    })

    function queueInstruction() {
      setLiveInstructions((current) => [...current, entry])
      setQueuedInstructions((current) => [
        ...current,
        { id: entry.id, text: instruction },
      ])
      setLiveInstruction('')
      setNotice('Operator guidance saved for the agent')
    }

    if (!liveInstructionTarget?.chatId) {
      queueInstruction()
      return
    }

    try {
      setInstructionSending(true)
      await postInstructionToCall(liveInstructionTarget, instruction)
      setLiveInstructions((current) => [...current, entry])
      setLiveInstruction('')
      setNotice('Live instruction sent')
    } catch (error) {
      if (isStaleInstructionTarget(error)) {
        queueInstruction()
      } else {
        setNotice(
          error instanceof Error ? error.message : 'Instruction send failed',
        )
      }
    } finally {
      setInstructionSending(false)
    }
  }

  function queueLiveInstruction(text: string) {
    const instruction = text.trim()
    if (!instruction) return

    const entry = makeTranscriptEntry({
      speaker: 'You',
      text: `Live instruction to agent: ${instruction}`,
      tone: 'system',
    })

    setLiveInstructions((current) => [...current, entry])
    setQueuedInstructions((current) => [
      ...current,
      { id: entry.id, text: instruction },
    ])
    setNotice('Operator guidance saved for the agent')
  }

  function markQueuedInstructionsAttached(count: number) {
    if (count <= 0) return

    setQueuedInstructions([])
    setLiveInstructions((current) => [
      ...current,
      makeTranscriptEntry({
        speaker: 'System',
        text: `${count} queued instruction${count === 1 ? '' : 's'} attached to this call context.`,
        tone: 'system',
      }),
    ])
  }

  return {
    instructionSending,
    liveInstruction,
    liveInstructions,
    markQueuedInstructionsAttached,
    queueLiveInstruction,
    queuedInstructions,
    queuedInstructionTexts: queuedInstructions.map(
      (instruction) => instruction.text,
    ),
    sendLiveInstruction,
    setLiveInstruction,
  }
}
