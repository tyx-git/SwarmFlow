/**
 * 右侧边栏：垂直的 Plan / Agents / Git 导航及丰富的面板。
 */

import { useCallback, useEffect, useState } from 'react'
import {
  Check,
  ChevronRight,
  ChevronsDown,
  Circle,
  FileText,
  FolderOpen,
  Layers,
  GitBranch,
  History,
  ChevronsRight,
  ChevronsLeft,
  ExternalLink,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  SquareTerminal,
  Undo2,
  X,
  Zap,
} from 'lucide-react'
import { cn } from '@/lib/cn.js'
import { api } from '@/lib/api.js'
import { useSessionStore } from '@/state/sessionStore.js'
import { shortenSummary } from '@/lib/path.js'
import { compactModelLabel } from '@/lib/modelDisplay.js'
import { DiffView } from '@/components/DiffView.js'
import * as Dialog from '@radix-ui/react-dialog'
import type { AgentModelPinInfo, AgentModelPinsStatus, AgentRuntimeSettings, GitFileChange, GitStatus, ModelDescriptor, ModelTierInfo, ModelTierLevel, ModelTierStatus, SessionStatus, SessionTab, SummarizeTarget, WorkspaceFileEntry, WorkspaceTextSearchResult } from '@shared/rpc.js'
import { iconForExtension } from '@/lib/fileIcon.js'

interface PlanCheckpoint {
  text: string
  status?: string
  state?: string
  done?: boolean
}

interface ChildSnapshot {
  id: string
  numericId: number
  template: string
  lifecycle: string
  phase: string
  outcome: string
  lastTotalTokens: number
  lifetimeToolCallCount: number
  lastToolCallSummary: string
}

interface CompactLogEntry {
  id: string
  type: string
  display?: string
  tuiVisible?: boolean
  discarded?: boolean
  meta?: Record<string, unknown>
  content?: { name?: unknown; toolName?: unknown }
}

interface RewindTarget {
  turnIndex: number
  preview: string
  timestamp: number
  fileCount: number
  additions: number
  deletions: number
  filesReverted: boolean
}

type RightPaneTab = 'plan' | 'agents' | 'context' | 'git' | 'files' | 'search' | 'shells'
type GitDiffMode = 'unified' | 'split'

const RIGHT_PANE_TAB_KEY = 'swarmflow:rightPaneTab'
const RIGHT_PANE_COLLAPSED_KEY = 'swarmflow:rightPaneCollapsed'
const GIT_DIFF_MODE_KEY = 'swarmflow:gitDiffMode'

