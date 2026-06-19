import { useEffect, useRef, useState } from 'react'
import type { ButtonHTMLAttributes } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Code2, MoreHorizontal, FolderOpen, Pencil, X, Copy, GitBranch, ScrollText, Archive, Pin, Undo2 } from 'lucide-react'
import { useSessionStore } from '@/state/sessionStore.js'
import { Composer } from '@/components/Composer.js'
import { Transcript, type TranscriptRewindTarget } from '@/components/Transcript.js'
import { StatusBar } from '@/components/StatusBar.js'
import { AskBar } from '@/components/ApprovalCard.js'
import { cn } from '@/lib/cn.js'
import { projectName } from '@/lib/path.js'
import { api } from '@/lib/api.js'
import type { SessionTab } from '@shared/rpc.js'

export function SessionPane({ tab }: { tab: SessionTab }): JSX.Element {
  const state = useSessionStore((s) => s.perTab[tab.tabId])
  const markdownMode = useSessionStore((s) => s.markdownMode)
  const toggleMarkdownMode = useSessionStore((s) => s.toggleMarkdownMode)
  const submitTurn = useSessionStore((s) => s.submitTurn)
  const closeTab = useSessionStore((s) => s.closeTab)
  const refreshMeta = useSessionStore((s) => s.refreshMeta)
  const refreshLog = useSessionStore((s) => s.refreshLog)
  const refreshStatus = useSessionStore((s) => s.refreshStatus)
  const refreshHistory = useSessionStore((s) => s.refreshHistory)
  const openHistorySession = useSessionStore((s) => s.openHistorySession)
  const setHistorySessionPinned = useSessionStore((s) => s.setHistorySessionPinned)
  const history = useSessionStore((s) => s.history)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const [sessionNotice, setSessionNotice] = useState<string | null>(null)
  const [pendingTranscriptRewind, setPendingTranscriptRewind] = useState<TranscriptRewindTarget | null>(null)
  const [rewinding, setRewinding] = useState(false)

  useEffect(() => {
    const el = transcriptRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [state?.logRevision])

  const onSubmit = async (input: string): Promise<void> => {
    await submitTurn(tab.tabId, input)
  }

  const showSessionNotice = (message: string): void => {
    setSessionNotice(message)
    window.setTimeout(() => setSessionNotice((current) => (current === message ? null : current)), 1800)
  }

  const copyLastAgentResponse = async (): Promise<void> => {
    const text = findLastAgentResponse(state?.logEntries ?? [])
    if (!text) {
      showSessionNotice('No agent response to copy')
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      showSessionNotice(`Copied ${text.length} chars`)
    } catch (err) {
      console.error('copy response failed', err)
      showSessionNotice('Copy failed')
    }
  }

  const copySessionTranscript = async (): Promise<void> => {
    const text = formatSessionTranscriptMarkdown({
      entries: state?.logEntries ?? [],
      title: tab.title ?? tab.displayName ?? projectName(tab.workDir),
      workDir: tab.workDir,
    })
    if (!text.trim()) {
      showSessionNotice('No transcript to copy')
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      showSessionNotice(`Copied transcript (${text.length} chars)`)
    } catch (err) {
      console.error('copy transcript failed', err)
      showSessionNotice('Copy failed')
    }
  }

  const forkSession = async (): Promise<void> => {
    if (tab.status === 'draft') return
    try {
      showSessionNotice('Forking session')
      const result = await api.rpc.request<{ sessionId: string; title: string }>(tab.tabId, 'session.fork')
      await refreshHistory()
      const opened = await openHistorySession(tab.workDir, result.sessionId)
      showSessionNotice(opened ? 'Forked session' : 'Fork created but not opened')
    } catch (err) {
      console.error('fork session failed', err)
      showSessionNotice(err instanceof Error ? err.message : 'Fork failed')
    }
  }

  const archiveSession = async (): Promise<void> => {
    if (tab.status === 'draft' || !tab.sessionId || state?.status?.currentTurnRunning) return
    try {
      showSessionNotice('Archiving session')
      await closeTab(tab.tabId)
      await api.history.archiveSession({ workDir: tab.workDir, sessionId: tab.sessionId })
      await refreshHistory()
    } catch (err) {
      console.error('archive session failed', err)
      showSessionNotice(err instanceof Error ? err.message : 'Archive failed')
    }
  }

  const pinned = tab.sessionId
    ? history
      .find((group) => group.workDir === tab.workDir)
      ?.sessions.some((session) => session.sessionId === tab.sessionId && session.pinned) ?? false
    : false

  const toggleSessionPinned = async (): Promise<void> => {
    if (tab.status === 'draft' || !tab.sessionId) return
    await setHistorySessionPinned(tab.workDir, tab.sessionId, !pinned)
    showSessionNotice(pinned ? 'Unpinned session' : 'Pinned session')
  }

  const requestTranscriptRewind = (target: TranscriptRewindTarget): void => {
    if (tab.status === 'draft' || state?.status?.currentTurnRunning) return
    setPendingTranscriptRewind(target)
  }

  const confirmTranscriptRewind = async (): Promise<void> => {
    const target = pendingTranscriptRewind
    if (!target || tab.status === 'draft' || state?.status?.currentTurnRunning || rewinding) return
    setRewinding(true)
    try {
      const result = await api.rpc.request<{ removed: number; error?: string }>(tab.tabId, 'session.rewind', {
        toTurnIndex: target.turnIndex,
      })
      if (result.error) throw new Error(result.error)
      setPendingTranscriptRewind(null)
      await Promise.all([
        refreshLog(tab.tabId),
        refreshStatus(tab.tabId),
        refreshMeta(tab.tabId),
        refreshHistory(),
      ])
      showSessionNotice(`Rewound ${result.removed} entries`)
    } catch (err) {
      console.error('transcript rewind failed', err)
      showSessionNotice(err instanceof Error ? err.message : 'Rewind failed')
    } finally {
      setRewinding(false)
    }
  }

  if (tab.status === 'starting') {
    return (
      <div className="flex h-full items-center justify-center text-ink-3">
        <span className="shimmer-text text-[15px]">Starting session…</span>
      </div>
    )
  }
  if (tab.status === 'error') {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-md rounded-xl border border-error/30 bg-error/5 p-5">
          <div className="text-[15px] font-medium text-error">Session failed to start</div>
          <pre className="mt-2 whitespace-pre-wrap text-[15.5px] text-ink-3">
            {tab.errorMessage ?? 'Unknown error'}
          </pre>
        </div>
      </div>
    )
  }

  const projectLabel = projectName(tab.workDir)
  const sessionTitle = (tab.title ?? tab.displayName ?? '').trim()
  const headerTitle = sessionTitle.length > 0 && sessionTitle !== projectLabel ? sessionTitle : projectLabel
  const headerSubtitle = headerTitle === projectLabel ? '' : projectLabel
  // Empty draft: hero already announces the workspace, so hide the redundant
  // header title — keep the action buttons reachable on the right.
  const showHeaderTitle = !(tab.status === 'draft' && (state?.logEntries?.length ?? 0) === 0)

  return (
    <div data-session-pane-root className="flex h-full min-w-0 flex-1 flex-col bg-pane">
      {/* Thread header — project name + tool buttons */}
      <div className={cn(
        'flex h-12 shrink-0 items-center gap-3 px-6',
        showHeaderTitle && 'border-b border-line-soft',
      )}>
        <div className="min-w-0 flex-1">
          {showHeaderTitle && (
            <>
              <div className="truncate text-[15px] font-semibold leading-tight text-ink">{headerTitle}</div>
              {headerSubtitle && (
                <div className="mt-0.5 truncate text-[12.5px] leading-tight text-ink-4">
                  {headerSubtitle}
                </div>
              )}
            </>
          )}
        </div>
        {showHeaderTitle && (
          <HeaderBtn
            label={markdownMode === 'rendered' ? 'Show raw markdown' : 'Render markdown'}
            onClick={toggleMarkdownMode}
            active={markdownMode === 'raw'}
          >
            <Code2 className="h-3.5 w-3.5" strokeWidth={1.7} />
          </HeaderBtn>
        )}
        <HeaderMenu
          tab={tab}
          onClose={() => void closeTab(tab.tabId)}
          onRenamed={() => void refreshMeta(tab.tabId)}
          onCopyLastResponse={() => void copyLastAgentResponse()}
          canCopyLastResponse={!!findLastAgentResponse(state?.logEntries ?? [])}
          onCopyTranscript={() => void copySessionTranscript()}
          canCopyTranscript={hasVisibleTranscript(state?.logEntries ?? [])}
          onForkSession={() => void forkSession()}
          canForkSession={tab.status !== 'draft' && !(state?.status?.currentTurnRunning ?? false)}
          pinned={pinned}
          onTogglePinned={() => void toggleSessionPinned()}
          canTogglePinned={tab.status !== 'draft' && !!tab.sessionId}
          onArchiveSession={() => void archiveSession()}
          canArchiveSession={tab.status !== 'draft' && !!tab.sessionId && !(state?.status?.currentTurnRunning ?? false)}
        />
      </div>
      {sessionNotice && (
        <div className="pointer-events-none fixed left-1/2 top-14 z-50 -translate-x-1/2 rounded-full border border-line bg-pane-2 px-3 py-1.5 text-[13px] font-medium text-ink-2 shadow-xl">
          {sessionNotice}
        </div>
      )}

      <div ref={transcriptRef} className="session-scroll min-h-0 flex-1 overflow-y-auto bg-pane">
        {tab.status === 'draft' && (state?.logEntries?.length ?? 0) === 0 ? (
          <DraftHero project={projectLabel} />
        ) : (
          <Transcript
            entries={state?.logEntries ?? []}
            activeId={state?.activeLogEntryId ?? null}
            workDir={tab.workDir}
            markdownMode={markdownMode}
            emptyLabel={tab.status === 'draft' ? null : 'Ready'}
            canRewind={tab.status !== 'draft' && !(state?.status?.currentTurnRunning ?? false)}
            onRequestRewind={requestTranscriptRewind}
          />
        )}
      </div>
      <TranscriptRewindDialog
        target={pendingTranscriptRewind}
        busy={rewinding}
        onOpenChange={(open) => {
          if (!open && !rewinding) setPendingTranscriptRewind(null)
        }}
        onConfirm={() => void confirmTranscriptRewind()}
      />
      <AskBar tab={tab} />
      <StatusBar state={state ?? null} />
      <Composer
        tab={tab}
        state={state ?? null}
        onSubmit={onSubmit}
        disabled={state?.status?.currentTurnRunning ?? false}
      />
    </div>
  )
}

