import {
  type ChangeEvent,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import Papa from 'papaparse'
import { apiUrl } from './api'
import { createId } from './ids'
import {
  csvRowToLead,
  isDeletedLead,
  loadDeletedLeadFingerprints,
  loadDeletedLeadIds,
  loadStoredLeadState,
  rememberDeletedLeads,
  saveStoredLeadState,
  statusLabels,
} from './leads'
import type {
  ActiveCall,
  Lead,
  LeadFilterSnapshot,
  LeadStatus,
  SmartView,
} from './types'

interface UseLeadWorkspaceOptions {
  activeCall: ActiveCall | null
  activeCallRef: MutableRefObject<ActiveCall | null>
  campaignQueueIdsRef: MutableRefObject<string[]>
  setActiveCall: Dispatch<SetStateAction<ActiveCall | null>>
  setCampaignQueueIds: Dispatch<SetStateAction<string[]>>
  setNotice: (message: string) => void
}

export function useLeadWorkspace({
  activeCall,
  activeCallRef,
  campaignQueueIdsRef,
  setActiveCall,
  setCampaignQueueIds,
  setNotice,
}: UseLeadWorkspaceOptions) {
  const [leads, setLeads] = useState<Lead[]>(loadStoredLeadState)
  const leadsRef = useRef<Lead[]>(leads)
  const [smartViews, setSmartViews] = useState<SmartView[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null)

  useEffect(() => {
    leadsRef.current = leads
    saveStoredLeadState(leads)
  }, [leads])

  const setLeadsState = useCallback((updater: SetStateAction<Lead[]>) => {
    setLeads((current) => {
      const next =
        typeof updater === 'function'
          ? (updater as (value: Lead[]) => Lead[])(current)
          : updater
      leadsRef.current = next
      return next
    })
  }, [])

  const applyServerLeads = useCallback((payload: { leads?: Lead[]; lead?: Lead }) => {
    if (Array.isArray(payload.leads)) {
      setLeadsState(payload.leads)
      return
    }

    if (payload.lead?.id) {
      setLeadsState((current) => {
        const exists = current.some((lead) => lead.id === payload.lead?.id)
        if (!payload.lead) return current
        return exists
          ? current.map((lead) => (lead.id === payload.lead?.id ? payload.lead : lead))
          : [payload.lead, ...current]
      })
    }
  }, [setLeadsState])

  const applyServerSmartViews = useCallback((payload: {
    smartView?: SmartView
    smartViews?: SmartView[]
  }) => {
    if (Array.isArray(payload.smartViews)) {
      setSmartViews(payload.smartViews)
      return
    }

    if (payload.smartView?.id) {
      setSmartViews((current) => [
        payload.smartView as SmartView,
        ...current.filter((smartView) => smartView.id !== payload.smartView?.id),
      ])
    }
  }, [])

  const sendLeadMutation = useCallback(async (
    path: string,
    options: RequestInit,
    fallbackMessage: string,
  ) => {
    try {
      const response = await fetch(apiUrl(path), {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
      })
      const payload = (await response.json().catch(() => ({}))) as {
        leads?: Lead[]
        lead?: Lead
        error?: string
      }
      if (!response.ok) throw new Error(payload.error || fallbackMessage)
      applyServerLeads(payload)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : fallbackMessage)
    }
  }, [applyServerLeads, setNotice])

  useEffect(() => {
    let mounted = true

    async function hydrateServerLeads() {
      const localLeads = leadsRef.current

      try {
        const response = await fetch(apiUrl('/leads'))
        const payload = (await response.json().catch(() => ({}))) as {
          leads?: Lead[]
          error?: string
        }
        if (!response.ok) throw new Error(payload.error || 'Contact workspace failed')
        if (!mounted) return

        if (payload.leads?.length) {
          setLeadsState(payload.leads)
          return
        }

        if (localLeads.length > 0) {
          await sendLeadMutation(
            '/leads',
            {
              method: 'PUT',
              body: JSON.stringify({
                leads: localLeads,
                deletedLeadIds: Array.from(loadDeletedLeadIds()),
                deletedLeadFingerprints: Array.from(loadDeletedLeadFingerprints()),
              }),
            },
            'Contact workspace migration failed',
          )
        }
      } catch (error) {
        if (mounted) {
          setNotice(error instanceof Error ? error.message : 'Contact workspace failed')
        }
      }
    }

    void hydrateServerLeads()

    return () => {
      mounted = false
    }
  }, [sendLeadMutation, setLeadsState, setNotice])

  useEffect(() => {
    let mounted = true

    async function hydrateSmartViews() {
      try {
        const response = await fetch(apiUrl('/smart-views'))
        const payload = (await response.json().catch(() => ({}))) as {
          smartViews?: SmartView[]
          error?: string
        }
        if (!response.ok) throw new Error(payload.error || 'Smart Views failed')
        if (mounted) setSmartViews(payload.smartViews || [])
      } catch (error) {
        if (mounted) {
          setNotice(error instanceof Error ? error.message : 'Smart Views failed')
        }
      }
    }

    void hydrateSmartViews()

    return () => {
      mounted = false
    }
  }, [setNotice])

  const updateLead = useCallback((id: string, patch: Partial<Lead>) => {
    setLeadsState((current) =>
      current.map((lead) => (lead.id === id ? { ...lead, ...patch } : lead)),
    )
    void sendLeadMutation(
      `/leads/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ patch }),
      },
      'Contact update failed',
    )
  }, [sendLeadMutation, setLeadsState])

  const createSmartViewFromFilters = useCallback(async ({
    filters,
    leadIds,
    name,
  }: {
    filters: LeadFilterSnapshot
    leadIds: string[]
    name: string
  }) => {
    const cleanName = name.trim() || 'Filtered Smart View'
    const uniqueLeadIds = Array.from(new Set(leadIds.filter(Boolean)))
    try {
      const response = await fetch(apiUrl('/smart-views'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          smartView: {
            name: cleanName,
            source: 'filters',
            filters,
            leadIds: uniqueLeadIds,
          },
        }),
      })
      const payload = (await response.json().catch(() => ({}))) as {
        smartView?: SmartView
        smartViews?: SmartView[]
        error?: string
      }
      if (!response.ok) throw new Error(payload.error || 'Smart View save failed')
      applyServerSmartViews(payload)
      setNotice(
        `${payload.smartView?.name || cleanName} saved with ${uniqueLeadIds.length} contacts`,
      )
      return payload.smartView || null
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Smart View save failed')
      return null
    }
  }, [applyServerSmartViews, setNotice])

  function handleSmartViewCsvUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    const viewName =
      file.name.replace(/\.[^.]+$/, '').trim() || 'Imported Smart View'

    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        const deleted = loadDeletedLeadIds()
        const deletedFingerprints = loadDeletedLeadFingerprints()
        const imported = result.data
          .map(csvRowToLead)
          .filter((lead) => lead.name || lead.phone || lead.company)
          .filter((lead) => !isDeletedLead(lead, deleted, deletedFingerprints))

        if (imported.length === 0) {
          setNotice(`No usable contacts found in ${file.name}`)
          return
        }

        void (async () => {
          try {
            const response = await fetch(apiUrl('/smart-views/import'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: viewName,
                leads: imported,
              }),
            })
            const payload = (await response.json().catch(() => ({}))) as {
              imported?: Lead[]
              leads?: Lead[]
              smartView?: SmartView
              smartViews?: SmartView[]
              error?: string
            }
            if (!response.ok) {
              throw new Error(payload.error || 'Smart View CSV import failed')
            }

            if (Array.isArray(payload.leads)) {
              setLeadsState(payload.leads)
            } else {
              setLeadsState((current) => [...imported, ...current])
            }
            applyServerSmartViews(payload)
            const importedIds =
              payload.smartView?.leadIds || imported.map((lead) => lead.id)
            setSelectedIds(new Set(importedIds))
            setSelectedLeadId(importedIds[0] || null)
            setNotice(
              `${payload.smartView?.name || viewName} Smart View created with ${
                importedIds.length
                } contacts`,
            )
          } catch (error) {
            setNotice(
              error instanceof Error
                ? error.message
                : 'Smart View CSV import failed',
            )
          }
        })()
      },
      error: (error) => {
        setNotice(`Smart View CSV import failed: ${error.message}`)
      },
    })

    event.target.value = ''
  }

  function toggleRow(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  function toggleAllVisible(visibleLeads: Lead[]) {
    setSelectedIds((current) => {
      const visibleIds = visibleLeads.map((lead) => lead.id)
      const allVisibleSelected = visibleIds.every((id) => current.has(id))
      const next = new Set(current)

      visibleIds.forEach((id) => {
        if (allVisibleSelected) {
          next.delete(id)
        } else {
          next.add(id)
        }
      })

      return next
    })
  }

  function bulkStatus(status: LeadStatus) {
    setLeadsState((current) =>
      current.map((lead) =>
        selectedIds.has(lead.id) ? { ...lead, status } : lead,
      ),
    )
    setNotice(`${selectedIds.size} contacts moved to ${statusLabels[status]}`)
    void sendLeadMutation(
      '/leads/bulk-status',
      {
        method: 'POST',
        body: JSON.stringify({ ids: Array.from(selectedIds), status }),
      },
      'Bulk status update failed',
    )
  }

  function bulkDelete() {
    const ids = new Set(selectedIds)
    const deletedLeads = leads.filter((lead) => ids.has(lead.id))
    rememberDeletedLeads(deletedLeads)
    setLeadsState((current) => current.filter((lead) => !ids.has(lead.id)))
    if (activeCall && ids.has(activeCall.leadId)) {
      activeCallRef.current = null
      setActiveCall(null)
    }
    if (selectedLeadId && ids.has(selectedLeadId)) {
      setSelectedLeadId(null)
    }
    setCampaignQueueIds((current) => current.filter((id) => !ids.has(id)))
    campaignQueueIdsRef.current = campaignQueueIdsRef.current.filter(
      (id) => !ids.has(id),
    )
    setNotice(`${selectedIds.size} contacts deleted`)
    setSelectedIds(new Set())
    void sendLeadMutation(
      '/leads/bulk-delete',
      {
        method: 'POST',
        body: JSON.stringify({ ids: Array.from(ids) }),
      },
      'Bulk delete failed',
    )
  }

  function addLead() {
    const lead: Lead = {
      id: createId('manual'),
      firstName: 'New',
      lastName: 'contact',
      name: 'New contact',
      company: 'Business name',
      phone: '+1',
      email: '',
      state: 'NC',
      tags: ['manual'],
      score: 70,
      status: 'ready',
      lastCall: 'Never',
      notes: '',
    }

    setLeadsState((current) => [lead, ...current])
    setSelectedIds(new Set([lead.id]))
    setSelectedLeadId(lead.id)
    setNotice('Manual contact added')
    void sendLeadMutation(
      '/leads',
      {
        method: 'POST',
        body: JSON.stringify({ lead }),
      },
      'Manual contact save failed',
    )
  }

  function clearSelectedLeads() {
    setSelectedIds(new Set())
  }

  const setSelectedLeadIds = useCallback((ids: string[]) => {
    setSelectedIds(new Set(ids.filter(Boolean)))
  }, [])

  return {
    addLead,
    bulkDelete,
    bulkStatus,
    clearSelectedLeads,
    createSmartViewFromFilters,
    handleSmartViewCsvUpload,
    leads,
    leadsRef,
    selectedIds,
    selectedLeadId,
    setLeadsState,
    setSelectedLeadId,
    setSelectedLeadIds,
    smartViews,
    toggleAllVisible,
    toggleRow,
    updateLead,
  }
}
