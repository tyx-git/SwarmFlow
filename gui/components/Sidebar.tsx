/**
 * 左侧边栏：搜索栏 + 持久化的工作区/会话树 + 设置页脚。
 * 遵循模板：平面表面，带折叠箭头的项目分组，
 * 会话点（工作中为旋转器，通知时为强调色，空闲时为灰色）。
 */

import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  Archive,
  FolderOpen,
  KeyRound,
  Monitor,
  Moon,
  MoreHorizontal,
  Pin,
  Plus,
  PlugZap,
  Puzzle,
  RefreshCw,
  Search,
  Sliders,
  Sparkles,
  Sun,
  X,
  Zap,
  ChevronDown,
  type LucideIcon,
} from 'lucide-react'
import { useSessionStore } from '@/state/sessionStore.js'
import type { SessionHistoryItem, SessionTab } from '@shared/rpc.js'
import { cn } from '@/lib/cn.js'
import { api } from '@/lib/api.js'
import { projectName } from '@/lib/path.js'
import { SettingsDialog, type SettingsSection } from '@/components/SettingsDialog.js'

const SIDEBAR_GROUP_STATE_KEY = 'swarmflow:sidebarGroups'
const WORKSPACE_ORDER_KEY = 'swarmflow:workspaceOrder'
const WORKSPACE_ORDER_VERSION_KEY = 'swarmflow:workspaceOrderVersion'
const WORKSPACE_ORDER_VERSION = 'created-at-v1'