function DraftHero({ project }: { project: string }): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center px-6 pb-24">
      <div className="flex max-w-[480px] flex-col items-center gap-2 text-center">
        <div className="text-[22px] font-medium leading-[1.25] tracking-[-0.01em] text-ink">
          What should we build in <span className="text-accent">{project}</span>?
        </div>
        <div className="text-[13.5px] leading-[1.5] text-ink-4">
          Drop a message below, or <span className="mono text-ink-3">@</span>-reference files to anchor the context.
        </div>
      </div>
    </div>
  )
}

function TranscriptRewindDialog({
  target,
  busy,
  onOpenChange,
  onConfirm,
}: {
  target: TranscriptRewindTarget | null
  busy: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}): JSX.Element {
  return (
    <Dialog.Root open={target !== null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/35 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[440px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-pane-2 p-4 shadow-2xl">
          <Dialog.Title className="flex items-center gap-2 text-[16px] font-semibold text-ink">
            <Undo2 className="h-4 w-4 text-warning" strokeWidth={1.8} />
            Rewind before this message
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-[13.5px] leading-[1.45] text-ink-3">
            This removes this user turn and everything after it from the session transcript.
          </Dialog.Description>
          {target && (
            <div className="mt-3 rounded-lg border border-line-soft bg-pane px-3 py-2">
              <div className="mono text-[11.5px] text-ink-4">turn {target.turnIndex}</div>
              <div className="mt-1 line-clamp-3 text-[13.5px] leading-[1.45] text-ink-2">
                {target.preview}
              </div>
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                disabled={busy}
                className="rounded px-3 py-1.5 text-[14px] font-medium text-ink-3 transition hover:bg-line-soft hover:text-ink disabled:opacity-45"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              className="rounded bg-warning px-3 py-1.5 text-[14px] font-medium text-pane transition hover:opacity-90 disabled:opacity-45"
            >
              {busy ? 'Rewinding' : 'Rewind'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function HeaderBtn({
  children,
  label,
  active,
  ...props
}: {
  children: React.ReactNode
  label?: string
  active?: boolean
} & ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        'grid h-8 w-8 place-items-center rounded transition hover:bg-line-soft hover:text-ink',
        active ? 'bg-line-soft text-ink' : 'text-ink-3',
      )}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  )
}

function findLastAgentResponse(entries: readonly unknown[]): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as {
      type?: unknown
      discarded?: unknown
      display?: unknown
      content?: unknown
    } | null
    if (!entry || entry.discarded) continue
    if (entry.type !== 'assistant_text' && entry.type !== 'agent_result') continue
    const text = typeof entry.display === 'string'
      ? entry.display
      : typeof entry.content === 'string'
        ? entry.content
        : ''
    if (text.trim()) return text
  }
  return null
}

function HeaderMenu({
  tab,
  onClose,
  onRenamed,
  onCopyLastResponse,
  canCopyLastResponse,
  onCopyTranscript,
  canCopyTranscript,
  onForkSession,
  canForkSession,
  pinned,
  onTogglePinned,
  canTogglePinned,
  onArchiveSession,
  canArchiveSession,
}: {
  tab: SessionTab
  onClose: () => void
  onRenamed: () => void
  onCopyLastResponse: () => void
  canCopyLastResponse: boolean
  onCopyTranscript: () => void
  canCopyTranscript: boolean
  onForkSession: () => void
  canForkSession: boolean
  pinned: boolean
  onTogglePinned: () => void
  canTogglePinned: boolean
  onArchiveSession: () => void
  canArchiveSession: boolean
}): JSX.Element {
  const [renameOpen, setRenameOpen] = useState(false)

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <HeaderBtn label="Session actions">
            <MoreHorizontal className="h-3.5 w-3.5" strokeWidth={1.6} />
          </HeaderBtn>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="z-50 min-w-[190px] rounded-2xl border border-line bg-pane-2 p-1.5 shadow-2xl"
          >
            {tab.status !== 'draft' && (
              <>
                <DropdownMenu.Item
                  onSelect={onCopyLastResponse}
                  disabled={!canCopyLastResponse}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13.5px] text-ink-2 outline-none transition hover:bg-line-soft hover:text-ink focus:bg-line-soft focus:text-ink data-[disabled]:cursor-default data-[disabled]:opacity-45 data-[disabled]:hover:bg-transparent data-[disabled]:hover:text-ink-2"
                >
                  <Copy className="h-3.5 w-3.5 text-ink-4" strokeWidth={1.7} />
                  Copy last response
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={onCopyTranscript}
                  disabled={!canCopyTranscript}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13.5px] text-ink-2 outline-none transition hover:bg-line-soft hover:text-ink focus:bg-line-soft focus:text-ink data-[disabled]:cursor-default data-[disabled]:opacity-45 data-[disabled]:hover:bg-transparent data-[disabled]:hover:text-ink-2"
                >
                  <ScrollText className="h-3.5 w-3.5 text-ink-4" strokeWidth={1.7} />
                  Copy transcript
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={onForkSession}
                  disabled={!canForkSession}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13.5px] text-ink-2 outline-none transition hover:bg-line-soft hover:text-ink focus:bg-line-soft focus:text-ink data-[disabled]:cursor-default data-[disabled]:opacity-45 data-[disabled]:hover:bg-transparent data-[disabled]:hover:text-ink-2"
                >
                  <GitBranch className="h-3.5 w-3.5 text-ink-4" strokeWidth={1.7} />
                  Fork session
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={onTogglePinned}
                  disabled={!canTogglePinned}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13.5px] text-ink-2 outline-none transition hover:bg-line-soft hover:text-ink focus:bg-line-soft focus:text-ink data-[disabled]:cursor-default data-[disabled]:opacity-45 data-[disabled]:hover:bg-transparent data-[disabled]:hover:text-ink-2"
                >
                  <Pin className={cn('h-3.5 w-3.5', pinned ? 'text-accent' : 'text-ink-4')} strokeWidth={1.7} />
                  {pinned ? 'Unpin session' : 'Pin session'}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={onArchiveSession}
                  disabled={!canArchiveSession}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13.5px] text-ink-2 outline-none transition hover:bg-line-soft hover:text-ink focus:bg-line-soft focus:text-ink data-[disabled]:cursor-default data-[disabled]:opacity-45 data-[disabled]:hover:bg-transparent data-[disabled]:hover:text-ink-2"
                >
                  <Archive className="h-3.5 w-3.5 text-ink-4" strokeWidth={1.7} />
                  Archive session
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={() => setRenameOpen(true)}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13.5px] text-ink-2 outline-none transition hover:bg-line-soft hover:text-ink focus:bg-line-soft focus:text-ink"
                >
                  <Pencil className="h-3.5 w-3.5 text-ink-4" strokeWidth={1.7} />
                  Rename session
                </DropdownMenu.Item>
              </>
            )}
            <DropdownMenu.Item
              onSelect={() => void api.workspace.openPath(tab.workDir)}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13.5px] text-ink-2 outline-none transition hover:bg-line-soft hover:text-ink focus:bg-line-soft focus:text-ink"
            >
              <FolderOpen className="h-3.5 w-3.5 text-ink-4" strokeWidth={1.7} />
              Open workspace
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-line-soft" />
            <DropdownMenu.Item
              onSelect={onClose}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13.5px] text-ink-2 outline-none transition hover:bg-line-soft hover:text-ink focus:bg-line-soft focus:text-ink"
            >
              <X className="h-3.5 w-3.5 text-ink-4" strokeWidth={1.7} />
              {tab.status === 'draft' ? 'Discard draft' : 'Close session'}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <RenameSessionDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        tab={tab}
        onRenamed={onRenamed}
      />
    </>
  )
}

