import {
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  ChevronDown,
  ChevronUp,
} from './SpeakIcons'
import { CopyAction } from './CopyAction'

interface ChatMessageBodyProps {
  children: ReactNode
  collapsedChildren?: ReactNode
  collapseLabels?: {
    collapsed: string
    expanded: string
  }
  extraActions?: ReactNode
  forceCollapsible?: boolean
  text: string
}

const COLLAPSE_CHARACTER_LIMIT = 900
const COLLAPSE_LINE_LIMIT = 12

function shouldCollapseMessage(text: string) {
  const normalized = text.trim()
  if (!normalized) return false
  if (normalized.length > COLLAPSE_CHARACTER_LIMIT) return true
  return normalized.split(/\r?\n/).length > COLLAPSE_LINE_LIMIT
}

export function ChatMessageBody({
  children,
  collapsedChildren,
  collapseLabels,
  extraActions,
  forceCollapsible = false,
  text,
}: ChatMessageBodyProps) {
  const [expanded, setExpanded] = useState(false)
  const collapsible = useMemo(
    () => forceCollapsible || shouldCollapseMessage(text),
    [forceCollapsible, text],
  )
  const collapsed = collapsible && !expanded
  const hasCopy = Boolean(text.trim())
  const collapsedLabel = collapseLabels?.collapsed || 'Show more'
  const expandedLabel = collapseLabels?.expanded || 'Show less'

  return (
    <>
      <div
        className={[
          'chat-message-body',
          collapsed ? 'is-collapsed' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {collapsed && collapsedChildren ? collapsedChildren : children}
      </div>
      {(collapsible || hasCopy || extraActions) && (
        <div
          className={[
            'chat-message-actions',
            collapsible ? 'has-expand' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {collapsible && (
            <button
              className="chat-message-action"
              type="button"
              onClick={() => setExpanded((current) => !current)}
              aria-expanded={expanded}
            >
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              <span>{expanded ? expandedLabel : collapsedLabel}</span>
            </button>
          )}
          {hasCopy && (
            <CopyAction
              className="chat-message-action chat-copy-action"
              label="Copy message"
              value={text}
            />
          )}
          {extraActions}
        </div>
      )}
    </>
  )
}