export function Sidebar(): JSX.Element {
  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const setActive = useSessionStore((s) => s.setActiveTab)
  const closeTab = useSessionStore((s) => s.closeTab)
  const createDraftTab = useSessionStore((s) => s.createDraftTab)
  const openHistorySession = useSessionStore((s) => s.openHistorySession)
  const archiveHistorySession = useSessionStore((s) => s.archiveHistorySession)
  const setHistorySessionPinned = useSessionStore((s) => s.setHistorySessionPinned)
  const perTab = useSessionStore((s) => s.perTab)
  const history = useSessionStore((s) => s.history)
  const theme = useSessionStore((s) => s.theme)
  const setTheme = useSessionStore((s) => s.setTheme)
  const useSystemTheme = useSessionStore((s) => s.useSystemTheme)
  const autoUpdate = useSessionStore((s) => s.autoUpdate)
  const setAutoUpdate = useSessionStore((s) => s.setAutoUpdate)
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  const trimmedQuery = query.trim()

  const activeTab = tabs.find((t) => t.tabId === activeTabId)
  const activeRuntimeTab = activeTab && activeTab.status !== 'draft' ? activeTab : null
  useEffect(() => {
    rememberWorkspaceOrder([
      ...history.map((group) => group.workDir),
      ...tabs.map((tab) => tab.workDir),
    ])
  }, [history, tabs])

  // ⌘, 打开设置 — Cursor / macOS 约定。
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.shiftKey || event.altKey || event.ctrlKey) return
      if (event.key !== ',') return
      event.preventDefault()
      setSettingsSection('general')
      setSettingsOpen(true)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const groups = buildWorkspaceGroups({ tabs, history, perTab, activeTabId, query: trimmedQuery })

  const onNewSession = async (workDir?: string): Promise<void> => {
    if (creating) return
    setCreating(true)
    try {
      const dir = workDir ?? await api.workspace.pickDirectory()
      if (!dir) return
      createDraftTab(dir)
    } finally {
      setCreating(false)
    }
  }

  // 侧边栏顶部的"新建会话"按钮：如果有活动工作区则复用，
  // 否则使用最近的工作区，否则打开选择器。
  // 与 ⌘N 快捷键一致，使用户可以一键获取草稿。
  const onQuickNewSession = async (): Promise<void> => {
    if (creating) return
    const activeWorkDir = activeTab?.workDir
    const fallbackWorkDir = history[0]?.workDir
    const dir = activeWorkDir ?? fallbackWorkDir
    if (dir) {
      createDraftTab(dir)
      return
    }
    await onNewSession()
  }

  return (
    <>
      <aside
        data-sidebar-root
        className="flex w-[256px] shrink-0 flex-col bg-rail"
        style={{ boxShadow: 'inset -1px 0 0 var(--color-line-soft)' }}
      >
      {/* Top-level actions */}
      <div className="px-2 pb-1 pt-3">
        <button
          type="button"
          onClick={() => void onQuickNewSession()}
          disabled={creating}
          className={cn(
            'group flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[14px] font-medium text-ink transition',
            'hover:bg-line-soft disabled:cursor-default disabled:opacity-55',
          )}
        >
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-accent/15 text-accent transition group-hover:bg-accent/25">
            <Plus className="h-3.5 w-3.5" strokeWidth={2.2} />
          </span>
          <span className="flex-1 truncate text-left">New session</span>
          <kbd className="mono shrink-0 rounded bg-line-soft px-1.5 py-0.5 text-[11px] font-medium text-ink-3 transition group-hover:bg-pane-2">
            ⌘N
          </kbd>
        </button>
      </div>

      {/* Search */}
      <div className="px-2.5 pb-2.5 pt-1">
        <div className="input-focus-shell flex h-9 items-center gap-2 rounded-lg border border-line-soft bg-pane-2 px-3">
          <Search className="h-3.5 w-3.5 shrink-0 text-ink-4" strokeWidth={2} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search sessions"
            placeholder="Search sessions"
            className="sidebar-search-input flex-1 bg-transparent text-[14.5px] text-ink outline-none placeholder:text-ink-3"
          />
          {query.length > 0 && (
            <button
              type="button"
              onClick={() => setQuery('')}
              title="Clear search"
              aria-label="Clear search"
              className="grid h-7 w-7 shrink-0 place-items-center rounded text-ink-4 transition hover:bg-line-soft hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Project tree */}
      <div className="session-scroll flex-1 overflow-y-auto pt-1">
        {groups.length === 0 ? (
          <div className="px-4 py-6 text-[14px] text-ink-3">
            {trimmedQuery ? 'No matches' : 'No sessions'}
          </div>
        ) : (
          groups.map(([workDir, items]) => (
            <ProjectGroup
              key={workDir}
              workDir={workDir}
              items={items}
              activeTabId={activeTabId}
              perTab={perTab}
              onSelect={setActive}
              onClose={closeTab}
              onOpenHistory={openHistorySession}
              onArchiveHistory={archiveHistorySession}
              onPinHistory={setHistorySessionPinned}
              onNewSession={onNewSession}
              creating={creating}
            />
          ))
        )}
      </div>

      {/* Settings footer */}
      <div className="border-t border-line-soft px-3 py-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void onNewSession()}
            disabled={creating}
            title="Open workspace"
            aria-label="Open workspace"
            className={cn(
              'grid h-8 w-8 shrink-0 place-items-center rounded text-ink-3 transition',
              'hover:bg-line-soft hover:text-ink',
              creating && 'opacity-50',
            )}
          >
            <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.8} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-medium leading-tight text-ink-2">
              Local workspaces
            </div>
            <div className="truncate text-[12.5px] leading-tight text-ink-4">
              User API keys
            </div>
          </div>
          <FooterMenu
            activeTab={activeTab ?? null}
            theme={theme}
            setTheme={setTheme}
            useSystemTheme={useSystemTheme}
            autoUpdate={autoUpdate}
            setAutoUpdate={setAutoUpdate}
            onNewSession={() => void onNewSession()}
            onOpenSettings={(section) => {
              setSettingsSection(section ?? 'general')
              setSettingsOpen(true)
            }}
          />
        </div>
      </div>
      </aside>
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        initialSection={settingsSection}
        tab={activeRuntimeTab}
      />
    </>
  )
}