interface TranscriptCopyEntry {
  readonly type?: unknown
  readonly display?: unknown
  readonly content?: unknown
  readonly discarded?: unknown
  readonly tuiVisible?: unknown
}

function hasVisibleTranscript(entries: readonly unknown[]): boolean {
  return entries.some((entry) => {
    const item = entry as TranscriptCopyEntry | null
    if (!item || item.discarded || item.tuiVisible === false) return false
    return typeof item.display === 'string' && item.display.trim().length > 0 && isTranscriptCopyType(item.type)
  })
}

function formatSessionTranscriptMarkdown({
  entries,
  title,
  workDir,
}: {
  entries: readonly unknown[]
  title: string
  workDir: string
}): string {
  const sections = entries
    .map((entry) => formatTranscriptEntry(entry as TranscriptCopyEntry | null))
    .filter((section): section is string => Boolean(section))

  if (sections.length === 0) return ''
  return [
    `# ${title.trim() || 'Session transcript'}`,
    '',
    `Workspace: \`${workDir}\``,
    `Exported: ${new Date().toISOString()}`,
    '',
    ...sections,
  ].join('\n')
}

function formatTranscriptEntry(entry: TranscriptCopyEntry | null): string | null {
  if (!entry || entry.discarded || entry.tuiVisible === false || !isTranscriptCopyType(entry.type)) return null
  const text = getTranscriptEntryText(entry)
  if (!text) return null
  switch (entry.type) {
    case 'user_message':
      return `## User\n\n${text}\n`
    case 'assistant_text':
    case 'agent_result':
      return `## Assistant\n\n${text}\n`
    case 'reasoning':
      return `## Reasoning\n\n${text}\n`
    case 'tool_call':
      return `### Tool\n\n${text}\n`
    case 'tool_result':
      return `#### Tool Result\n\n${text}\n`
    case 'error':
      return `## Error\n\n${text}\n`
    default:
      return `> ${text.replace(/\n/g, '\n> ')}\n`
  }
}

