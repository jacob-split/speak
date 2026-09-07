import {
  Bot,
  BriefcaseBusiness,
  Clock3,
  FileText,
  MessageSquare,
  Search,
  X,
} from './SpeakIcons'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { AgentConfigProfile } from './agentConfigs'
import { apiBase, apiUrl } from './api'
import {
  formatCallDate,
  recentAgentName,
  recentBusinessName,
  recentLeadName,
  type RecentCallSummary,
} from './calls'
import { navigateToAppUrl } from './navigation'
import { speakTestIds } from './uiContract'
import { useDismissibleLayer } from './useDismissibleLayer'

type SearchResultKind = 'lead' | 'profile' | 'thread' | 'transcript' | 'smart-view'

interface SearchResult {
  detail: string
  icon: ReactNode
  id: string
  kind: SearchResultKind
  score: number
  subtitle: string
  title: string
  onSelect: () => void
}

interface WorkspaceSearchResult {
  detail?: string
  id: string
  kind: SearchResultKind
  leadId?: string
  profile?: AgentConfigProfile
  profileId?: string
  score?: number
  smartViewId?: string
  subtitle?: string
  threadId?: string
  title?: string
}

interface CallsSearchPayload {
  calls?: RecentCallSummary[]
}

interface WorkspaceSearchPayload {
  results?: WorkspaceSearchResult[]
}

interface GlobalSearchOverlayProps {
  activeRoute: 'dialer' | 'configs' | 'library'
  onClose: () => void
  onSelectLead?: (leadId: string) => void
  onSelectProfile?: (profile: AgentConfigProfile) => void
  open: boolean
}

const globalSearchResultLimit = 24

function searchable(value: unknown) {
  return String(value || '').toLowerCase()
}

function scoreSearch(haystack: string, query: string) {
  if (!query) return 1
  const index = haystack.indexOf(query)
  if (index === -1) return 0
  return index === 0 ? 4 : haystack.includes(` ${query}`) ? 3 : 2
}

function resultRouteBase() {
  return apiBase().replace(/\/api$/, '')
}

function transcriptSnippet(call: RecentCallSummary, query: string) {
  const entry = call.transcript?.find((item) =>
    searchable(`${item.speaker} ${item.text}`).includes(query),
  )
  return entry?.text || call.insight || recentBusinessName(call) || recentLeadName(call)
}

function resultKindLabel(kind: SearchResultKind) {
  switch (kind) {
    case 'lead':
      return 'Contact'
    case 'profile':
      return 'Agent'
    case 'thread':
      return 'Thread'
    case 'smart-view':
      return 'View'
    case 'transcript':
      return 'Call'
    default:
      return 'Result'
  }
}

function searchResultIcon(kind: SearchResultKind) {
  switch (kind) {
    case 'lead':
      return <BriefcaseBusiness size={16} />
    case 'profile':
      return <Bot size={16} />
    case 'thread':
      return <MessageSquare size={16} />
    case 'smart-view':
      return <FileText size={16} />
    case 'transcript':
      return <Clock3 size={16} />
    default:
      return <Search size={16} />
  }
}