function FooterMenu({
  activeTab,
  theme,
  setTheme,
  useSystemTheme,
  autoUpdate,
  setAutoUpdate,
  onNewSession,
  onOpenSettings,
}: {
  activeTab: SessionTab | null
  theme: 'dark' | 'light'
  setTheme: (theme: 'dark' | 'light') => void
  useSystemTheme: () => Promise<void>
  autoUpdate: boolean
  setAutoUpdate: (enabled: boolean) => Promise<void>
  onNewSession: () => void
  onOpenSettings: (section?: SettingsSection) => void
}): JSX.Element {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="grid h-8 w-8 place-items-center rounded text-ink-3 transition hover:bg-line-soft hover:text-ink"
          title="Settings"
          aria-label="Settings"
        >
          <MoreHorizontal className="h-3.5 w-3.5" strokeWidth={1.6} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          side="top"
          sideOffset={8}
          className="z-50 min-w-[220px] rounded-xl border border-line bg-pane-2 p-1.5 shadow-2xl"
        >
          <FooterMenuItem icon={Plus} label="New session" onSelect={onNewSession} />
          {activeTab && (
            <FooterMenuItem
              icon={FolderOpen}
              label="Open workspace"
              onSelect={() => void api.workspace.openPath(activeTab.workDir)}
            />
          )}
          <DropdownMenu.Separator className="my-1 h-px bg-line-soft" />
          <FooterMenuItem
            icon={Sliders}
            label="Settings"
            keyHint="⌘,"
            onSelect={() => onOpenSettings('general')}
          />
          <FooterMenuItem
            icon={Sparkles}
            label="Models"
            onSelect={() => onOpenSettings('models')}
          />
          <FooterMenuItem
            icon={KeyRound}
            label="Providers"
            onSelect={() => onOpenSettings('providers')}
          />
          <FooterMenuItem
            icon={Puzzle}
            label="Skills"
            onSelect={() => onOpenSettings('skills')}
          />
          <FooterMenuItem
            icon={PlugZap}
            label="MCP Servers"
            onSelect={() => onOpenSettings('mcp')}
          />
          <FooterMenuItem
            icon={Zap}
            label="Hooks"
            onSelect={() => onOpenSettings('hooks')}
          />
          <DropdownMenu.Separator className="my-1 h-px bg-line-soft" />
          <FooterMenuItem
            icon={theme === 'dark' ? Sun : Moon}
            label={theme === 'dark' ? 'Light theme' : 'Dark theme'}
            onSelect={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          />
          <FooterMenuItem
            icon={Monitor}
            label="Follow system theme"
            onSelect={() => void useSystemTheme()}
          />
          <DropdownMenu.Separator className="my-1 h-px bg-line-soft" />
          <FooterMenuItem
            icon={RefreshCw}
            label={autoUpdate ? 'Auto-update off' : 'Auto-update on'}
            onSelect={() => void setAutoUpdate(!autoUpdate)}
          />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function FooterMenuItem({
  icon: Icon,
  label,
  disabled,
  keyHint,
  onSelect,
}: {
  icon: LucideIcon
  label: string
  disabled?: boolean
  keyHint?: string
  onSelect: () => void
}): JSX.Element {
  return (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13.5px] text-ink-2 outline-none transition hover:bg-line-soft hover:text-ink focus:bg-line-soft focus:text-ink data-[disabled]:cursor-default data-[disabled]:opacity-45 data-[disabled]:hover:bg-transparent data-[disabled]:hover:text-ink-2"
    >
      <Icon className="h-3.5 w-3.5 text-ink-4" strokeWidth={1.7} />
      <span className="flex-1">{label}</span>
      {keyHint && (
        <span className="mono shrink-0 text-[11px] text-ink-4">{keyHint}</span>
      )}
    </DropdownMenu.Item>
  )
}

function ProjectGroup({
  workDir,
  items,
  activeTabId,
  perTab,
  onSelect,
  onClose,
  onOpenHistory,
  onArchiveHistory,
  onPinHistory,
  onNewSession,
  creating,
}: {
  workDir: string
  items: SidebarSessionItem[]
  activeTabId: string | null
  perTab: ReturnType<typeof useSessionStore.getState>['perTab']
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onOpenHistory: (workDir: string, sessionId: string) => Promise<SessionTab | null>
  onArchiveHistory: (workDir: string, sessionId: string) => Promise<void>
  onPinHistory: (workDir: string, sessionId: string, pinned: boolean) => Promise<void>
  onNewSession: (workDir?: string) => Promise<void>
  creating: boolean
}): JSX.Element {
  const [expanded, setExpanded] = useState(() => readSidebarGroupExpanded(workDir))
  const [showAll, setShowAll] = useState(false)
  const name = projectName(workDir)
  const visibleItems = showAll ? items : items.slice(0, 5)

  useEffect(() => {
    storeSidebarGroupExpanded(workDir, expanded)
  }, [expanded, workDir])

  return (
    <div className="group/workspace mb-1">
      <div className="flex h-7 items-center gap-1.5 px-3.5 text-ink-3">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${name} sessions`}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left transition hover:text-ink"
        >
          <ChevronDown
            className={cn('h-3 w-3 shrink-0 opacity-80 transition-transform', !expanded && '-rotate-90')}
            strokeWidth={2}
          />
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink-3">
            {name}
          </span>
        </button>
        <button
          type="button"
          disabled={creating}
          onClick={() => void onNewSession(workDir)}
          title={`New session in ${name}`}
          aria-label={`New session in ${name}`}
          className={cn(
            'grid h-6 w-6 shrink-0 place-items-center rounded-md text-ink-3 opacity-0 transition',
            'hover:bg-line-soft hover:text-ink focus-visible:opacity-100 group-hover/workspace:opacity-100',
            creating && 'opacity-40',
          )}
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>

      {expanded && (
        <div className="flex flex-col">
          {visibleItems.map((item) => {
            const tab = item.kind === 'tab' ? item.tab : null
            const active = tab?.tabId === activeTabId
            const state = tab ? perTab[tab.tabId] : undefined
            const status = state?.status
            const isWorking = status?.currentTurnRunning ?? false
            const hasAsk = !!state?.pendingAsk
            const label = sessionLabel(item)
            const sessionId = item.kind === 'tab'
              ? item.tab.sessionId ?? perTab[item.tab.tabId]?.meta?.sessionId ?? null
              : item.session.sessionId
            const pinned = isPinnedSessionItem(item)
            const canPin = !!sessionId && (item.kind === 'history' || item.tab.status !== 'draft')

            return (
              <div
                key={item.key}
                className="group relative mx-2 my-px h-9"
              >
                <button
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  aria-label={`${active ? 'Current session' : 'Switch to session'} ${label}`}
                  onClick={() => {
                    if (item.kind === 'tab') {
                      onSelect(item.tab.tabId)
                    } else {
                      void onOpenHistory(item.workDir, item.session.sessionId)
                    }
                  }}
                  className={cn(
                    'flex h-9 w-full cursor-pointer items-center rounded pl-7 pr-10 text-left transition',
                    active
                      ? 'bg-pane-2 text-ink'
                      : 'text-ink-2 hover:bg-line-soft hover:text-ink',
                  )}
                >
                  {/* 状态点——当可以固定时，在悬停时让位给固定按钮 */}
                  <span
                    className={cn(
                      'absolute left-3 top-1/2 -translate-y-1/2',
                      canPin && !isWorking && !hasAsk && 'group-hover:opacity-0',
                    )}
                  >
                    {isWorking ? (
                      <span className="working-spinner" />
                    ) : hasAsk ? (
                      <span className="block h-1.5 w-1.5 rounded-full bg-accent" />
                    ) : (
                      <span
                        className={cn(
                          'block h-1.5 w-1.5 rounded-full',
                          active ? 'bg-ink-3' : 'bg-ink-4',
                        )}
                      />
                    )}
                  </span>

                  <span
                    className={cn(
                      'flex-1 truncate text-[14.5px] leading-tight',
                      active ? 'font-medium' : 'font-normal',
                    )}
                  >
                    {label}
                  </span>
                </button>

                <span
                  className={cn(
                    'pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] tabular-nums text-ink-4 transition-opacity group-hover:opacity-0',
                    active && 'opacity-0',
                  )}
                >
                  {timeAgo(item.lastActiveAt)}
                </span>

                {canPin && sessionId && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      void onPinHistory(item.workDir, sessionId, !pinned)
                    }}
                    className={cn(
                      // 与状态点位于同一列（left-3 / w-5），
                      // 这样标题文本永远不需要让出空间。没有厚重的背景——
                      // 那正是重叠的根源。
                      'invisible absolute left-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-ink-4 transition',
                      'hover:text-ink group-hover:visible',
                      pinned && 'text-accent',
                    )}
                    aria-label={`${pinned ? 'Unpin' : 'Pin'} ${label}`}
                    title={pinned ? 'Unpin session' : 'Pin session'}
                  >
                    <Pin className="h-3 w-3" strokeWidth={1.8} />
                  </button>
                )}
                {tab ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      void onClose(tab.tabId)
                    }}
                    className={cn(
                      'invisible absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-ink-3 transition',
                      'hover:bg-line-soft hover:text-ink group-hover:visible',
                      active && 'visible',
                    )}
                    aria-label={`Close ${label}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : item.kind === 'history' ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      void onArchiveHistory(item.workDir, item.session.sessionId)
                    }}
                    className="invisible absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-ink-3 transition hover:bg-line-soft hover:text-ink group-hover:visible"
                    aria-label={`Archive ${label}`}
                    title="Archive session"
                  >
                    <Archive className="h-3.5 w-3.5" strokeWidth={1.8} />
                  </button>
                ) : null}
              </div>
            )
          })}
          {items.length > 5 && (
            <button
              type="button"
              onClick={() => setShowAll((value) => !value)}
              className="group mx-2 mt-0.5 flex h-8 items-center gap-1.5 rounded pl-7 pr-3 text-left text-[13px] text-ink-4 transition hover:bg-line-soft hover:text-ink-2"
            >
              <ChevronDown
                className={cn('h-3 w-3 transition-transform', !showAll && '-rotate-90')}
                strokeWidth={2}
              />
              <span>
                {showAll ? 'Show fewer' : `Show all ${items.length}`}
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

type SidebarSessionItem = SidebarTabItem | SidebarHistoryItem

interface SidebarTabItem {
  readonly key: string
  readonly kind: 'tab'
  readonly workDir: string
  readonly tab: SessionTab
  readonly historyTitle?: string
  readonly historySummary?: string
  readonly historyPinned?: boolean
  readonly lastActiveAt: number
}

interface SidebarHistoryItem {
  readonly key: string
  readonly kind: 'history'
  readonly workDir: string
  readonly session: SessionHistoryItem
  readonly lastActiveAt: number
}

function sessionLabel(item: SidebarSessionItem): string {
  const raw = item.kind === 'tab' && item.tab.status === 'draft'
    ? 'New session'
    : item.kind === 'tab'
    ? item.historyTitle || item.tab?.title || item.tab?.displayName || 'New session'
    : item.session?.title || item.session?.summary || shortSessionId(item.session?.sessionId ?? '') || 'New session'
  return raw.length > 42 ? `${raw.slice(0, 39)}…` : raw
}

function isPinnedSessionItem(item: SidebarSessionItem): boolean {
  return item.kind === 'tab' ? item.historyPinned === true : item.session.pinned
}

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000)
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

function buildWorkspaceGroups({
  tabs,
  history,
  perTab,
  activeTabId,
  query,
}: {
  tabs: readonly SessionTab[]
  history: ReturnType<typeof useSessionStore.getState>['history']
  perTab: ReturnType<typeof useSessionStore.getState>['perTab']
  activeTabId: string | null
  query: string
}): Array<[string, SidebarSessionItem[]]> {
  const map = new Map<string, SidebarSessionItem[]>()
  const historyBySessionId = new Map<string, SessionHistoryItem>()
  const openSessionIds = new Set<string>()
  const lowerQuery = query.toLowerCase()

  for (const group of history) {
    if (!map.has(group.workDir)) map.set(group.workDir, [])
    for (const session of group.sessions) {
      historyBySessionId.set(session.sessionId, session)
    }
  }

  for (const tab of tabs) {
    if (!map.has(tab.workDir)) map.set(tab.workDir, [])

    const sessionId = tab.sessionId ?? perTab[tab.tabId]?.meta?.sessionId ?? null
    if (sessionId) openSessionIds.add(sessionId)
    const linkedHistory = sessionId ? historyBySessionId.get(sessionId) : undefined
    const item: SidebarSessionItem = {
      key: `tab:${tab.tabId}`,
      kind: 'tab',
      workDir: tab.workDir,
      tab,
      historyTitle: linkedHistory?.title,
      historySummary: linkedHistory?.summary,
      historyPinned: linkedHistory?.pinned,
      lastActiveAt: Math.max(tab.lastActiveAt ?? tab.createdAt, parseHistoryTime(linkedHistory?.lastActiveAt)),
    }
    if (matchesSessionItem(item, lowerQuery)) {
      map.get(tab.workDir)?.push(item)
    }
  }

  for (const group of history) {
    const arr = map.get(group.workDir) ?? []
    for (const session of group.sessions) {
      if (openSessionIds.has(session.sessionId)) continue
      const item: SidebarSessionItem = {
        key: `history:${session.sessionId}`,
        kind: 'history',
        workDir: group.workDir,
        session,
        lastActiveAt: parseHistoryTime(session.lastActiveAt) || parseHistoryTime(session.created),
      }
      if (matchesSessionItem(item, lowerQuery)) arr.push(item)
    }
    map.set(group.workDir, arr)
  }

  const groups = [...map.entries()]
    .map(([k, v]) => [k, [...v].sort(compareSidebarSessionItems)] as [string, SidebarSessionItem[]])
    .filter(([workDir, items]) => items.length > 0 || tabs.some((tab) => tab.workDir === workDir && tab.tabId === activeTabId))

  return sortWorkspaceGroups(groups)
}

function compareSidebarSessionItems(a: SidebarSessionItem, b: SidebarSessionItem): number {
  const ap = isPinnedSessionItem(a)
  const bp = isPinnedSessionItem(b)
  if (ap !== bp) return ap ? -1 : 1
  return b.lastActiveAt - a.lastActiveAt
}

function matchesSessionItem(item: SidebarSessionItem, query: string): boolean {
  if (!query) return true
  const hay = item.kind === 'tab'
    ? [
        item.tab?.title,
        item.tab?.displayName,
        item.tab?.workDir,
        item.historyTitle,
        item.historySummary,
        item.tab?.sessionId,
      ]
    : [
        item.session?.title,
        item.session?.summary,
        item.session?.sessionId,
        item.workDir,
      ]
  return hay
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')
    .toLowerCase()
    .includes(query)
}

function parseHistoryTime(value: string | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function shortSessionId(sessionId: string): string {
  return sessionId ? sessionId.slice(0, 8) : ''
}

function sortWorkspaceGroups(groups: Array<[string, SidebarSessionItem[]]>): Array<[string, SidebarSessionItem[]]> {
  const order = readWorkspaceOrder()
  return [...groups].sort(([a], [b]) => {
    const ai = order.indexOf(a)
    const bi = order.indexOf(b)
    if (ai === -1 && bi === -1) return 0
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })
}

function rememberWorkspaceOrder(workDirs: readonly string[]): void {
  try {
    const storedVersion = window.localStorage.getItem(WORKSPACE_ORDER_VERSION_KEY)
    const order = storedVersion === WORKSPACE_ORDER_VERSION ? readWorkspaceOrder() : []
    let changed = false
    for (const workDir of workDirs) {
      if (order.includes(workDir)) continue
      order.push(workDir)
      changed = true
    }
    if (changed) {
      window.localStorage.setItem(WORKSPACE_ORDER_KEY, JSON.stringify(order))
    }
    if (storedVersion !== WORKSPACE_ORDER_VERSION) {
      window.localStorage.setItem(WORKSPACE_ORDER_VERSION_KEY, WORKSPACE_ORDER_VERSION)
    }
  } catch {
    /* localStorage 在加固环境中可能不可用。 */
  }
}

function readWorkspaceOrder(): string[] {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_ORDER_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function readSidebarGroupExpanded(workDir: string): boolean {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_GROUP_STATE_KEY)
    if (!raw) return true
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return true
    const value = (parsed as Record<string, unknown>)[workDir]
    return typeof value === 'boolean' ? value : true
  } catch {
    return true
  }
}

function storeSidebarGroupExpanded(workDir: string, expanded: boolean): void {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_GROUP_STATE_KEY)
    const parsed = raw ? JSON.parse(raw) as unknown : {}
    const next = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
    next[workDir] = expanded
    window.localStorage.setItem(SIDEBAR_GROUP_STATE_KEY, JSON.stringify(next))
  } catch {
    /* localStorage 在加固环境中可能不可用。 */
  }
}