function isTranscriptCopyType(type: unknown): boolean {
  return type === 'user_message' ||
    type === 'assistant_text' ||
    type === 'agent_result' ||
    type === 'reasoning' ||
    type === 'tool_call' ||
    type === 'tool_result' ||
    type === 'sub_agent_start' ||
    type === 'sub_agent_end' ||
    type === 'sub_agent_tool_call' ||
    type === 'compact_marker' ||
    type === 'status' ||
    type === 'error' ||
    type === 'interruption_marker'
}

function getTranscriptEntryText(entry: TranscriptCopyEntry): string {
  if (typeof entry.display === 'string') return entry.display.trim()
  if (typeof entry.content === 'string') return entry.content.trim()
  return ''
}

function RenameSessionDialog({
  open,
  onOpenChange,
  tab,
  onRenamed,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tab: SessionTab
  onRenamed: () => void
}): JSX.Element {
  const [value, setValue] = useState(tab.title ?? tab.displayName ?? projectName(tab.workDir))
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) setValue(tab.title ?? tab.displayName ?? projectName(tab.workDir))
  }, [open, tab.displayName, tab.title, tab.workDir])

  const submit = async (): Promise<void> => {
    const title = value.trim()
    if (!title || tab.status === 'draft' || saving) return
    setSaving(true)
    try {
      await api.rpc.request(tab.tabId, 'session.setTitle', { title })
      onRenamed()
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/35 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[420px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-pane-2 p-4 shadow-2xl">
          <Dialog.Title className="text-[16px] font-semibold text-ink">
            Rename session
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-[13px] text-ink-4">
            {projectName(tab.workDir)}
          </Dialog.Description>
          <input
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void submit()
              }
            }}
            aria-label="Session title"
            className="rename-title-input mt-3 h-9 w-full rounded-lg border border-line-soft bg-pane px-2.5 text-[14px] text-ink outline-none"
          />
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded px-3 py-1.5 text-[14px] font-medium text-ink-3 transition hover:bg-line-soft hover:text-ink"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!value.trim() || saving}
              className="rounded bg-ink px-3 py-1.5 text-[14px] font-medium text-pane transition hover:opacity-90 disabled:opacity-40"
            >
              Rename
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