export function GlobalSearchOverlay({
  activeRoute,
  onClose,
  onSelectLead,
  onSelectProfile,
  open,
}: GlobalSearchOverlayProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const dialogRef = useRef<HTMLElement | null>(null)
  const [query, setQuery] = useState('')
  const [workspaceResults, setWorkspaceResults] = useState<WorkspaceSearchResult[]>([])
  const [recentCalls, setRecentCalls] = useState<RecentCallSummary[]>([])
  const [hasLoaded, setHasLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  const closeSearch = useCallback(() => {
    setQuery('')
    setActiveIndex(0)
    setHasLoaded(false)
    setLoading(false)
    onClose()
  }, [onClose])

  useEffect(() => {
    if (!open) return undefined
    const priorOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => {
      document.body.style.overflow = priorOverflow
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    let mounted = true
    const loadTimer = window.setTimeout(() => {
      if (!mounted) return
      setActiveIndex(0)
      setHasLoaded(false)
      setLoading(true)
      const searchParams = new URLSearchParams({
        limit: String(globalSearchResultLimit),
      })
      const trimmedQuery = query.trim()
      if (trimmedQuery) searchParams.set('q', trimmedQuery)
      Promise.all([
        fetch(apiUrl(`/search?${searchParams.toString()}`))
          .then((response) => response.json() as Promise<WorkspaceSearchPayload>)
          .catch((): WorkspaceSearchPayload => ({})),
        fetch(apiUrl('/calls/recent?limit=120'))
          .then((response) => response.json() as Promise<CallsSearchPayload>)
          .catch((): CallsSearchPayload => ({})),
        ])
        .then(([workspacePayload, callsPayload]) => {
          if (!mounted) return
          setWorkspaceResults(workspacePayload.results || [])
          setRecentCalls(callsPayload.calls || [])
        })
        .finally(() => {
          if (mounted) {
            setHasLoaded(true)
            setLoading(false)
          }
        })
    }, 0)
    return () => {
      mounted = false
      window.clearTimeout(loadTimer)
    }
  }, [open, query])

  useDismissibleLayer({
    enabled: open,
    onDismiss: closeSearch,
    refs: [dialogRef],
  })

  const results = useMemo(() => {
    const normalizedQuery = searchable(query.trim())
    const basePath = resultRouteBase()
    const workspaceSearchResults: SearchResult[] = workspaceResults.map((result) => {
      const kind = result.kind
      const leadId = result.leadId || result.id.replace(/^lead:/, '')
      const profileId = result.profileId || result.id.replace(/^profile:/, '')
      const smartViewId = result.smartViewId || result.id.replace(/^smart-view:/, '')
      const threadId = result.threadId || result.id.replace(/^thread:/, '')
      return {
        detail: result.detail || '',
        icon: searchResultIcon(kind),
        id: result.id,
        kind,
        score: Number(result.score) || 1,
        subtitle: result.subtitle || resultKindLabel(kind),
        title: result.title || resultKindLabel(kind),
        onSelect: () => {
          if (kind === 'lead') {
            if (activeRoute === 'dialer' && onSelectLead) {
              onSelectLead(leadId)
              closeSearch()
              return
            }
            navigateToAppUrl(`${basePath}/#lead=${encodeURIComponent(leadId)}`)
            closeSearch()
            return
          }
          if (kind === 'profile') {
            if (activeRoute === 'configs' && onSelectProfile && result.profile) {
              onSelectProfile(result.profile)
              closeSearch()
              return
            }
            if (activeRoute === 'library') {
              navigateToAppUrl(`${basePath}/library#agent=${encodeURIComponent(profileId)}`)
              closeSearch()
              return
            }
            navigateToAppUrl(`${basePath}/configs#profile=${encodeURIComponent(profileId)}`)
            closeSearch()
            return
          }
          if (kind === 'smart-view') {
            navigateToAppUrl(`${basePath}/library#view=${encodeURIComponent(smartViewId)}`)
            closeSearch()
            return
          }
          if (kind === 'thread') {
            navigateToAppUrl(`${basePath}/library#thread=${encodeURIComponent(threadId)}`)
            closeSearch()
          }
        },
      }
    })

    const transcriptResults: SearchResult[] = recentCalls.flatMap((call) => {
      const title = recentBusinessName(call) || recentLeadName(call)
      const snippet = transcriptSnippet(call, normalizedQuery)
      const haystack = searchable([
        title,
        recentLeadName(call),
        recentAgentName(call),
        call.insight,
        call.outcome,
        call.phase,
        call.lead?.business_name,
        call.lead?.name,
        call.transcript?.map((entry) => `${entry.speaker} ${entry.text}`).join(' '),
      ].join(' '))
      const score = scoreSearch(haystack, normalizedQuery)
      if (!score) return []
      return [{
        detail: recentAgentName(call) || snippet || call.outcome || call.phase || '',
        icon: searchResultIcon('transcript'),
        id: `transcript:${call.callControlId}`,
        kind: 'transcript',
        score,
        subtitle: formatCallDate(call.createdAt || call.updatedAt),
        title,
        onSelect: () => {
          if (call.lead?.id && activeRoute === 'dialer' && onSelectLead) {
            onSelectLead(call.lead.id)
            closeSearch()
            return
          }
          navigateToAppUrl(
            `${basePath}/library#transcript=${encodeURIComponent(call.callControlId)}`,
          )
          closeSearch()
        },
      }]
    })

    return [
      ...workspaceSearchResults,
      ...transcriptResults,
    ]
      .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
      .slice(0, globalSearchResultLimit)
  }, [
    activeRoute,
    closeSearch,
    onSelectLead,
    onSelectProfile,
    query,
    recentCalls,
    workspaceResults,
  ])

  if (!open) return null

  const safeActiveIndex =
    results.length === 0 ? 0 : Math.min(activeIndex, results.length - 1)
  const activeResult = results[safeActiveIndex]
  const indexPending = loading || !hasLoaded

  return (
    <div
      className="global-search-backdrop"
      role="presentation"
    >
      <section
        className="global-search-dialog"
        data-testid={speakTestIds.globalSearchDialog}
        role="dialog"
        aria-modal="true"
        aria-label="Search Speak"
        ref={dialogRef}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            if (results.length > 0) {
              setActiveIndex((current) => Math.min(current + 1, results.length - 1))
            }
            return
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActiveIndex((current) => Math.max(current - 1, 0))
            return
          }
          if (event.key === 'Enter' && activeResult) {
            event.preventDefault()
            activeResult.onSelect()
          }
        }}
      >
        <header className="global-search-header">
          <div className="global-search-input-row">
            <span className="global-search-lens" aria-hidden="true">
              <Search size={18} />
            </span>
            <input
              ref={inputRef}
              value={query}
              placeholder="Search Speak"
              aria-label="Search contacts, threads, calls, agents, and Smart Views"
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              enterKeyHint="search"
              inputMode="search"
              spellCheck={false}
              onChange={(event) => {
                setQuery(event.target.value)
                setActiveIndex(0)
              }}
            />
            <button
              className="icon-button global-search-close"
              type="button"
              title="Close search"
              aria-label="Close search"
              onClick={closeSearch}
            >
              <X size={15} />
            </button>
          </div>
        </header>
        <div className="global-search-results" role="listbox" aria-label="Search results">
          {indexPending && results.length === 0 ? (
            <p>Indexing workspace...</p>
          ) : results.length === 0 ? (
            <p>No results</p>
          ) : (
            results.map((result, index) => (
              <button
                key={result.id}
                className={[
                  'global-search-result',
                  index === safeActiveIndex ? 'active' : '',
                  `search-kind-${result.kind}`,
                ]
                  .filter(Boolean)
                  .join(' ')}
                data-search-result-id={result.id}
                data-search-result-kind={result.kind}
                type="button"
                role="option"
                aria-selected={index === safeActiveIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={result.onSelect}
              >
                <span className="global-search-result-icon">{result.icon}</span>
                <span className="global-search-result-copy">
                  <span className="global-search-result-title-line">
                    <strong>{result.title}</strong>
                    <em>{resultKindLabel(result.kind)}</em>
                  </span>
                  <span>{result.subtitle}</span>
                </span>
                <span className="global-search-result-detail">{result.detail}</span>
              </button>
            ))
          )}
        </div>
      </section>
    </div>
  )
}