export function RightPane({ tab }: { tab: SessionTab }): JSX.Element {
  const [collapsed, setCollapsed] = useState(() => readRightPaneCollapsed())
  const [activeTab, setActiveTab] = useState<RightPaneTab>(() => readRightPaneTab())
  const [plan, setPlan] = useState<PlanCheckpoint[]>([])
  const [children, setChildren] = useState<ChildSnapshot[]>([])
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [gitLoading, setGitLoading] = useState(false)
  const [workspaceFiles, setWorkspaceFiles] = useState<readonly WorkspaceFileEntry[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [shellReport, setShellReport] = useState('No shells tracked.')
  const [shellsLoading, setShellsLoading] = useState(false)
  const [rewindTargets, setRewindTargets] = useState<RewindTarget[]>([])
  const [contextLoading, setContextLoading] = useState(false)
  const [contextBusy, setContextBusy] = useState<'summarize' | 'compact' | 'rewind' | null>(null)
  const [pendingRewind, setPendingRewind] = useState<RewindTarget | null>(null)
  const [summarizeOpen, setSummarizeOpen] = useState(false)
  const state = useSessionStore((s) => s.perTab[tab.tabId])
  const refreshLog = useSessionStore((s) => s.refreshLog)
  const refreshMeta = useSessionStore((s) => s.refreshMeta)
  const refreshStatus = useSessionStore((s) => s.refreshStatus)

  useEffect(() => {
    storeRightPaneCollapsed(collapsed)
  }, [collapsed])

  useEffect(() => {
    storeRightPaneTab(activeTab)
  }, [activeTab])

  const refreshContext = useCallback(async (): Promise<void> => {
    setContextLoading(true)
    try {
      const targets = await api.rpc.request<RewindTarget[]>(tab.tabId, 'session.getRewindTargets')
      setRewindTargets(Array.isArray(targets) ? targets : [])
    } catch {
      setRewindTargets([])
    } finally {
      setContextLoading(false)
    }
  }, [tab.tabId])

  const refreshFiles = useCallback(async (): Promise<void> => {
    setFilesLoading(true)
    try {
      setWorkspaceFiles(await api.workspace.listFiles(tab.workDir))
    } catch {
      setWorkspaceFiles([])
    } finally {
      setFilesLoading(false)
    }
  }, [tab.workDir])

  const refreshShells = useCallback(async (): Promise<void> => {
    if (tab.status === 'draft') {
      setShellReport('No shells tracked.')
      return
    }
    setShellsLoading(true)
    try {
      setShellReport(await api.rpc.request<string>(tab.tabId, 'session.getShellReport'))
    } catch {
      setShellReport('No shells tracked.')
    } finally {
      setShellsLoading(false)
    }
  }, [tab.status, tab.tabId])

  useEffect(() => {
    let cancelled = false
    const refresh = async (): Promise<void> => {
      try {
        const [p, c] = await Promise.all([
          api.rpc.request<PlanCheckpoint[] | null>(tab.tabId, 'session.getPlanState'),
          api.rpc.request<ChildSnapshot[]>(tab.tabId, 'session.getChildSnapshots'),
        ])
        if (cancelled) return
        setPlan(Array.isArray(p) ? p : [])
        setChildren(Array.isArray(c) ? c : [])
      } catch { /* */ }
    }
    void refresh()
    const off = api.rpc.onEvent((e) => {
      if (e.tabId !== tab.tabId) return
      if (e.method === 'plan.changed' || e.method === 'log.changed') void refresh()
    })
    return () => { cancelled = true; off() }
  }, [tab.tabId])

  useEffect(() => {
    let cancelled = false
    const refreshGit = async (): Promise<void> => {
      setGitLoading(true)
      try {
        const status = await api.git.status(tab.workDir)
        if (!cancelled) setGitStatus(status)
      } catch (err) {
        if (!cancelled) {
          setGitStatus({
            isRepo: false,
            workDir: tab.workDir,
            root: null,
            branch: null,
            upstream: null,
            ahead: 0,
            behind: 0,
            clean: true,
            files: [],
            error: err instanceof Error ? err.message : String(err),
          })
        }
      } finally {
        if (!cancelled) setGitLoading(false)
      }
    }
    void refreshGit()
    const timer = window.setInterval(() => {
      if (activeTab === 'git') void refreshGit()
    }, 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [activeTab, tab.workDir])

  useEffect(() => {
    if (activeTab !== 'context') return
    void refreshContext()
  }, [activeTab, refreshContext, state?.logRevision])

  useEffect(() => {
    if (activeTab !== 'files') return
    void refreshFiles()
  }, [activeTab, refreshFiles])

  useEffect(() => {
    if (activeTab !== 'shells') return
    void refreshShells()
    const timer = window.setInterval(() => void refreshShells(), 3000)
    return () => window.clearInterval(timer)
  }, [activeTab, refreshShells])

  const runCompactCommand = async (): Promise<void> => {
    if (contextBusy || state?.status?.currentTurnRunning) return
    setContextBusy('compact')
    try {
      await api.rpc.request(tab.tabId, 'session.compact', {})
      await refreshStatus(tab.tabId)
      await refreshContext()
    } finally {
      setContextBusy(null)
    }
  }

  const submitSummarize = async (params: {
    targetContextIds: string[]
    focusPrompt?: string
  }): Promise<void> => {
    if (contextBusy || state?.status?.currentTurnRunning) return
    setContextBusy('summarize')
    try {
      await api.rpc.request(tab.tabId, 'session.summarize', params)
      setSummarizeOpen(false)
      await refreshStatus(tab.tabId)
      await refreshContext()
    } finally {
      setContextBusy(null)
    }
  }

  const confirmRewind = async (): Promise<void> => {
    if (!pendingRewind || contextBusy || state?.status?.currentTurnRunning) return
    const target = pendingRewind
    setContextBusy('rewind')
    try {
      await api.rpc.request(tab.tabId, 'session.rewind', { toTurnIndex: target.turnIndex })
      setPendingRewind(null)
      await Promise.all([
        refreshLog(tab.tabId),
        refreshStatus(tab.tabId),
        refreshMeta(tab.tabId),
        refreshContext(),
      ])
    } finally {
      setContextBusy(null)
    }
  }

  if (collapsed) {
    return (
      <aside data-right-pane-root className="flex w-10 shrink-0 flex-col items-center border-l border-line-soft bg-rail py-2.5">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="grid h-8 w-8 place-items-center rounded text-ink-3 transition hover:bg-line-soft hover:text-ink"
          title="Expand"
        >
          <ChevronsLeft className="h-3.5 w-3.5" />
        </button>
      </aside>
    )
  }

  const planRemaining = plan.filter((c) => normalizeStatus(c) !== 'done').length
  const agentsActive = children.filter((c) => c.lifecycle === 'running').length
  const recentTools = getRecentTools(state)
  const contextBadge = rewindTargets.length
  const gitBadge = gitStatus?.isRepo ? gitStatus.files.length : 0
  const filesBadge = workspaceFiles.length
  const shells = parseShellReport(shellReport)
  const shellBadge = shells.filter((shell) => shell.status === 'running').length

  const tabs = [
    { id: 'plan' as const, label: 'Plan', icon: <Check className="h-3.5 w-3.5" strokeWidth={1.8} />, badge: planRemaining },
    { id: 'agents' as const, label: 'Agents', icon: <Layers className="h-3.5 w-3.5" strokeWidth={1.8} />, badge: agentsActive },
    { id: 'context' as const, label: 'Context', icon: <History className="h-3.5 w-3.5" strokeWidth={1.8} />, badge: contextBadge },
    { id: 'git' as const, label: 'Git', icon: <GitBranch className="h-3.5 w-3.5" strokeWidth={1.8} />, badge: gitBadge },
    { id: 'files' as const, label: 'Files', icon: <FileText className="h-3.5 w-3.5" strokeWidth={1.8} />, badge: filesBadge },
    { id: 'search' as const, label: 'Search', icon: <Search className="h-3.5 w-3.5" strokeWidth={1.8} />, badge: 0 },
    { id: 'shells' as const, label: 'Shells', icon: <SquareTerminal className="h-3.5 w-3.5" strokeWidth={1.8} />, badge: shellBadge },
  ]

  return (
    <aside
      data-right-pane-root
      className={cn(
        'flex shrink-0 border-l border-line-soft bg-rail',
        activeTab === 'git' ? 'w-[560px]' : activeTab === 'files' || activeTab === 'search' || activeTab === 'shells' ? 'w-[380px]' : 'w-[336px]',
      )}
    >
      {/* Vertical panel navigation */}
      <div className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-line-soft py-2.5">
        {tabs.map((t) => {
          const on = t.id === activeTab
          return (
            <button
              type="button"
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              title={t.label}
              aria-label={t.label}
              aria-current={on ? 'page' : undefined}
              className={cn(
                'relative grid h-8 w-8 place-items-center rounded transition',
                on ? 'bg-pane-2 text-ink' : 'text-ink-3 hover:bg-line-soft hover:text-ink',
              )}
            >
              {t.icon}
              {t.badge > 0 && (
                <span
                  className={cn(
                    'mono absolute right-0.5 top-0.5 min-w-[13px] rounded-full px-[3px] text-[9.5px] leading-[13px]',
                    on ? 'bg-line text-ink-2' : 'bg-pane-2 text-ink-3',
                  )}
                >
                  {t.badge}
                </span>
              )}
            </button>
          )
        })}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="grid h-8 w-8 place-items-center rounded text-ink-3 transition hover:bg-line-soft hover:text-ink"
          title="Collapse"
          aria-label="Collapse right pane"
        >
          <ChevronsRight className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Panel content */}
        <div className="session-scroll min-h-0 flex-1 overflow-y-auto">
          {activeTab === 'plan' && <PlanPanel plan={plan} />}
          {activeTab === 'agents' && (
            <AgentsPanel
              agents={children}
              stderrLog={state?.stderrLog ?? []}
              tabId={tab.tabId}
              workDir={tab.workDir}
              models={state?.models ?? []}
              isDraft={tab.status === 'draft'}
            />
          )}
          {activeTab === 'context' && (
            <ContextPanel
              targets={rewindTargets}
              status={state?.status ?? null}
              loading={contextLoading}
              busy={contextBusy}
              currentTurnRunning={state?.status?.currentTurnRunning ?? false}
              pendingRewind={pendingRewind}
              onRefresh={refreshContext}
              onSummarize={() => setSummarizeOpen(true)}
              onCompact={() => void runCompactCommand()}
              onSelectRewind={setPendingRewind}
              onCancelRewind={() => setPendingRewind(null)}
              onConfirmRewind={() => void confirmRewind()}
            />
          )}
          {activeTab === 'git' && (
            <GitPanel
              status={gitStatus}
              loading={gitLoading}
              recentTools={recentTools}
              onRefresh={async () => {
                setGitLoading(true)
                try {
                  setGitStatus(await api.git.status(tab.workDir))
                } finally {
                  setGitLoading(false)
                }
              }}
            />
          )}
          {activeTab === 'files' && (
            <FilesPanel
              files={workspaceFiles}
              loading={filesLoading}
              workDir={tab.workDir}
              onRefresh={refreshFiles}
            />
          )}
          {activeTab === 'search' && <SearchPanel workDir={tab.workDir} />}
          {activeTab === 'shells' && (
            <ShellsPanel
              report={shellReport}
              loading={shellsLoading}
              disabled={tab.status === 'draft'}
              onRefresh={refreshShells}
              onKillAll={async () => {
                await api.rpc.request(tab.tabId, 'session.killAllShells')
                await refreshShells()
              }}
            />
          )}
        </div>
      </div>
      <SummarizeDialog
        tabId={tab.tabId}
        open={summarizeOpen}
        busy={contextBusy === 'summarize'}
        onOpenChange={(open) => {
          if (!open && contextBusy === 'summarize') return
          setSummarizeOpen(open)
        }}
        onSubmit={submitSummarize}
      />
    </aside>
  )
}

/* ── Plan ── */

function PlanPanel({ plan }: { plan: PlanCheckpoint[] }): JSX.Element {
  if (plan.length === 0) {
    return (
      <div className="px-3.5 py-4">
        <div className="text-[14px] font-semibold text-ink-2">Plan</div>
        <div className="mt-1.5 text-[13.5px] leading-[1.55] text-ink-3">
          No checkpoints yet.
        </div>
        <div className="mt-2 text-[12.5px] leading-[1.5] text-ink-4">
          The agent writes <span className="mono">plan.md</span> as it works through a task — its checklist appears here.
        </div>
      </div>
    )
  }

  return (
    <div className="px-3.5 py-4">
      <div className="text-[14px] font-semibold text-ink-2">Checkpoints</div>
      <div className="mt-2 flex flex-col gap-0.5">
        {plan.map((c, i) => {
          const status = normalizeStatus(c)
          return (
            <div key={i} className="flex items-start gap-2.5 py-1.5">
              <div className="pt-0.5 shrink-0">
                {status === 'done' ? (
                  <div className="grid h-3.5 w-3.5 place-items-center rounded-full bg-ink">
                    <Check className="h-[9px] w-[9px] text-pane" strokeWidth={3} />
                  </div>
                ) : status === 'in_progress' ? (
                  <div className="relative h-3.5 w-3.5 rounded-full border-[1.5px] border-ink-2">
                    <div className="absolute inset-[3px] rounded-full bg-ink-2" />
                  </div>
                ) : (
                  <div className="h-3.5 w-3.5 rounded-full border-[1.5px] border-ink-4" />
                )}
              </div>
              <div
                className={cn(
                  'flex-1 text-[14.5px] leading-[1.5]',
                  status === 'done' && 'text-ink-3 line-through decoration-ink-4',
                  status === 'todo' && 'text-ink-3',
                  status === 'in_progress' && 'text-ink',
                )}
              >
                {c.text}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ── Context ── */

function ContextPanel({
  targets,
  status,
  loading,
  busy,
  currentTurnRunning,
  pendingRewind,
  onRefresh,
  onSummarize,
  onCompact,
  onSelectRewind,
  onCancelRewind,
  onConfirmRewind,
}: {
  targets: RewindTarget[]
  status: SessionStatus | null
  loading: boolean
  busy: 'summarize' | 'compact' | 'rewind' | null
  currentTurnRunning: boolean
  pendingRewind: RewindTarget | null
  onRefresh: () => void | Promise<void>
  onSummarize: () => void
  onCompact: () => void
  onSelectRewind: (target: RewindTarget) => void
  onCancelRewind: () => void
  onConfirmRewind: () => void
}): JSX.Element {
  const disabled = currentTurnRunning || busy !== null

  return (
    <div className="space-y-5 px-3.5 py-4">
      <div>
        <PanelHeader title="Context" loading={loading} onRefresh={onRefresh} />
        <ContextUsageCard status={status} />
        <div className="mt-2 flex flex-col gap-1.5">
          <ContextActionButton
            title="Summarize older context"
            description="Distill selected context into a shorter memory."
            icon={<Sparkles className="h-3.5 w-3.5" strokeWidth={1.8} />}
            disabled={disabled}
            active={busy === 'summarize'}
            onClick={onSummarize}
          />
          <ContextActionButton
            title="Compact prompt"
            description="Rewrite the continuation prompt for this session."
            icon={<Zap className="h-3.5 w-3.5" strokeWidth={1.8} />}
            disabled={disabled}
            active={busy === 'compact'}
            onClick={onCompact}
          />
        </div>
        {currentTurnRunning && (
          <div className="mt-2 px-0.5 text-[13px] text-ink-3">
            Context actions are available after the current turn finishes.
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-baseline gap-2 px-0.5">
          <div className="text-[13px] font-semibold text-ink-2">Rewind</div>
          <div className="text-[12.5px] text-ink-4">{targets.length}</div>
        </div>

        {pendingRewind && (
          <div className="mb-3 rounded-lg border border-warning/30 bg-warning/5 px-3 py-3">
            <div className="flex items-start gap-2">
              <Undo2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" strokeWidth={1.8} />
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium text-ink">
                  Rewind to turn {pendingRewind.turnIndex}
                </div>
                <div className="mt-1 line-clamp-2 text-[13px] leading-[1.4] text-ink-3">
                  {pendingRewind.preview}
                </div>
                <div className="mono mt-1 text-[12px] text-ink-4">
                  {formatRewindHint(pendingRewind)}
                </div>
              </div>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={onCancelRewind}
                disabled={busy === 'rewind'}
                className="rounded px-2.5 py-1.5 text-[13px] font-medium text-ink-3 transition hover:bg-line-soft hover:text-ink disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirmRewind}
                disabled={disabled}
                className="rounded bg-warning px-2.5 py-1.5 text-[13px] font-medium text-pane transition hover:opacity-90 disabled:opacity-50"
              >
                {busy === 'rewind' ? 'Rewinding' : 'Confirm rewind'}
              </button>
            </div>
          </div>
        )}

        {targets.length === 0 ? (
          <div className="px-0.5 py-3 text-[14px] text-ink-3">
            {loading ? 'Loading rewind points…' : 'No rewind points available.'}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {targets.slice(0, 12).map((target) => (
              <button
                type="button"
                key={`${target.turnIndex}-${target.timestamp}`}
                onClick={() => onSelectRewind(target)}
                disabled={disabled}
                className={cn(
                  'rounded-lg px-2.5 py-2 text-left transition hover:bg-pane-2 disabled:cursor-default disabled:opacity-60',
                  pendingRewind?.turnIndex === target.turnIndex && 'bg-pane-2',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="mono grid h-5 min-w-5 place-items-center rounded-md bg-line-soft px-1.5 text-[11.5px] font-semibold text-ink-2">
                    {target.turnIndex}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink-2">
                    {target.preview || 'Untitled turn'}
                  </span>
                </div>
                <div className="mono mt-1 truncate pl-7 text-[12px] text-ink-4">
                  {formatRewindHint(target)}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ContextActionButton({
  title,
  description,
  icon,
  disabled,
  active,
  onClick,
}: {
  title: string
  description: string
  icon: React.ReactNode
  disabled: boolean
  active: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex items-start gap-3 rounded px-3 py-2.5 text-left transition',
        'hover:bg-line-soft disabled:cursor-default disabled:opacity-55',
        active && 'bg-line-soft',
      )}
    >
      <span className="mt-0.5 shrink-0 text-ink-3">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-medium text-ink">{title}</div>
        <div className="mt-0.5 text-[12.5px] leading-[1.35] text-ink-3">
          {description}
        </div>
      </div>
    </button>
  )
}

function SummarizeDialog({
  tabId,
  open,
  busy,
  onOpenChange,
  onSubmit,
}: {
  tabId: string
  open: boolean
  busy: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (params: { targetContextIds: string[]; focusPrompt?: string }) => Promise<void>
}): JSX.Element {
  const [targets, setTargets] = useState<readonly SummarizeTarget[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [fromIdx, setFromIdx] = useState<number | null>(null)
  const [toIdx, setToIdx] = useState<number | null>(null)
  const [focus, setFocus] = useState('')
  const [computing, setComputing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setError(null)
    setFromIdx(null)
    setToIdx(null)
    setFocus('')
    void api.rpc.request<SummarizeTarget[]>(tabId, 'session.getSummarizeTargets')
      .then((items) => {
        if (cancelled) return
        const arr = Array.isArray(items) ? items : []
        setTargets(arr)
        if (arr.length > 0) {
          setFromIdx(0)
          setToIdx(Math.max(0, arr.length - 2))
        }
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, tabId])

  const handleRowClick = (idx: number): void => {
    if (busy || computing) return
    if (fromIdx === null || toIdx === null) {
      setFromIdx(idx)
      setToIdx(idx)
      return
    }
    if (fromIdx === toIdx) {
      if (idx === fromIdx) return
      if (idx > fromIdx) setToIdx(idx)
      else setFromIdx(idx)
      return
    }
    // Range exists — restart with this row as anchor
    setFromIdx(idx)
    setToIdx(idx)
  }

  const rangeCount = fromIdx !== null && toIdx !== null ? toIdx - fromIdx + 1 : 0
  const canSubmit = !busy && !computing && !loading && fromIdx !== null && toIdx !== null && targets.length > 0

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit || fromIdx === null || toIdx === null) return
    setComputing(true)
    setError(null)
    try {
      const selected = targets.slice(fromIdx, toIdx + 1)
      const contextIds: string[] = []
      const seen = new Set<string>()
      for (const t of selected) {
        if (t.kind === 'turn') {
          const ids = await api.rpc.request<string[]>(tabId, 'session.getContextIdsForTurnRange', {
            startTurn: t.turnIndex,
            endTurn: t.turnIndex,
          })
          for (const id of ids ?? []) {
            if (!seen.has(id)) {
              contextIds.push(id)
              seen.add(id)
            }
          }
        } else if (t.kind === 'summary' && t.contextId && !seen.has(t.contextId)) {
          contextIds.push(t.contextId)
          seen.add(t.contextId)
        }
      }
      if (contextIds.length === 0) {
        setError('No context groups found in the selected range.')
        return
      }
      const focusPrompt = focus.trim() || undefined
      await onSubmit({ targetContextIds: contextIds, focusPrompt })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setComputing(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/35 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[580px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-line bg-pane-2 shadow-2xl">
          <div className="flex h-16 items-center gap-3 border-b border-line-soft px-5">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent">
              <Sparkles className="h-4 w-4" strokeWidth={1.9} />
            </div>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="truncate text-[17px] font-semibold leading-tight text-ink">
                Summarize context
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 truncate text-[12.5px] leading-tight text-ink-4">
                Pick the turn range to distill. Click to set start, click again to extend.
              </Dialog.Description>
            </div>
          </div>

          <div className="min-h-[180px] flex-1 overflow-y-auto border-b border-line-soft bg-pane">
            {loading ? (
              <div className="flex h-full min-h-[180px] items-center justify-center text-[13px] text-ink-3">
                Loading turns…
              </div>
            ) : loadError ? (
              <div className="px-5 py-4 text-[13px] text-error">{loadError}</div>
            ) : targets.length === 0 ? (
              <div className="px-5 py-6 text-center text-[13px] text-ink-3">
                No turns available to summarize.
              </div>
            ) : (
              <ul className="flex flex-col py-1.5">
                {targets.map((t, idx) => {
                  const inRange = fromIdx !== null && toIdx !== null && idx >= fromIdx && idx <= toIdx
                  const isFrom = idx === fromIdx
                  const isTo = idx === toIdx
                  const isEdge = isFrom || isTo
                  return (
                    <li key={`${t.kind}-${t.turnIndex}-${t.contextId ?? idx}`}>
                      <button
                        type="button"
                        onClick={() => handleRowClick(idx)}
                        disabled={busy || computing}
                        className={cn(
                          'flex w-full items-center gap-2.5 px-5 py-2 text-left transition',
                          'hover:bg-line-soft disabled:cursor-default',
                          inRange && !isEdge && 'bg-accent/10',
                          isEdge && 'bg-accent/20',
                        )}
                      >
                        <span
                          className={cn(
                            'mono grid h-5 w-12 shrink-0 place-items-center rounded-md text-[11px] font-semibold',
                            t.kind === 'summary'
                              ? 'bg-accent/20 text-accent'
                              : 'bg-line-soft text-ink-2',
                          )}
                        >
                          {t.kind === 'summary' ? 'SUMRY' : `T${t.turnIndex}`}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">
                          {t.preview || (t.kind === 'summary' ? '(summary)' : 'Untitled turn')}
                        </span>
                        {isFrom && (
                          <span className="mono shrink-0 rounded bg-accent/30 px-1.5 py-0.5 text-[10.5px] font-semibold text-accent">
                            FROM
                          </span>
                        )}
                        {isTo && !isFrom && (
                          <span className="mono shrink-0 rounded bg-accent/30 px-1.5 py-0.5 text-[10.5px] font-semibold text-accent">
                            TO
                          </span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <div className="px-5 py-3">
            <label className="block text-[12px] font-medium uppercase tracking-wider text-ink-4">
              Focus prompt (optional)
            </label>
            <textarea
              value={focus}
              onChange={(event) => setFocus(event.target.value)}
              rows={2}
              placeholder="What to emphasize when summarizing — e.g. preserve all file paths"
              disabled={busy || computing}
              className="mt-1.5 w-full resize-none rounded-lg border border-line-soft bg-pane px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-4 focus:border-line"
            />
            {error && <div className="mt-2 text-[12.5px] text-error">{error}</div>}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-line-soft px-5 py-3">
            <div className="text-[12.5px] text-ink-4">
              {rangeCount > 0
                ? `${rangeCount} turn${rangeCount === 1 ? '' : 's'} selected`
                : 'Select a range above'}
            </div>
            <div className="flex gap-2">
              <Dialog.Close asChild>
                <button
                  type="button"
                  disabled={busy || computing}
                  className="rounded-lg px-3 py-1.5 text-[13.5px] font-medium text-ink-3 transition hover:bg-line-soft hover:text-ink disabled:opacity-45"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={!canSubmit}
                className="rounded-lg bg-ink px-3 py-1.5 text-[13.5px] font-medium text-pane transition hover:opacity-90 disabled:opacity-40"
              >
                {busy ? 'Summarizing…' : computing ? 'Preparing…' : 'Summarize'}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ContextUsageCard({ status }: { status: SessionStatus | null }): JSX.Element {
  const used = status?.lastInputTokens ?? 0
  const budget = status?.contextBudget ?? 0
  const remaining = Math.max(0, budget - used)
  const pct = budget > 0 ? Math.min(100, Math.max(0, (used / budget) * 100)) : 0
  const tone = pct >= 85 ? 'danger' : pct >= 65 ? 'warning' : 'normal'

  return (
    <div className="mt-2 px-0.5 py-1.5">
      <div className="mb-2 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium text-ink">Context usage</div>
          <div className="mono mt-0.5 text-[12px] text-ink-4">
            {budget > 0
              ? `${formatTokens(used)} / ${formatTokens(budget)}`
              : 'Waiting for model context'}
          </div>
        </div>
        {budget > 0 && (
          <span
            className={cn(
              'mono rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold',
              tone === 'danger' && 'bg-error/10 text-error',
              tone === 'warning' && 'bg-warning/10 text-warning',
              tone === 'normal' && 'bg-line-soft text-ink-3',
            )}
          >
            {Math.round(pct)}%
          </span>
        )}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-line-soft">
        <div
          className={cn(
            'h-full rounded-full transition-[width]',
            tone === 'danger' && 'bg-error',
            tone === 'warning' && 'bg-warning',
            tone === 'normal' && 'bg-ink-3',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      {budget > 0 && (
        <div className="mt-2 flex items-center justify-between gap-2 text-[12.5px] text-ink-3">
          <span>{formatTokens(remaining)} remaining</span>
          {status?.lastCacheReadTokens ? (
            <span className="mono text-ink-4">{formatTokens(status.lastCacheReadTokens)} cached</span>
          ) : null}
        </div>
      )}
    </div>
  )
}

/* ── Agents ── */

function AgentsPanel({
  agents,
  stderrLog,
  tabId,
  workDir,
  models,
  isDraft,
}: {
  agents: ChildSnapshot[]
  stderrLog: readonly string[]
  tabId: string
  workDir: string
  models: readonly ModelDescriptor[]
  isDraft: boolean
}): JSX.Element {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [childLog, setChildLog] = useState<CompactLogEntry[] | null>(null)
  const [childLogLoading, setChildLogLoading] = useState(false)
  const [modelTiers, setModelTiers] = useState<readonly ModelTierInfo[]>([])
  const [modelTiersLoading, setModelTiersLoading] = useState(false)
  const [modelTierBusy, setModelTierBusy] = useState<ModelTierLevel | null>(null)
  const [agentRuntime, setAgentRuntime] = useState<AgentRuntimeSettings | null>(null)
  const [agentRuntimeBusy, setAgentRuntimeBusy] = useState<'mcp' | 'hooks' | null>(null)
  const [agentModelPins, setAgentModelPins] = useState<readonly AgentModelPinInfo[]>([])
  const [agentModelPinsLoading, setAgentModelPinsLoading] = useState(false)
  const [agentModelPinBusy, setAgentModelPinBusy] = useState<string | null>(null)
  const selectedAgent = selectedAgentId
    ? agents.find((agent) => agent.id === selectedAgentId) ?? null
    : null

  const refreshModelTiers = useCallback(async (): Promise<void> => {
    if (isDraft) {
      setModelTiers([])
      return
    }
    setModelTiersLoading(true)
    try {
      const status = await api.rpc.request<ModelTierStatus>(tabId, 'session.getModelTiers')
      setModelTiers(Array.isArray(status.tiers) ? status.tiers : [])
    } catch {
      setModelTiers([])
    } finally {
      setModelTiersLoading(false)
    }
  }, [isDraft, tabId])

  useEffect(() => {
    void refreshModelTiers()
  }, [refreshModelTiers])

  const updateModelTier = useCallback(async (
    level: ModelTierLevel,
    modelName: string | null,
    thinkingLevel?: string,
  ): Promise<void> => {
    if (isDraft) return
    setModelTierBusy(level)
    try {
      const status = await api.rpc.request<ModelTierStatus>(tabId, 'session.setModelTier', {
        level,
        modelName,
        thinkingLevel,
      })
      setModelTiers(Array.isArray(status.tiers) ? status.tiers : [])
    } finally {
      setModelTierBusy(null)
    }
  }, [isDraft, tabId])

  const refreshAgentRuntime = useCallback(async (): Promise<void> => {
    if (isDraft) {
      setAgentRuntime(null)
      return
    }
    try {
      setAgentRuntime(await api.rpc.request<AgentRuntimeSettings>(tabId, 'session.getAgentRuntimeSettings'))
    } catch {
      setAgentRuntime(null)
    }
  }, [isDraft, tabId])

  useEffect(() => {
    void refreshAgentRuntime()
  }, [refreshAgentRuntime])

  const updateAgentRuntime = useCallback(async (patch: Partial<AgentRuntimeSettings>): Promise<void> => {
    if (isDraft || agentRuntimeBusy) return
    const busyKey = patch.subAgentInheritMcp !== undefined ? 'mcp' : 'hooks'
    setAgentRuntimeBusy(busyKey)
    try {
      const next = await api.rpc.request<AgentRuntimeSettings>(
        tabId,
        'session.setAgentRuntimeSettings',
        patch,
      )
      setAgentRuntime(next)
    } finally {
      setAgentRuntimeBusy(null)
    }
  }, [agentRuntimeBusy, isDraft, tabId])

  const refreshAgentModelPins = useCallback(async (): Promise<void> => {
    if (isDraft) {
      setAgentModelPins([])
      return
    }
    setAgentModelPinsLoading(true)
    try {
      const status = await api.rpc.request<AgentModelPinsStatus>(tabId, 'session.getAgentModelPins')
      setAgentModelPins(Array.isArray(status.templates) ? status.templates : [])
    } catch {
      setAgentModelPins([])
    } finally {
      setAgentModelPinsLoading(false)
    }
  }, [isDraft, tabId])

  useEffect(() => {
    void refreshAgentModelPins()
  }, [refreshAgentModelPins])

  const updateAgentModelPin = useCallback(async (
    templateName: string,
    modelName: string | null,
    thinkingLevel?: string,
  ): Promise<void> => {
    if (isDraft || agentModelPinBusy) return
    setAgentModelPinBusy(templateName)
    try {
      const status = await api.rpc.request<AgentModelPinsStatus>(tabId, 'session.setAgentModelPin', {
        templateName,
        modelName,
        thinkingLevel,
      })
      setAgentModelPins(Array.isArray(status.templates) ? status.templates : [])
      void refreshAgentRuntime()
    } finally {
      setAgentModelPinBusy(null)
    }
  }, [agentModelPinBusy, isDraft, refreshAgentRuntime, tabId])

  useEffect(() => {
    if (!selectedAgentId) {
      setChildLog(null)
      return
    }
    if (!agents.some((agent) => agent.id === selectedAgentId)) {
      setSelectedAgentId(null)
      setChildLog(null)
      return
    }

    let cancelled = false
    const refresh = async (): Promise<void> => {
      setChildLogLoading(true)
      try {
        const entries = await api.rpc.request<CompactLogEntry[] | null>(
          tabId,
          'session.getChildLog',
          { childId: selectedAgentId },
        )
        if (!cancelled) setChildLog(Array.isArray(entries) ? entries : [])
      } finally {
        if (!cancelled) setChildLogLoading(false)
      }
    }
    void refresh()
    return () => { cancelled = true }
  }, [agents, selectedAgentId, tabId])

  return (
    <div className="space-y-4 px-3.5 py-4">
      <ModelTiersPanel
        tiers={modelTiers}
        models={models}
        loading={modelTiersLoading}
        busyLevel={modelTierBusy}
        disabled={isDraft}
        onRefresh={refreshModelTiers}
        onUpdate={updateModelTier}
      />

      <AgentInheritancePanel
        settings={agentRuntime}
        disabled={isDraft}
        busy={agentRuntimeBusy}
        onRefresh={refreshAgentRuntime}
        onUpdate={updateAgentRuntime}
      />

      <AgentModelPinsPanel
        templates={agentModelPins}
        models={models}
        loading={agentModelPinsLoading}
        busyTemplate={agentModelPinBusy}
        disabled={isDraft}
        onRefresh={refreshAgentModelPins}
        onUpdate={updateAgentModelPin}
      />

      <div>
        <div className="mb-2 px-0.5 text-[13px] font-semibold text-ink-2">
          Sub-agents
        </div>
        {agents.length === 0 ? (
          <div className="rounded-lg border border-line-soft px-3 py-3">
            <div className="text-[13.5px] text-ink-3">No sub-agents in this session.</div>
            <div className="mt-1 text-[12.5px] leading-[1.5] text-ink-4">
              The agent can <span className="mono">spawn</span> specialists for sub-tasks — they appear here while they run.
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {agents.map((a) => {
              const statusColor =
                a.lifecycle === 'running' ? 'var(--color-ink-2)' :
                a.outcome === 'completed' ? 'var(--color-success)' :
                'var(--color-ink-4)'
              const statusLabel = agentStatusLabel(a)
              const summary = agentSummary(a, workDir)
              return (
                <button
                  key={a.id}
                  type="button"
                  aria-label={`Agent #${a.numericId} ${a.template}`}
                  title={`Agent #${a.numericId} ${a.template}`}
                  onClick={() => setSelectedAgentId(selectedAgentId === a.id ? null : a.id)}
                  className={cn(
                    'w-full rounded-lg border px-3 py-2.5 text-left transition',
                    selectedAgentId === a.id
                      ? 'border-line bg-pane'
                      : 'border-line-soft bg-pane-2 hover:border-line hover:bg-pane',
                  )}
                >
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="mono rounded-md bg-line-soft px-[7px] py-0.5 text-[11.5px] font-medium text-ink-2">
                      {a.template}
                    </span>
                    <span className="mono flex-1 text-[14px] text-ink">#{a.numericId}</span>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: statusColor }} />
                    <ChevronRight
                      className={cn(
                        'h-3 w-3 text-ink-4 transition-transform',
                        selectedAgentId === a.id && 'rotate-90',
                      )}
                      strokeWidth={2}
                    />
                  </div>
                  {summary && (
                    <div className="truncate text-[13.5px] leading-[1.45] text-ink-2">
                      {summary}
                    </div>
                  )}
                  <div className="mt-1.5 flex justify-between text-[13px]">
                    <span className="text-ink-3">{statusLabel}</span>
                    <span className="mono text-ink-3">
                      {a.lifetimeToolCallCount} tools · {formatTokens(a.lastTotalTokens)}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {selectedAgent && (
        <ChildLogPanel
          agent={selectedAgent}
          entries={childLog}
          loading={childLogLoading}
          workDir={workDir}
          onClose={() => setSelectedAgentId(null)}
        />
      )}

      {stderrLog.length > 0 && (
        <div>
          <div className="mb-2 px-0.5 text-[13px] font-semibold text-ink-2">
            Diagnostics
          </div>
          <div className="space-y-1">
            {stderrLog.slice(-6).map((line, index) => (
              <div
                key={`${index}-${line}`}
                className="rounded-lg border border-error/20 bg-error/5 px-3 py-2"
              >
                <div className="mono max-h-[4.35em] overflow-hidden whitespace-pre-wrap text-[12.5px] leading-[1.45] text-error">
                  {shortenSummary(line, workDir)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function agentStatusLabel(agent: ChildSnapshot): string {
  if (agent.lifecycle === 'running') return agent.phase === 'idle' ? 'running' : agent.phase
  if (agent.lifecycle === 'blocked') return 'waiting'
  if (agent.lifecycle === 'archived') {
    if (agent.outcome === 'completed') return 'completed'
    if (agent.outcome && agent.outcome !== 'none') return agent.outcome
    return 'archived'
  }
  if (agent.outcome && agent.outcome !== 'none') return agent.outcome
  return agent.lifecycle
}

function agentSummary(agent: ChildSnapshot, workDir: string): string {
  if (agent.lifecycle === 'running' || agent.lifecycle === 'blocked') {
    return agent.lastToolCallSummary
      ? shortenSummary(agent.lastToolCallSummary, workDir)
      : agentStatusLabel(agent)
  }
  if (agent.outcome === 'completed') return 'Completed'
  if (agent.outcome && agent.outcome !== 'none') return `Ended: ${agent.outcome}`
  return agent.lastToolCallSummary ? shortenSummary(stripRunningPrefix(agent.lastToolCallSummary), workDir) : ''
}

function stripRunningPrefix(summary: string): string {
  return summary.replace(/\s+is running:\s+/i, ': ')
}

const MODEL_TIER_LEVELS: ModelTierLevel[] = ['high', 'medium', 'low']

function ModelTiersPanel({
  tiers,
  models,
  loading,
  busyLevel,
  disabled,
  onRefresh,
  onUpdate,
}: {
  tiers: readonly ModelTierInfo[]
  models: readonly ModelDescriptor[]
  loading: boolean
  busyLevel: ModelTierLevel | null
  disabled: boolean
  onRefresh: () => void | Promise<void>
  onUpdate: (level: ModelTierLevel, modelName: string | null, thinkingLevel?: string) => void | Promise<void>
}): JSX.Element {
  return (
    <div>
      <PanelHeader title="Model tiers" loading={loading} onRefresh={onRefresh} />
      <div className="mt-2">
        {MODEL_TIER_LEVELS.map((level, index) => {
          const tier = tiers.find((item) => item.level === level) ?? emptyTier(level)
          const modelName = getTierModelName(tier, models)
          const model = modelName ? models.find((item) => item.name === modelName) : undefined
          const hasConfiguredModel = Boolean(tier.provider && tier.modelId)
          const modelSelectValue = modelName ?? (hasConfiguredModel ? '__configured' : '')
          const modelDisplayLabel = model
            ? compactModelLabel(model.name, model.model)
            : hasConfiguredModel
              ? tier.label
              : 'Inherits main model'
          const thinkingLevels = model ? getTierThinkingLevels(model) : tier.thinkingLevel ? [tier.thinkingLevel] : ['none']
          const thinkingLevel = tier.thinkingLevel ?? (model ? defaultTierThinkingLevel(model) : 'none')
          const busy = busyLevel === level

          return (
            <div
              key={level}
              className={cn(
                'px-3 py-2.5',
                index > 0 && 'border-t border-line-soft',
              )}
            >
              <div className="mb-2 flex items-baseline gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium capitalize text-ink">{level}</div>
                  <div className="truncate text-[12px] text-ink-4">
                    {modelDisplayLabel}
                  </div>
                </div>
                <span className="mono text-[11.5px] text-ink-4">
                  {busy ? 'saving' : tier.thinkingLevel ?? 'inherit'}
                </span>
              </div>

              <div className="grid grid-cols-[minmax(0,1fr)_86px] gap-1.5">
                <select
                  value={modelSelectValue}
                  disabled={disabled || loading || busy}
                  onChange={(event) => {
                    const nextName = event.target.value
                    if (nextName === '__configured') return
                    if (!nextName) {
                      void onUpdate(level, null)
                      return
                    }
                    const nextModel = models.find((item) => item.name === nextName)
                    void onUpdate(level, nextName, nextModel ? defaultTierThinkingLevel(nextModel) : undefined)
                  }}
                  className="h-8 min-w-0 rounded-lg border border-line-soft bg-pane px-2 text-[12.5px] text-ink outline-none transition hover:border-line disabled:cursor-default disabled:opacity-55"
                  aria-label={`Model for ${level} tier`}
                >
                  <option value="">Inherit</option>
                  {hasConfiguredModel && !modelName && (
                    <option value="__configured">Configured</option>
                  )}
                  {models.map((item) => (
                    <option key={item.name} value={item.name}>
                      {compactModelLabel(item.name, item.model) || item.name}
                    </option>
                  ))}
                </select>

                <select
                  value={thinkingLevel}
                  disabled={disabled || loading || busy || !modelName || thinkingLevels.length <= 1}
                  onChange={(event) => {
                    if (!modelName) return
                    void onUpdate(level, modelName, event.target.value)
                  }}
                  className="h-8 min-w-0 rounded-lg border border-line-soft bg-pane px-2 text-[12.5px] text-ink outline-none transition hover:border-line disabled:cursor-default disabled:opacity-55"
                  aria-label={`Thinking level for ${level} tier`}
                >
                  {thinkingLevels.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </div>
            </div>
          )
        })}
      </div>
      {disabled && (
        <div className="mt-2 px-0.5 py-2 text-[13px] text-ink-3">
          Model tiers are available after the first message creates a session.
        </div>
      )}
    </div>
  )
}

function emptyTier(level: ModelTierLevel): ModelTierInfo {
  return {
    level,
    provider: null,
    selectionKey: null,
    modelId: null,
    thinkingLevel: null,
    configName: null,
    label: 'Inherits main model',
  }
}

function getTierModelName(tier: ModelTierInfo, models: readonly ModelDescriptor[]): string | null {
  if (tier.configName && models.some((model) => model.name === tier.configName)) return tier.configName
  if (!tier.provider || !tier.modelId) return null
  const match = models.find((model) => model.provider === tier.provider && model.model === tier.modelId)
  return match?.name ?? null
}

function getTierThinkingLevels(model: ModelDescriptor): readonly string[] {
  const levels = model.tierThinkingLevels ?? []
  return levels.length > 0 ? levels : ['none']
}

function defaultTierThinkingLevel(model: ModelDescriptor): string {
  const levels = getTierThinkingLevels(model)
  return levels[levels.length - 1] ?? 'none'
}

function AgentInheritancePanel({
  settings,
  disabled,
  busy,
  onRefresh,
  onUpdate,
}: {
  settings: AgentRuntimeSettings | null
  disabled: boolean
  busy: 'mcp' | 'hooks' | null
  onRefresh: () => void | Promise<void>
  onUpdate: (patch: Partial<AgentRuntimeSettings>) => void | Promise<void>
}): JSX.Element {
  const mcpEnabled = settings?.subAgentInheritMcp ?? true
  const hooksEnabled = settings?.subAgentInheritHooks ?? true

  return (
    <div>
      <div className="mb-2 flex items-center gap-2 px-0.5">
        <div className="text-[13px] font-semibold text-ink-2">Inheritance</div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void onRefresh()}
          disabled={disabled}
          className="grid h-7 w-7 place-items-center rounded text-ink-3 transition hover:bg-line-soft hover:text-ink disabled:cursor-default disabled:opacity-45"
          title="Refresh inheritance"
          aria-label="Refresh inheritance"
        >
          <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.8} />
        </button>
      </div>
      <div>
        <div className="py-2.5">
          <InheritanceToggle
            label="MCP tools"
            description="Child agents can use inherited MCP tool definitions."
            enabled={mcpEnabled}
            disabled={disabled || busy !== null}
            busy={busy === 'mcp'}
            onToggle={() => void onUpdate({ subAgentInheritMcp: !mcpEnabled })}
          />
        </div>
        <div className="border-t border-line-soft py-2.5">
          <InheritanceToggle
            label="Hooks"
            description="Child sessions receive the parent hook runtime."
            enabled={hooksEnabled}
            disabled={disabled || busy !== null}
            busy={busy === 'hooks'}
            onToggle={() => void onUpdate({ subAgentInheritHooks: !hooksEnabled })}
          />
        </div>
        {settings && settings.agentModelPins > 0 && (
          <div className="mono mt-1 px-0.5 text-[11.5px] text-ink-4">
            {settings.agentModelPins} template model pin{settings.agentModelPins === 1 ? '' : 's'} configured
          </div>
        )}
      </div>
    </div>
  )
}

function InheritanceToggle({
  label,
  description,
  enabled,
  disabled,
  busy,
  onToggle,
}: {
  label: string
  description: string
  enabled: boolean
  disabled: boolean
  busy: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium text-ink">{label}</div>
        <div className="mt-0.5 text-[12.5px] leading-[1.35] text-ink-3">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        disabled={disabled}
        onClick={onToggle}
        className={cn(
          'relative h-6 w-10 shrink-0 rounded-full border transition disabled:cursor-default disabled:opacity-55',
          enabled ? 'border-success/30 bg-success/20' : 'border-line bg-pane',
        )}
        title={`${enabled ? 'Disable' : 'Enable'} ${label}`}
        aria-label={`${enabled ? 'Disable' : 'Enable'} ${label}`}
      >
        <span
          className={cn(
            'absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full transition',
            enabled ? 'left-[19px] bg-success' : 'left-1 bg-ink-4',
            busy && 'animate-pulse',
          )}
        />
      </button>
    </div>
  )
}

function AgentModelPinsPanel({
  templates,
  models,
  loading,
  busyTemplate,
  disabled,
  onRefresh,
  onUpdate,
}: {
  templates: readonly AgentModelPinInfo[]
  models: readonly ModelDescriptor[]
  loading: boolean
  busyTemplate: string | null
  disabled: boolean
  onRefresh: () => void | Promise<void>
  onUpdate: (templateName: string, modelName: string | null, thinkingLevel?: string) => void | Promise<void>
}): JSX.Element {
  const visibleTemplates = templates.slice(0, 8)
  return (
    <div>
      <PanelHeader title="Template pins" loading={loading} onRefresh={onRefresh} />
      <div className="mt-2">
        {visibleTemplates.length === 0 ? (
          <div className="px-3 py-3 text-[13.5px] text-ink-3">
            {loading ? 'Loading templates…' : 'No agent templates loaded.'}
          </div>
        ) : (
          visibleTemplates.map((template, index) => (
            <AgentModelPinRow
              key={template.name}
              template={template}
              models={models}
              busy={busyTemplate === template.name}
              disabled={disabled || loading || busyTemplate !== null}
              onUpdate={onUpdate}
              divider={index > 0}
            />
          ))
        )}
      </div>
      {templates.length > visibleTemplates.length && (
        <div className="mono mt-2 px-0.5 text-[11.5px] text-ink-4">
          Showing {visibleTemplates.length} of {templates.length} templates
        </div>
      )}
    </div>
  )
}

function AgentModelPinRow({
  template,
  models,
  busy,
  disabled,
  divider,
  onUpdate,
}: {
  template: AgentModelPinInfo
  models: readonly ModelDescriptor[]
  busy: boolean
  disabled: boolean
  divider: boolean
  onUpdate: (templateName: string, modelName: string | null, thinkingLevel?: string) => void | Promise<void>
}): JSX.Element {
  const modelName = getPinModelName(template, models)
  const model = modelName ? models.find((item) => item.name === modelName) : undefined
  const hasConfiguredModel = Boolean(template.provider && template.modelId)
  const modelSelectValue = modelName ?? (hasConfiguredModel ? '__configured' : '')
  const modelDisplayLabel = model
    ? compactModelLabel(model.name, model.model)
    : hasConfiguredModel
      ? template.label
      : 'Uses tier or main model'
  const thinkingLevels = model ? getTierThinkingLevels(model) : template.thinkingLevel ? [template.thinkingLevel] : ['none']
  const thinkingLevel = template.thinkingLevel ?? (model ? defaultTierThinkingLevel(model) : 'none')

  return (
    <div className={cn('px-3 py-2.5', divider && 'border-t border-line-soft')}>
      <div className="mb-2 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium text-ink">{template.name}</div>
          <div className="truncate text-[12px] text-ink-4">{modelDisplayLabel}</div>
        </div>
        <span className="mono text-[11.5px] text-ink-4">
          {busy ? 'saving' : template.thinkingLevel ?? 'auto'}
        </span>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_86px] gap-1.5">
        <select
          value={modelSelectValue}
          disabled={disabled}
          onChange={(event) => {
            const nextName = event.target.value
            if (nextName === '__configured') return
            if (!nextName) {
              void onUpdate(template.name, null)
              return
            }
            const nextModel = models.find((item) => item.name === nextName)
            void onUpdate(template.name, nextName, nextModel ? defaultTierThinkingLevel(nextModel) : undefined)
          }}
          className="h-8 min-w-0 rounded-lg border border-line-soft bg-pane px-2 text-[12.5px] text-ink outline-none transition hover:border-line disabled:cursor-default disabled:opacity-55"
          aria-label={`Model pin for ${template.name}`}
        >
          <option value="">Inherit</option>
          {hasConfiguredModel && !modelName && (
            <option value="__configured">Configured</option>
          )}
          {models.map((item) => (
            <option key={item.name} value={item.name}>
              {compactModelLabel(item.name, item.model) || item.name}
            </option>
          ))}
        </select>

        <select
          value={thinkingLevel}
          disabled={disabled || !modelName || thinkingLevels.length <= 1}
          onChange={(event) => {
            if (!modelName) return
            void onUpdate(template.name, modelName, event.target.value)
          }}
          className="h-8 min-w-0 rounded-lg border border-line-soft bg-pane px-2 text-[12.5px] text-ink outline-none transition hover:border-line disabled:cursor-default disabled:opacity-55"
          aria-label={`Thinking level pin for ${template.name}`}
        >
          {thinkingLevels.map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
      </div>
    </div>
  )
}

function getPinModelName(template: AgentModelPinInfo, models: readonly ModelDescriptor[]): string | null {
  if (template.configName && models.some((model) => model.name === template.configName)) {
    return template.configName
  }
  if (!template.provider || !template.modelId) return null
  const match = models.find((model) => model.provider === template.provider && model.model === template.modelId)
  return match?.name ?? null
}

function ChildLogPanel({
  agent,
  entries,
  loading,
  workDir,
  onClose,
}: {
  agent: ChildSnapshot
  entries: CompactLogEntry[] | null
  loading: boolean
  workDir: string
  onClose: () => void
}): JSX.Element {
  const visibleEntries = (entries ?? [])
    .filter((entry) => !entry.discarded && entry.tuiVisible !== false)
    .filter((entry) => shouldShowCompactLogEntry(entry))
    .slice(-36)

  return (
    <div className="mt-3 border-t border-line-soft pt-3">
      <div className="mb-2 flex items-center gap-2 px-0.5">
        <div className="min-w-0 flex-1">
          <div className="mono truncate text-[12.5px] font-semibold text-ink">
            Agent #{agent.numericId}
          </div>
          <div className="truncate text-[12px] text-ink-4">{agent.template}</div>
        </div>
        <span className="mono text-[11.5px] text-ink-4">
          {loading ? 'loading' : `${visibleEntries.length} rows`}
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Close agent log"
          aria-label="Close agent log"
          className="grid h-7 w-7 shrink-0 place-items-center rounded text-ink-4 transition hover:bg-line-soft hover:text-ink"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {visibleEntries.length === 0 ? (
        <div className="px-0.5 py-3 text-[13.5px] text-ink-3">
          {loading ? 'Loading agent log…' : 'No visible agent log entries yet.'}
        </div>
      ) : (
        <div className="max-h-[320px] overflow-y-auto">
          {visibleEntries.map((entry) => (
            <CompactLogRow key={entry.id} entry={entry} workDir={workDir} />
          ))}
        </div>
      )}
    </div>
  )
}

function CompactLogRow({
  entry,
  workDir,
}: {
  entry: CompactLogEntry
  workDir: string
}): JSX.Element {
  const type = compactLogType(entry)
  const text = shortenSummary(entry.display ?? compactLogFallback(entry), workDir)

  return (
    <div className="grid grid-cols-[58px_minmax(0,1fr)] gap-2 px-3 py-1.5">
      <span className={cn('mono text-[11.5px]', type.className)}>
        {type.label}
      </span>
      <span className="min-w-0 truncate text-[13px] leading-5 text-ink-2">
        {text || 'No display text'}
      </span>
    </div>
  )
}

function shouldShowCompactLogEntry(entry: CompactLogEntry): boolean {
  return ![
    'input_received',
    'token_update',
    'work_end',
    'turn_start',
    'turn_end',
    'system_prompt',
  ].includes(entry.type)
}

function compactLogType(entry: CompactLogEntry): { label: string; className: string } {
  if (entry.type === 'tool_call') {
    const name = compactToolName(entry)
    if (name === 'bash') return { label: 'bash', className: 'text-info' }
    if (name === 'write_file' || name === 'edit_file') return { label: 'edit', className: 'text-warning' }
    return { label: 'tool', className: 'text-ink-3' }
  }
  if (entry.type === 'tool_result') return { label: 'out', className: 'text-ink-4' }
  if (entry.type === 'assistant_text' || entry.type === 'agent_result') {
    return { label: 'reply', className: 'text-success' }
  }
  if (entry.type === 'reasoning') return { label: 'think', className: 'text-ink-4' }
  if (entry.type === 'error') return { label: 'error', className: 'text-error' }
  return { label: entry.type.slice(0, 5), className: 'text-ink-4' }
}

function compactLogFallback(entry: CompactLogEntry): string {
  if (entry.type !== 'tool_call') return ''
  return compactToolName(entry)
}

function compactToolName(entry: CompactLogEntry): string {
  const metaName = entry.meta?.['toolName']
  if (typeof metaName === 'string' && metaName.length > 0) return metaName
  if (typeof entry.content?.name === 'string' && entry.content.name.length > 0) return entry.content.name
  if (typeof entry.content?.toolName === 'string' && entry.content.toolName.length > 0) return entry.content.toolName
  return 'tool'
}

/* ── Git ── */

function GitPanel({
  status,
  loading,
  recentTools,
  onRefresh,
}: {
  status: GitStatus | null
  loading: boolean
  recentTools: Array<{ toolName: string; text: string }>
  onRefresh: () => void | Promise<void>
}): JSX.Element {
  const [expandedDiffs, setExpandedDiffs] = useState<ReadonlySet<string>>(() => new Set())
  const [diffMode, setDiffMode] = useState<GitDiffMode>(() => readGitDiffMode())
  const [bulkAction, setBulkAction] = useState<'stageAll' | 'unstageAll' | null>(null)
  const fileSignature = status
    ? status.files.map((file) => `${file.staged}${file.unstaged}:${file.path}:${file.originalPath ?? ''}`).join('\n')
    : ''

  useEffect(() => {
    setExpandedDiffs(new Set())
  }, [status?.workDir, fileSignature])

  useEffect(() => {
    storeGitDiffMode(diffMode)
  }, [diffMode])

  if (!status) {
    return <div className="px-3.5 py-4 text-[14.5px] text-ink-3">Loading Git status…</div>
  }

  if (!status.isRepo) {
    return (
      <div className="px-3.5 py-4">
        <PanelHeader title="Repository" loading={loading} onRefresh={onRefresh} />
        <div className="mt-3 px-0.5">
          <div className="text-[14.5px] leading-[1.45] text-ink-3">
            No Git repository found.
          </div>
          <div className="mt-3 grid grid-cols-1 gap-1.5">
            <WorkspaceActionButton
              label="Open"
              title="Open workspace"
              onClick={() => void api.workspace.openPath(status.workDir)}
            >
              <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.7} />
            </WorkspaceActionButton>
          </div>
        </div>
        <SessionActivity recentTools={recentTools} workDir={status.workDir} />
      </div>
    )
  }

  const files = status.files
  const stagedFiles = files.filter(isStagedChange)
  const unstagedFiles = files.filter(isUnstagedChange)
  const untrackedCount = files.filter((file) => file.staged === '?' || file.unstaged === '?').length
  const visibleDiffKeys = [
    ...stagedFiles.slice(0, GIT_FILE_RENDER_LIMIT).map((file) => gitDiffKey(file, 'unstage')),
    ...unstagedFiles.slice(0, GIT_FILE_RENDER_LIMIT).map((file) => gitDiffKey(file, 'stage')),
  ]
  const hasVisibleDiffs = visibleDiffKeys.length > 0
  const allVisibleDiffsExpanded = hasVisibleDiffs && visibleDiffKeys.every((key) => expandedDiffs.has(key))
  const setDiffOpen = (key: string, open: boolean): void => {
    setExpandedDiffs((current) => {
      const next = new Set(current)
      if (open) next.add(key)
      else next.delete(key)
      return next
    })
  }
  const runBulkAction = async (action: 'stageAll' | 'unstageAll'): Promise<void> => {
    if (bulkAction) return
    setBulkAction(action)
    try {
      if (action === 'stageAll') {
        await api.git.stageAll({ workDir: status.workDir })
      } else {
        await api.git.unstageAll({ workDir: status.workDir })
      }
      setExpandedDiffs(new Set())
      await onRefresh()
    } finally {
      setBulkAction(null)
    }
  }

  return (
    <div className="px-3.5 py-4">
      <PanelHeader title="Repository" loading={loading} onRefresh={onRefresh} />

      <div className="mt-3 px-0.5">
        <div className="flex items-center gap-2">
          <GitBranch className="h-3.5 w-3.5 text-ink-3" strokeWidth={1.8} />
          <span className="mono min-w-0 flex-1 truncate text-[14px] text-ink">
            {status.branch ?? 'unknown'}
          </span>
          {status.clean ? (
            <span className="rounded-md bg-success/10 px-1.5 py-0.5 text-[12px] font-medium text-success">
              clean
            </span>
          ) : (
            <span className="rounded-md bg-warning/10 px-1.5 py-0.5 text-[12px] font-medium text-warning">
              {files.length} changed
            </span>
          )}
        </div>
        {(status.upstream || status.ahead > 0 || status.behind > 0) && (
          <div className="mt-2 flex flex-wrap gap-1.5 text-[12.5px] text-ink-3">
            {status.upstream && <span className="mono truncate">{status.upstream}</span>}
            {status.ahead > 0 && <span className="mono">ahead {status.ahead}</span>}
            {status.behind > 0 && <span className="mono">behind {status.behind}</span>}
          </div>
        )}
        {!status.clean && (
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px]">
            <span className="mono text-success">{stagedFiles.length} staged</span>
            <span className="mono text-warning">{unstagedFiles.length} changed</span>
            <span className="mono text-info">{untrackedCount} new</span>
          </div>
        )}
        {!status.clean && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            <GitBulkIndexButton
              label="Stage all"
              title="Stage all local changes"
              disabled={unstagedFiles.length === 0 || bulkAction !== null}
              active={bulkAction === 'stageAll'}
              onClick={() => void runBulkAction('stageAll')}
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.8} />
            </GitBulkIndexButton>
            <GitBulkIndexButton
              label="Unstage all"
              title="Unstage all staged changes"
              disabled={stagedFiles.length === 0 || bulkAction !== null}
              active={bulkAction === 'unstageAll'}
              onClick={() => void runBulkAction('unstageAll')}
            >
              <Minus className="h-3.5 w-3.5" strokeWidth={1.8} />
            </GitBulkIndexButton>
          </div>
        )}
        {hasVisibleDiffs && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            <GitDiffModeToggle mode={diffMode} onChange={setDiffMode} />
            <GitBulkDiffButton
              label={allVisibleDiffsExpanded ? 'Collapse diffs' : 'Expand diffs'}
              title={allVisibleDiffsExpanded ? 'Collapse visible diffs' : 'Expand visible diffs'}
              onClick={() => {
                setExpandedDiffs(allVisibleDiffsExpanded ? new Set() : new Set(visibleDiffKeys))
              }}
            >
              {allVisibleDiffsExpanded
                ? <ChevronsRight className="h-3.5 w-3.5" strokeWidth={1.8} />
                : <ChevronsDown className="h-3.5 w-3.5" strokeWidth={1.8} />}
            </GitBulkDiffButton>
          </div>
        )}
      </div>

      <div className="mt-4">
        {files.length === 0 ? (
          <div className="px-0.5 py-3 text-[14px] text-ink-3">
            No local file changes.
          </div>
        ) : (
          <div className="space-y-4">
            <GitFileSection
              title="Staged"
              files={stagedFiles}
              empty="No staged changes."
              action="unstage"
              root={status.root}
              workDir={status.workDir}
              diffMode={diffMode}
              expandedDiffs={expandedDiffs}
              onDiffOpenChange={setDiffOpen}
              onChanged={onRefresh}
            />
            <GitFileSection
              title="Changes"
              files={unstagedFiles}
              empty="No unstaged changes."
              action="stage"
              root={status.root}
              workDir={status.workDir}
              diffMode={diffMode}
              expandedDiffs={expandedDiffs}
              onDiffOpenChange={setDiffOpen}
              onChanged={onRefresh}
            />
          </div>
        )}
      </div>

      <SessionActivity recentTools={recentTools} workDir={status.workDir} />
    </div>
  )
}

const GIT_FILE_RENDER_LIMIT = 80

function GitBulkDiffButton({
  children,
  label,
  title,
  onClick,
}: {
  children: React.ReactNode
  label: string
  title: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md border border-line-soft bg-pane px-2 text-[12.5px] font-medium text-ink-2 transition hover:border-line hover:text-ink"
    >
      {children}
      <span className="truncate">{label}</span>
    </button>
  )
}

function GitBulkIndexButton({
  children,
  label,
  title,
  disabled,
  active,
  onClick,
}: {
  children: React.ReactNode
  label: string
  title: string
  disabled: boolean
  active: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md border border-line-soft bg-pane px-2 text-[12.5px] font-medium text-ink-2 transition',
        'hover:border-line hover:text-ink disabled:cursor-default disabled:opacity-45',
        active && 'border-line bg-line-soft text-ink',
      )}
    >
      {children}
      <span className="truncate">{active ? 'Working' : label}</span>
    </button>
  )
}

function GitDiffModeToggle({
  mode,
  onChange,
}: {
  mode: GitDiffMode
  onChange: (mode: GitDiffMode) => void
}): JSX.Element {
  const options: GitDiffMode[] = ['unified', 'split']
  return (
    <div className="inline-flex h-8 shrink-0 rounded-md border border-line-soft bg-pane p-0.5">
      {options.map((option) => {
        const active = option === mode
        return (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            className={cn(
              'h-7 rounded-[6px] px-2 text-[12.5px] font-medium capitalize transition',
              active ? 'bg-line-soft text-ink' : 'text-ink-3 hover:text-ink',
            )}
            title={`${option === 'unified' ? 'Unified' : 'Split'} diff view`}
            aria-label={`${option === 'unified' ? 'Unified' : 'Split'} diff view`}
            aria-pressed={active}
          >
            {option}
          </button>
        )
      })}
    </div>
  )
}

function GitFileSection({
  title,
  files,
  empty,
  action,
  root,
  workDir,
  diffMode,
  expandedDiffs,
  onDiffOpenChange,
  onChanged,
}: {
  title: string
  files: GitFileChange[]
  empty: string
  action: 'stage' | 'unstage'
  root: string | null
  workDir: string
  diffMode: GitDiffMode
  expandedDiffs: ReadonlySet<string>
  onDiffOpenChange: (key: string, open: boolean) => void
  onChanged: () => void | Promise<void>
}): JSX.Element {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2 px-0.5">
        <div className="text-[13px] font-semibold text-ink-2">
          {title}
        </div>
        <div className="h-px flex-1 bg-line-soft" />
        <div className="mono text-[11.5px] text-ink-4">{files.length}</div>
      </div>
      {files.length === 0 ? (
        <div className="rounded-lg border border-line-soft px-3 py-2.5 text-[13.5px] text-ink-4">
          {empty}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {files.slice(0, GIT_FILE_RENDER_LIMIT).map((file) => {
            const diffKey = gitDiffKey(file, action)
            return (
            <GitFileRow
              key={diffKey}
              file={file}
              action={action}
              diffKey={diffKey}
              diffOpen={expandedDiffs.has(diffKey)}
              onDiffOpenChange={onDiffOpenChange}
              root={root}
              workDir={workDir}
              diffMode={diffMode}
              onChanged={onChanged}
            />
            )
          })}
        </div>
      )}
    </section>
  )
}

function SessionActivity({
  recentTools,
  workDir,
}: {
  recentTools: Array<{ toolName: string; text: string }>
  workDir: string
}): JSX.Element {
  if (recentTools.length === 0) return <></>
  return (
    <div className="mt-5">
      <div className="mb-2 px-0.5 text-[13px] font-semibold text-ink-2">
        Session activity
      </div>
      <div className="flex flex-col gap-px">
        {recentTools.slice(0, 8).map((r, i) => (
          <div key={i} className="flex items-center gap-2 rounded-lg px-2.5 py-2 transition hover:bg-pane-2">
            <span className="mono grid h-4 w-4 shrink-0 place-items-center rounded-md bg-line-soft text-[12px] font-semibold text-ink-2">
              {r.toolName === 'write_file' || r.toolName === 'edit_file' ? 'M' : r.toolName === 'bash' ? '$' : '›'}
            </span>
            <div className="min-w-0 flex-1">
              <div className="mono truncate text-[13px] text-ink-2">
                {formatActivityText(r, workDir)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function formatActivityText(
  activity: { toolName: string; text: string },
  workDir: string,
): string {
  const text = shortenSummary(activity.text, workDir)
  const prefix = `${activity.toolName} `
  return text.startsWith(prefix) ? text.slice(prefix.length) : text
}

function PanelHeader({
  title,
  loading,
  onRefresh,
}: {
  title: string
  loading: boolean
  onRefresh: () => void | Promise<void>
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 px-0.5">
      <div className="text-[13px] font-semibold text-ink-2">
        {title}
      </div>
      <div className="flex-1" />
      <button
        type="button"
        onClick={() => void onRefresh()}
        className="grid h-7 w-7 place-items-center rounded text-ink-3 transition hover:bg-line-soft hover:text-ink"
        title={`Refresh ${title.toLowerCase()}`}
        aria-label={`Refresh ${title.toLowerCase()}`}
      >
        <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} strokeWidth={1.8} />
      </button>
    </div>
  )
}

function WorkspaceActionButton({
  children,
  label,
  title,
  onClick,
}: {
  children: React.ReactNode
  label: string
  title: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-line-soft bg-pane px-2 text-[13px] font-medium text-ink-2 transition hover:border-line hover:text-ink"
    >
      {children}
      <span className="truncate">{label}</span>
    </button>
  )
}

function GitFileRow({
  file,
  action,
  diffKey,
  diffOpen,
  onDiffOpenChange,
  root,
  workDir,
  diffMode,
  onChanged,
}: {
  file: GitFileChange
  action: 'stage' | 'unstage'
  diffKey: string
  diffOpen: boolean
  onDiffOpenChange: (key: string, open: boolean) => void
  root: string | null
  workDir: string
  diffMode: GitDiffMode
  onChanged: () => void | Promise<void>
}): JSX.Element {
  const [busyAction, setBusyAction] = useState<'stage' | 'unstage' | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffText, setDiffText] = useState<string | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const status = fileStatus(file)
  const canOpen = !!root && !`${file.staged}${file.unstaged}`.includes('D')
  const filePath = root ? joinPath(root, file.path) : null
  const canRunAction = action === 'stage' ? isUnstagedChange(file) : isStagedChange(file)
  const diffKind = action === 'unstage' ? 'staged' : 'working tree'
  const stats = gitChangeStats(file, action)

  const runAction = async (action: 'stage' | 'unstage'): Promise<void> => {
    if (busyAction) return
    setBusyAction(action)
    try {
      if (action === 'stage') {
        await api.git.stage({ workDir, path: file.path })
      } else {
        await api.git.unstage({ workDir, path: file.path })
      }
      await onChanged()
      setDiffText(null)
      onDiffOpenChange(diffKey, false)
    } finally {
      setBusyAction(null)
    }
  }

  const loadDiff = useCallback(async (): Promise<void> => {
    if (diffText !== null || diffLoading) return
    setDiffLoading(true)
    setDiffError(null)
    try {
      const diff = await api.git.diff({
        workDir,
        path: file.path,
        staged: action === 'unstage',
      })
      setDiffText(diff)
    } catch (err) {
      setDiffError(err instanceof Error ? err.message : String(err))
    } finally {
      setDiffLoading(false)
    }
  }, [action, diffLoading, diffText, file.path, workDir])

  useEffect(() => {
    if (diffOpen) void loadDiff()
  }, [diffOpen, loadDiff])

  const toggleDiff = async (): Promise<void> => {
    const nextOpen = !diffOpen
    onDiffOpenChange(diffKey, nextOpen)
    if (nextOpen) await loadDiff()
  }

  return (
    <div className="rounded-lg transition hover:bg-pane-2">
      <div className="group flex items-center gap-1">
        <button
          type="button"
          onClick={() => void toggleDiff()}
          aria-expanded={diffOpen}
          title={`Show ${diffKind} diff for ${file.path}`}
          aria-label={`Show ${diffKind} diff for ${file.path}`}
          className="ml-1 grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink-4 transition hover:bg-line-soft hover:text-ink"
        >
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', diffOpen && 'rotate-90')} />
        </button>
        <button
          type="button"
          disabled={!canOpen}
          onClick={() => {
            if (filePath) void api.workspace.openPath(filePath)
          }}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-2 text-left text-[13.5px] transition',
            canOpen ? 'hover:text-ink' : 'cursor-default',
          )}
          title={canOpen ? `Open ${file.path}` : file.path}
        >
          <span
            className={cn(
              'mono grid h-5 w-5 shrink-0 place-items-center rounded-md text-[11.5px] font-semibold',
              status.tone === 'add' && 'bg-success/10 text-success',
              status.tone === 'delete' && 'bg-error/10 text-error',
              status.tone === 'rename' && 'bg-info/10 text-info',
              status.tone === 'modify' && 'bg-warning/10 text-warning',
              status.tone === 'neutral' && 'bg-line-soft text-ink-3',
            )}
          >
            {status.label}
          </span>
          <FileText className="h-3.5 w-3.5 shrink-0 text-ink-4" strokeWidth={1.6} />
          <div className="min-w-0 flex-1">
            <div className="mono truncate text-ink-2">{file.path}</div>
            {file.originalPath && (
              <div className="mono truncate text-[12px] text-ink-4">from {file.originalPath}</div>
            )}
          </div>
          <GitFileStats additions={stats.additions} deletions={stats.deletions} />
          {file.staged !== ' ' && <Circle className="h-2 w-2 fill-success text-success" />}
          {file.unstaged !== ' ' && <Circle className="h-2 w-2 fill-warning text-warning" />}
          {canOpen && (
            <ExternalLink className="h-3 w-3 shrink-0 text-ink-4 opacity-0 transition group-hover:opacity-100" />
          )}
        </button>
        <div className="flex shrink-0 items-center gap-0.5 pr-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
          {canRunAction && (
            <GitActionButton
              label={`${action === 'stage' ? 'Stage' : 'Unstage'} ${file.path}`}
              disabled={!!busyAction}
              active={busyAction === action}
              onClick={() => void runAction(action)}
            >
              {action === 'stage'
                ? <Plus className="h-3 w-3" strokeWidth={2} />
                : <Minus className="h-3 w-3" strokeWidth={2} />}
            </GitActionButton>
          )}
        </div>
      </div>
      {diffOpen && (
        <div className="px-2 pb-2 pl-9">
          {diffLoading ? (
            <div className="rounded-md border border-line-soft bg-code-bg px-3 py-2 text-[13px] text-ink-3">
              Loading diff…
            </div>
          ) : diffError ? (
            <div className="rounded-md border border-error/30 bg-error/5 px-3 py-2 text-[13px] text-error">
              {diffError}
            </div>
          ) : diffText?.trim() ? (
            <DiffView text={diffText} workDir={workDir} isError={false} mode={diffMode} />
          ) : (
            <div className="rounded-md border border-line-soft bg-code-bg px-3 py-2 text-[13px] text-ink-3">
              No {diffKind} diff.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function gitDiffKey(file: GitFileChange, action: 'stage' | 'unstage'): string {
  return `${action}:${file.staged}${file.unstaged}:${file.path}`
}

function GitFileStats({
  additions,
  deletions,
}: {
  additions: number | null
  deletions: number | null
}): JSX.Element | null {
  if (additions === null && deletions === null) return null
  if (additions === 0 && deletions === 0) return null
  return (
    <span className="mono inline-flex shrink-0 items-center gap-1 text-[12.5px] tabular-nums">
      {additions !== null && additions > 0 && <span className="text-success">+{additions}</span>}
      {deletions !== null && deletions > 0 && <span className="text-error">-{deletions}</span>}
    </span>
  )
}

function gitChangeStats(file: GitFileChange, action: 'stage' | 'unstage'): {
  additions: number | null
  deletions: number | null
} {
  if (action === 'unstage') {
    return {
      additions: file.stagedAdditions ?? null,
      deletions: file.stagedDeletions ?? null,
    }
  }
  return {
    additions: file.unstagedAdditions ?? null,
    deletions: file.unstagedDeletions ?? null,
  }
}

function GitActionButton({
  children,
  label,
  disabled,
  active,
  onClick,
}: {
  children: React.ReactNode
  label: string
  disabled: boolean
  active: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        'grid h-7 w-7 place-items-center rounded-md text-ink-3 transition hover:bg-line-soft hover:text-ink disabled:opacity-50',
        active && 'bg-line-soft text-ink',
      )}
    >
      {children}
    </button>
  )
}

function fileStatus(file: GitFileChange): {
  label: string
  tone: 'add' | 'delete' | 'rename' | 'modify' | 'neutral'
} {
  const code = `${file.staged}${file.unstaged}`
  if (code.includes('R')) return { label: 'R', tone: 'rename' }
  if (code.includes('A') || code.includes('?')) return { label: 'A', tone: 'add' }
  if (code.includes('D')) return { label: 'D', tone: 'delete' }
  if (code.trim()) return { label: 'M', tone: 'modify' }
  return { label: '•', tone: 'neutral' }
}

function isStagedChange(file: GitFileChange): boolean {
  return file.staged !== ' ' && file.staged !== '?'
}

function isUnstagedChange(file: GitFileChange): boolean {
  return file.unstaged !== ' ' || file.staged === '?'
}

/* ── Files ── */

const FILE_RENDER_LIMIT = 180

function FilesPanel({
  files,
  loading,
  workDir,
  onRefresh,
}: {
  files: readonly WorkspaceFileEntry[]
  loading: boolean
  workDir: string
  onRefresh: () => void | Promise<void>
}): JSX.Element {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const filteredFiles = normalizedQuery
    ? files.filter((file) => file.path.toLowerCase().includes(normalizedQuery))
    : files
  const visibleFiles = filteredFiles.slice(0, FILE_RENDER_LIMIT)

  return (
    <div className="px-3.5 py-4">
      <PanelHeader title="Files" loading={loading} onRefresh={onRefresh} />

      <div className="relative mt-2">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-4"
          strokeWidth={1.8}
        />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter files"
          className="right-pane-filter-input h-9 w-full rounded-lg border border-line-soft bg-pane-2 pl-8 pr-9 text-[13.5px] text-ink outline-none transition placeholder:text-ink-3 hover:border-line"
          aria-label="Filter files"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label="Clear filter"
            className="absolute right-1.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-ink-4 transition hover:bg-line-soft hover:text-ink"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      <div className="mt-3">
        <div className="flex h-7 items-center gap-2 px-0.5">
          <div className="mono min-w-0 flex-1 truncate text-[12px] text-ink-4">
            {loading ? 'loading' : `${filteredFiles.length} files`}
          </div>
          {filteredFiles.length > FILE_RENDER_LIMIT && (
            <div className="mono shrink-0 text-[11.5px] text-ink-4">
              {FILE_RENDER_LIMIT} shown
            </div>
          )}
        </div>

        {visibleFiles.length === 0 ? (
          <div className="px-0.5 py-3 text-[13.5px] text-ink-3">
            {loading ? 'Loading files…' : normalizedQuery ? 'No matching files.' : 'No files found.'}
          </div>
        ) : (
          <div className="max-h-[calc(100vh-190px)] overflow-y-auto">
            {visibleFiles.map((file) => (
              <FileListRow
                key={file.path}
                file={file}
                onOpen={() => void api.workspace.openPath(joinPath(workDir, file.path))}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function FileListRow({
  file,
  onOpen,
}: {
  file: WorkspaceFileEntry
  onOpen: () => void
}): JSX.Element {
  const basename = file.path.split('/').filter(Boolean).pop() ?? file.path
  const Icon = iconForExtension(basename)
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex h-10 w-full items-center gap-2 rounded px-2 text-left transition hover:bg-line-soft"
      title={`Open ${file.path}`}
      aria-label={`Open ${file.path}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-ink-4" strokeWidth={1.6} />
      <div className="min-w-0 flex-1">
        <div className="mono truncate text-[13px] leading-5 text-ink-2 transition group-hover:text-ink">
          {file.path}
        </div>
        <div className="mono truncate text-[11.5px] leading-4 text-ink-4">
          {formatFileSize(file.size)} · {formatFileMtime(file.mtimeMs)}
        </div>
      </div>
      <ExternalLink className="h-3 w-3 shrink-0 text-ink-4 opacity-0 transition group-hover:opacity-100" />
    </button>
  )
}

/* ── Search ── */

function SearchPanel({ workDir }: { workDir: string }): JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<readonly WorkspaceTextSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const normalizedQuery = query.trim()
  const groups = groupSearchResults(results)

  const runSearch = useCallback(async (): Promise<void> => {
    const nextQuery = normalizedQuery
    if (nextQuery.length < 2) {
      setResults([])
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      setResults(await api.workspace.searchText({ workDir, query: nextQuery }))
    } catch (err) {
      setResults([])
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [normalizedQuery, workDir])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void runSearch()
    }, 180)
    return () => window.clearTimeout(timer)
  }, [runSearch])

  return (
    <div className="px-3.5 py-4">
      <PanelHeader title="Search" loading={loading} onRefresh={runSearch} />

      <div className="relative mt-2">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-4"
          strokeWidth={1.8}
        />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search text"
          className="right-pane-filter-input h-9 w-full rounded-lg border border-line-soft bg-pane-2 pl-8 pr-9 text-[13.5px] text-ink outline-none transition placeholder:text-ink-3 hover:border-line"
          aria-label="Search text"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label="Clear search"
            className="absolute right-1.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-ink-4 transition hover:bg-line-soft hover:text-ink"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      <div className="mt-3">
        {normalizedQuery.length >= 2 && (
          <div className="flex h-7 items-center gap-2 px-0.5">
            <div className="mono min-w-0 flex-1 truncate text-[12px] text-ink-4">
              {loading ? 'searching' : `${results.length} matches`}
            </div>
          </div>
        )}

        {error ? (
          <div className="px-0.5 py-3 text-[13.5px] text-error">{error}</div>
        ) : normalizedQuery.length < 2 ? (
          <div className="px-0.5 py-3 text-[13.5px] text-ink-3">Type to search.</div>
        ) : results.length === 0 ? (
          <div className="px-0.5 py-3 text-[13.5px] text-ink-3">
            {loading ? 'Searching…' : 'No matches.'}
          </div>
        ) : (
          <div className="max-h-[calc(100vh-190px)] overflow-y-auto">
            {groups.map((group) => (
              <SearchResultGroup
                key={group.path}
                group={group}
                query={normalizedQuery}
                workDir={workDir}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

interface SearchResultGroupData {
  readonly path: string
  readonly results: WorkspaceTextSearchResult[]
}

function groupSearchResults(results: readonly WorkspaceTextSearchResult[]): SearchResultGroupData[] {
  const groups = new Map<string, WorkspaceTextSearchResult[]>()
  for (const result of results) {
    const current = groups.get(result.path)
    if (current) current.push(result)
    else groups.set(result.path, [result])
  }
  return Array.from(groups, ([path, groupResults]) => ({ path, results: groupResults }))
}

function SearchResultGroup({
  group,
  query,
  workDir,
}: {
  group: SearchResultGroupData
  query: string
  workDir: string
}): JSX.Element {
  return (
    <div className="border-b border-line-soft last:border-b-0">
      <button
        type="button"
        onClick={() => void api.workspace.openPath(joinPath(workDir, group.path))}
        className="group flex h-9 w-full items-center gap-2 px-3 text-left transition hover:bg-pane"
        title={`Open ${group.path}`}
        aria-label={`Open ${group.path}`}
      >
        <FileText className="h-3.5 w-3.5 shrink-0 text-ink-4" strokeWidth={1.6} />
        <div className="mono min-w-0 flex-1 truncate text-[13px] text-ink-2 transition group-hover:text-ink">
          {group.path}
        </div>
        <div className="mono shrink-0 text-[11.5px] text-ink-4">
          {group.results.length}
        </div>
      </button>
      <div className="pb-1">
        {group.results.map((result, index) => (
          <SearchResultRow
            key={`${result.line}:${result.column}:${index}`}
            result={result}
            query={query}
            onOpen={() => void api.workspace.openPath(joinPath(workDir, result.path))}
          />
        ))}
      </div>
    </div>
  )
}

function SearchResultRow({
  result,
  query,
  onOpen,
}: {
  result: WorkspaceTextSearchResult
  query: string
  onOpen: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group w-full px-3 py-1.5 pl-8 text-left transition hover:bg-pane"
      title={`Open ${result.path}:${result.line}`}
      aria-label={`Open ${result.path}:${result.line}`}
    >
      <div className="mono mb-0.5 text-[11.5px] text-ink-4">
        {result.line}:{result.column}
      </div>
      <div className="line-clamp-2 text-[13px] leading-[1.4] text-ink-3">
        {highlightSearchMatch(result.text.trim(), query)}
      </div>
    </button>
  )
}

function highlightSearchMatch(text: string, query: string): Array<string | JSX.Element> {
  if (!query) return [text]
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  const index = haystack.indexOf(needle)
  if (index < 0) return [text]
  return [
    text.slice(0, index),
    <mark key="match" className="rounded bg-warning/20 px-0.5 text-ink">
      {text.slice(index, index + query.length)}
    </mark>,
    text.slice(index + query.length),
  ]
}

/* ── Shells ── */

interface ShellReportEntry {
  readonly id: string
  readonly status: string
  readonly elapsed: string
  readonly exit: string | null
  readonly signal: string | null
  readonly logPath: string | null
  readonly recent: string | null
}

function ShellsPanel({
  report,
  loading,
  disabled,
  onRefresh,
  onKillAll,
}: {
  report: string
  loading: boolean
  disabled: boolean
  onRefresh: () => void | Promise<void>
  onKillAll: () => void | Promise<void>
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const shells = parseShellReport(report)
  const running = shells.filter((shell) => shell.status === 'running')

  const killAll = async (): Promise<void> => {
    if (busy || running.length === 0) return
    setBusy(true)
    try {
      await onKillAll()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-3.5 py-4">
      <PanelHeader title="Shells" loading={loading} onRefresh={onRefresh} />

      {shells.length === 0 ? (
        <div className="mt-3 rounded-lg border border-line-soft px-3 py-3">
          <div className="text-[13.5px] text-ink-3">
            {loading ? 'Loading shells…' : disabled ? 'No active session.' : 'No shells tracked.'}
          </div>
          {!loading && !disabled && (
            <div className="mt-1 text-[12.5px] leading-[1.5] text-ink-4">
              Long-running commands started with <span className="mono">bash_background</span> appear here while alive.
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="mt-2 flex items-center gap-2 px-0.5 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-medium text-ink">
                {running.length > 0 ? `${running.length} running` : 'No running shells'}
              </div>
              <div className="mono mt-0.5 text-[12px] text-ink-4">
                {`${shells.length} tracked`}
              </div>
            </div>
            <button
              type="button"
              disabled={disabled || running.length === 0 || busy}
              onClick={() => void killAll()}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded px-2 text-[12.5px] font-medium text-ink-2 transition hover:bg-line-soft hover:text-ink disabled:cursor-default disabled:opacity-45"
              title="Kill all running background shells"
              aria-label="Kill all running background shells"
            >
              <X className="h-3.5 w-3.5" strokeWidth={1.8} />
              <span>{busy ? 'Killing' : 'Kill all'}</span>
            </button>
          </div>

          <div className="mt-2">
            {shells.map((shell, index) => (
              <div key={shell.id} className={cn(index > 0 && 'border-t border-line-soft')}>
                <ShellReportRow shell={shell} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function ShellReportRow({ shell }: { shell: ShellReportEntry }): JSX.Element {
  const running = shell.status === 'running'
  const tone = running
    ? 'bg-success/10 text-success'
    : shell.status === 'failed'
      ? 'bg-error/10 text-error'
      : 'bg-line-soft text-ink-3'

  return (
    <div className="px-3 py-2.5">
      <div className="mb-1 flex items-center gap-2">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', running ? 'bg-success' : 'bg-ink-4')} />
        <div className="mono min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
          {shell.id}
        </div>
        <span className={cn('rounded-md px-1.5 py-0.5 text-[11.5px] font-medium', tone)}>
          {shell.status}
        </span>
      </div>
      <div className="mono flex flex-wrap gap-x-2 gap-y-1 text-[11.5px] text-ink-4">
        <span>{shell.elapsed}</span>
        {shell.exit && <span>exit {shell.exit}</span>}
        {shell.signal && <span>{shell.signal}</span>}
      </div>
      {shell.recent && (
        <div className="mt-1.5 line-clamp-2 text-[12.5px] leading-[1.4] text-ink-3">
          {shell.recent}
        </div>
      )}
      {shell.logPath && (
        <div className="mono mt-1 truncate text-[11.5px] text-ink-4">
          {shell.logPath}
        </div>
      )}
    </div>
  )
}

function parseShellReport(report: string): ShellReportEntry[] {
  if (!report || report.includes('No shells tracked')) return []
  const entries: ShellReportEntry[] = []
  const lines = report.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const match = /^- \[([^\]]+)\] ([a-z_]+) \(([^)]+)\)(.*)$/.exec(line)
    if (!match) continue
    const rest = match[4] ?? ''
    const logMatch = /\| log: ([^|]+)(?:$|\|)/.exec(rest)
    const exitMatch = /\| exit=([^|]+)/.exec(rest)
    const signalMatch = /\| signal=([^|]+)/.exec(rest)
    const nextLine = lines[i + 1]?.trim() ?? ''
    const recent = nextLine.startsWith('recent:') ? nextLine.slice('recent:'.length).trim() : null
    entries.push({
      id: match[1] ?? '',
      status: match[2] ?? 'unknown',
      elapsed: match[3] ?? '',
      exit: exitMatch?.[1]?.trim() ?? null,
      signal: signalMatch?.[1]?.trim() ?? null,
      logPath: logMatch?.[1]?.trim() ?? null,
      recent,
    })
  }
  return entries
}

/* ── Helpers ── */

function formatRewindHint(target: RewindTarget): string {
  const parts = [`turn ${target.turnIndex}`]
  if (target.fileCount > 0) parts.push(`${target.fileCount} files`)
  if (target.additions > 0) parts.push(`+${target.additions}`)
  if (target.deletions > 0) parts.push(`-${target.deletions}`)
  if (target.filesReverted) parts.push('files reverted')
  return parts.join(' · ')
}

function normalizeStatus(cp: PlanCheckpoint): 'todo' | 'in_progress' | 'done' {
  if (cp.status === 'done' || cp.state === 'done' || cp.done === true) return 'done'
  if (cp.status === 'in_progress' || cp.state === 'in_progress') return 'in_progress'
  return 'todo'
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatFileMtime(mtimeMs: number): string {
  const date = new Date(mtimeMs)
  if (Number.isNaN(date.getTime())) return 'unknown'
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function getRecentTools(state: ReturnType<typeof useSessionStore.getState>['perTab'][string] | undefined) {
  if (!state?.logEntries) return []
  const log = state.logEntries as Array<{
    type: string
    display?: string
    meta?: Record<string, unknown>
    content?: { name?: unknown; toolName?: unknown }
  }>
  return log
    .filter((e) => e.type === 'tool_call')
    .slice(-8)
    .reverse()
    .map((e) => ({
      toolName: recentToolName(e),
      text: e.display ?? '',
    }))
}

function recentToolName(entry: {
  meta?: Record<string, unknown>
  content?: { name?: unknown; toolName?: unknown }
}): string {
  const metaName = entry.meta?.['toolName']
  if (typeof metaName === 'string' && metaName.length > 0) return metaName
  if (typeof entry.content?.name === 'string' && entry.content.name.length > 0) return entry.content.name
  if (typeof entry.content?.toolName === 'string' && entry.content.toolName.length > 0) return entry.content.toolName
  return 'tool'
}

function joinPath(root: string, child: string): string {
  return `${root.replace(/\/+$/, '')}/${child.replace(/^\/+/, '')}`
}

function readRightPaneTab(): RightPaneTab {
  try {
    const value = window.localStorage.getItem(RIGHT_PANE_TAB_KEY)
    return value === 'agents' || value === 'context' || value === 'git' || value === 'files' || value === 'search' || value === 'shells' || value === 'plan'
      ? value
      : 'plan'
  } catch {
    return 'plan'
  }
}

function storeRightPaneTab(tab: RightPaneTab): void {
  try {
    window.localStorage.setItem(RIGHT_PANE_TAB_KEY, tab)
  } catch {
    /* localStorage can be unavailable in hardened contexts. */
  }
}

function readRightPaneCollapsed(): boolean {
  try {
    return window.localStorage.getItem(RIGHT_PANE_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function storeRightPaneCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(RIGHT_PANE_COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    /* localStorage can be unavailable in hardened contexts. */
  }
}

function readGitDiffMode(): GitDiffMode {
  try {
    const value = window.localStorage.getItem(GIT_DIFF_MODE_KEY)
    return value === 'split' ? 'split' : 'unified'
  } catch {
    return 'unified'
  }
}

function storeGitDiffMode(mode: GitDiffMode): void {
  try {
    window.localStorage.setItem(GIT_DIFF_MODE_KEY, mode)
  } catch {
    /* localStorage can be unavailable in hardened contexts. */
  }
}
