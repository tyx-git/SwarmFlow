/**
 * 渲染器状态存储（Zustand）。
 *
 * 数据流：
 *   init() → 订阅 rpc:event → handleEvent() 路由到 perTab
 *   刷新方法 → api.rpc.request() → SessionProcess → 子进程
 *
 * Tab 类型：
 *   - draft: 临时 Tab，未启动子进程，只有 workDir 和 selectedModel
 *   - starting: 子进程正在启动
 *   - ready: 正常运行
 *   - error: 启动失败
 *   - closed: 已关闭
 */

import { create } from 'zustand'
import { api } from '@/lib/api.js'
import type {
  ModelDescriptor,
  RpcEvent,
  SessionMeta,
  SessionStatus,
  SessionTab,
  WorkspaceHistoryGroup,
} from '@shared/rpc.js'

/** 单个 Tab 的运行时状态 */
export interface TabState {
  readonly meta: SessionMeta | null       // session.getMeta
  readonly status: SessionStatus | null  // 当前运行状态（token 计数、权限等）
  readonly logEntries: unknown[]         // session.getLogSnapshot
  readonly logRevision: number          // 日志版本号，用于检测变化
  readonly activeLogEntryId: string | null // 流式写入中的活动条目 ID
  readonly pendingAsk: { id: string; kind: string; summary: string } | null // 待批准的请求
  readonly models: readonly ModelDescriptor[]  // 可用模型
  readonly stderrLog: string[]           // stderr 诊断日志
}
}

interface SessionStoreState {
  readonly tabs: readonly SessionTab[]
  readonly activeTabId: string | null
  readonly perTab: Record<string, TabState>
  readonly theme: 'dark' | 'light'
  readonly markdownMode: 'rendered' | 'raw'
  readonly autoUpdate: boolean
  readonly history: readonly WorkspaceHistoryGroup[]
  readonly initialized: boolean
  readonly bootstrapped: boolean
  // Last known set of available models from any live tab. Drafts don't have
  // a subprocess yet, so we use this as a read-only fallback for their model
  // picker. Updated whenever refreshModels runs successfully.
  readonly globalModels: readonly ModelDescriptor[]

  init(): Promise<void>
  setTheme(theme: 'dark' | 'light'): void
  useSystemTheme(): Promise<void>
  setMarkdownMode(mode: 'rendered' | 'raw'): void
  toggleMarkdownMode(): void
  refreshSettings(): Promise<void>
  setAutoUpdate(enabled: boolean): Promise<void>
  refreshHistory(): Promise<void>
  createDraftTab(workDir: string): SessionTab
  createTab(workDir: string): Promise<SessionTab | null>
  openHistorySession(workDir: string, sessionId: string): Promise<SessionTab | null>
  archiveHistorySession(workDir: string, sessionId: string): Promise<void>
  setHistorySessionPinned(workDir: string, sessionId: string, pinned: boolean): Promise<void>
  closeTab(tabId: string): Promise<void>
  setActiveTab(tabId: string | null): void
  refreshMeta(tabId: string): Promise<void>
  refreshLog(tabId: string): Promise<void>
  refreshStatus(tabId: string): Promise<void>
  refreshModels(tabId: string): Promise<void>
  submitTurn(tabId: string, input: string): Promise<void>
  selectModel(tabId: string, modelName: string): Promise<void>
}

const emptyTabState: TabState = {
  meta: null,
  status: null,
  logEntries: [],
  logRevision: -1,
  activeLogEntryId: null,
  pendingAsk: null,
  models: [],
  stderrLog: [],
}

const ACTIVE_TAB_KEY = 'swarmflow:activeTabId'
const MARKDOWN_MODE_KEY = 'swarmflow:markdownMode'

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  perTab: {},
  theme: 'dark',
  markdownMode: readStoredMarkdownMode(),
  autoUpdate: true,
  history: [],
  initialized: false,
  bootstrapped: false,
  globalModels: [],

  async init() {
    if (get().initialized) return
    set({ initialized: true })

    // System theme
    try {
      const stored = localStorage.getItem('swarmflow:theme') as 'dark' | 'light' | null
      const theme = stored ?? (await api.theme.getSystem())
      set({ theme })
      document.documentElement.classList.toggle('dark', theme === 'dark')
      document.documentElement.dataset.theme = theme
    } catch {
      // ignore
    }

    api.theme.onSystemChanged((theme) => {
      // Only follow system if user hasn't pinned a theme.
      if (!localStorage.getItem('swarmflow:theme')) {
        get().setTheme(theme)
      }
    })

    void get().refreshSettings()
    void get().refreshHistory()

    api.rpc.onEvent((e) => {
      handleEvent(e)
    })

    // Restore existing tabs (after a renderer reload, the main process still
    // has live subprocesses we should re-attach to).
    const tabs = await api.tabs.list()
    const perTab = { ...get().perTab }
    for (const t of tabs) {
      perTab[t.tabId] = { ...emptyTabState }
    }
    const storedActiveTabId = readStoredActiveTabId()
    set({
      tabs,
      perTab,
      activeTabId:
        get().activeTabId ??
        (storedActiveTabId && tabs.some((t) => t.tabId === storedActiveTabId) ? storedActiveTabId : null) ??
        tabs[0]?.tabId ??
        null,
    })
    for (const t of tabs) {
      void get().refreshMeta(t.tabId)
      void get().refreshLog(t.tabId)
      void get().refreshStatus(t.tabId)
      void get().refreshModels(t.tabId)
    }
    set({ bootstrapped: true })
  },

  setTheme(theme) {
    set({ theme })
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('swarmflow:theme', theme)
    } catch {
      // ignore
    }
  },

  async useSystemTheme() {
    try {
      localStorage.removeItem('swarmflow:theme')
    } catch {
      // ignore
    }
    try {
      const theme = await api.theme.getSystem()
      set({ theme })
      document.documentElement.classList.toggle('dark', theme === 'dark')
      document.documentElement.dataset.theme = theme
    } catch {
      // ignore
    }
  },

  setMarkdownMode(markdownMode) {
    set({ markdownMode })
    try {
      localStorage.setItem(MARKDOWN_MODE_KEY, markdownMode)
    } catch {
      // ignore
    }
  },

  toggleMarkdownMode() {
    get().setMarkdownMode(get().markdownMode === 'rendered' ? 'raw' : 'rendered')
  },

  async refreshSettings() {
    try {
      const settings = await api.settings.get()
      set({ autoUpdate: settings.autoUpdate })
    } catch {
      // ignore
    }
  },

  async setAutoUpdate(enabled) {
    try {
      const settings = await api.settings.setAutoUpdate(enabled)
      set({ autoUpdate: settings.autoUpdate })
    } catch (err) {
      console.error('setAutoUpdate failed', err)
    }
  },

  async refreshHistory() {
    try {
      const history = await api.history.listWorkspaces()
      set({ history })
    } catch (err) {
      console.error('refreshHistory failed', err)
    }
  },

  createDraftTab(workDir) {
    const existing = get().tabs.find((tab) => tab.workDir === workDir && tab.status === 'draft')
    if (existing) {
      set({ activeTabId: existing.tabId })
      storeActiveTabId(existing.tabId)
      return existing
    }
    const now = Date.now()
    const tab: SessionTab = {
      tabId: `draft-${crypto.randomUUID()}`,
      workDir,
      sessionId: null,
      title: null,
      displayName: null,
      selectedModel: currentModelForWorkspace(get().tabs, workDir),
      modelProvider: null,
      createdAt: now,
      lastActiveAt: now,
      status: 'draft',
    }
    set({
      tabs: [...get().tabs, tab],
      activeTabId: tab.tabId,
      perTab: {
        ...get().perTab,
        [tab.tabId]: { ...emptyTabState },
      },
    })
    storeActiveTabId(tab.tabId)
    return tab
  },

  async createTab(workDir) {
    try {
      const tab = await api.tabs.create({ workDir })
      const tabs = [...get().tabs.filter((t) => t.tabId !== tab.tabId), tab]
      set({
        tabs,
        activeTabId: tab.tabId,
        perTab: {
          ...get().perTab,
          [tab.tabId]: { ...emptyTabState },
        },
      })
      storeActiveTabId(tab.tabId)
      // Eager-load meta / log / models
      void get().refreshMeta(tab.tabId)
      void get().refreshLog(tab.tabId)
      void get().refreshModels(tab.tabId)
      return tab
    } catch (err) {
      console.error('createTab failed', err)
      return null
    }
  },

  async openHistorySession(workDir, sessionId) {
    const existing = get().tabs.find((tab) => tab.sessionId === sessionId)
    if (existing) {
      set({ activeTabId: existing.tabId })
      storeActiveTabId(existing.tabId)
      return existing
    }

    const tab = await get().createTab(workDir)
    if (!tab) return null

    try {
      await api.rpc.request(tab.tabId, 'session.restoreSession', { sessionId })
      void get().refreshMeta(tab.tabId)
      void get().refreshLog(tab.tabId)
      void get().refreshStatus(tab.tabId)
      void get().refreshModels(tab.tabId)
      void get().refreshHistory()
      return tab
    } catch (err) {
      console.error('openHistorySession failed', err)
      await get().closeTab(tab.tabId)
      return null
    }
  },

  async archiveHistorySession(workDir, sessionId) {
    const openTab = get().tabs.find((tab) => tab.sessionId === sessionId)
    if (openTab) {
      await get().closeTab(openTab.tabId)
    }
    try {
      await api.history.archiveSession({ workDir, sessionId })
      await get().refreshHistory()
    } catch (err) {
      console.error('archiveHistorySession failed', err)
    }
  },

  async setHistorySessionPinned(workDir, sessionId, pinned) {
    try {
      await api.history.setSessionPinned({ workDir, sessionId, pinned })
      await get().refreshHistory()
    } catch (err) {
      console.error('setHistorySessionPinned failed', err)
    }
  },

  async closeTab(tabId) {
    const existing = get().tabs.find((tab) => tab.tabId === tabId)
    if (existing?.status !== 'draft') {
      try {
        await api.tabs.close(tabId)
      } catch (err) {
        console.error('closeTab failed', err)
      }
    }
    const tabs = get().tabs.filter((t) => t.tabId !== tabId)
    const perTab = { ...get().perTab }
    delete perTab[tabId]
    let activeTabId = get().activeTabId
    if (activeTabId === tabId) {
      activeTabId = tabs[0]?.tabId ?? null
    }
    set({ tabs, perTab, activeTabId })
    storeActiveTabId(activeTabId)
  },

  setActiveTab(tabId) {
    if (tabId) touchTab(set, get, tabId)
    set({ activeTabId: tabId })
    storeActiveTabId(tabId)
  },

  async refreshMeta(tabId) {
    if (get().tabs.find((tab) => tab.tabId === tabId)?.status === 'draft') return
    try {
      const meta = await api.rpc.request<SessionMeta>(tabId, 'session.getMeta')
      patchTabState(set, get, tabId, () => ({ meta }))
      patchTabSnapshot(set, get, tabId, () => ({
        sessionId: meta.sessionId,
        title: meta.title ?? null,
        displayName: meta.displayName,
        selectedModel: meta.modelConfigName,
        modelProvider: meta.modelProvider,
      }))
    } catch {
      // ignore
    }
  },

  async refreshLog(tabId) {
    if (get().tabs.find((tab) => tab.tabId === tabId)?.status === 'draft') return
    try {
      const result = await api.rpc.request<{
        revision: number
        entries: unknown[]
        activeLogEntryId: string | null
      }>(tabId, 'session.getLogSnapshot', {})
      patchTabState(set, get, tabId, () => ({
        logEntries: result.entries,
        logRevision: result.revision,
        activeLogEntryId: result.activeLogEntryId,
      }))
    } catch {
      // ignore
    }
  },

  async refreshStatus(tabId) {
    if (get().tabs.find((tab) => tab.tabId === tabId)?.status === 'draft') return
    try {
      const status = await api.rpc.request<SessionStatus>(tabId, 'session.getStatus')
      patchTabState(set, get, tabId, () => ({ status }))
    } catch {
      // ignore
    }
  },

  async refreshModels(tabId) {
    if (get().tabs.find((tab) => tab.tabId === tabId)?.status === 'draft') return
    try {
      const models = await api.rpc.request<readonly ModelDescriptor[]>(
        tabId,
        'session.listAvailableModels',
      )
      patchTabState(set, get, tabId, () => ({ models }))
      // Cache as global fallback for draft tabs to display in their picker.
      if (Array.isArray(models) && models.length > 0) {
        set({ globalModels: models })
      }
    } catch {
      // ignore
    }
  },

  async submitTurn(tabId, input) {
    if (!input.trim()) return
    try {
      const tab = get().tabs.find((item) => item.tabId === tabId)
      if (tab?.status === 'draft') {
        const realTab = await materializeDraftTab(set, get, tab)
        if (!realTab) return
        await api.rpc.request(realTab.tabId, 'session.submitTurn', { input })
        return
      }
      touchTab(set, get, tabId)
      await api.rpc.request(tabId, 'session.submitTurn', { input })
    } catch (err) {
      console.error('submitTurn failed', err)
    }
  },

  async selectModel(tabId, modelName) {
    const tab = get().tabs.find((item) => item.tabId === tabId)
    if (tab?.status === 'draft') {
      patchTabSnapshot(set, get, tabId, () => ({ selectedModel: modelName }))
      return
    }
    try {
      await api.rpc.request(tabId, 'session.selectModel', { name: modelName })
      void get().refreshMeta(tabId)
    } catch (err) {
      console.error('selectModel failed', err)
    }
  },
}))

// =============================================================================
// 辅助函数
// =============================================================================

/** 更新 perTab[tabId] 中的 TabState 字段 */
function patchTabState(
  set: (s: Partial<SessionStoreState>) => void,
  get: () => SessionStoreState,
  tabId: string,
  patch: (prev: TabState) => Partial<TabState>,
): void {
  const prev = get().perTab[tabId] ?? emptyTabState
  const next: TabState = { ...prev, ...patch(prev) }
  set({ perTab: { ...get().perTab, [tabId]: next } })
}

/** 将 draft Tab 转换为真实的子进程 Tab */
async function materializeDraftTab(
  set: (s: Partial<SessionStoreState>) => void,
  get: () => SessionStoreState,
  draft: SessionTab,
): Promise<SessionTab | null> {
  patchTabSnapshot(set, get, draft.tabId, () => ({ status: 'starting', lastActiveAt: Date.now() }))
  try {
    const realTab = await api.tabs.create({
      workDir: draft.workDir,
      selectedModel: draft.selectedModel ?? undefined,
    })
    const previousState = get().perTab[draft.tabId] ?? emptyTabState
    const tabs = get().tabs.map((tab) => (
      tab.tabId === draft.tabId
        ? { ...realTab, createdAt: draft.createdAt, lastActiveAt: Date.now() }
        : tab
    ))
    const perTab = { ...get().perTab }
    delete perTab[draft.tabId]
    perTab[realTab.tabId] = previousState
    set({ tabs, perTab, activeTabId: realTab.tabId })
    storeActiveTabId(realTab.tabId)
    void get().refreshMeta(realTab.tabId)
    void get().refreshLog(realTab.tabId)
    void get().refreshStatus(realTab.tabId)
    void get().refreshModels(realTab.tabId)
    return realTab
  } catch (err) {
    console.error('materializeDraftTab failed', err)
    patchTabSnapshot(set, get, draft.tabId, () => ({
      status: 'draft',
      errorMessage: err instanceof Error ? err.message : String(err),
    }))
    return null
  }
}

// =============================================================================
// handleEvent — RPC 事件处理器（由主进程 webContents.send 触发）
// =============================================================================

function handleEvent(e: RpcEvent): void {
  const { tabId, method, params } = e
  const store = useSessionStore.getState()

  switch (method) {
    // ── ready: 子进程启动完成，获取 sessionId、title、model 等元信息
    case 'ready': {
      touchTab(
        (s) => useSessionStore.setState(s),
        () => useSessionStore.getState(),
        tabId,
      )
      const meta = params as Partial<SessionMeta> & {
        selectedModel?: string
        sessionId?: string
      } | null
      if (meta) {
        patchTabSnapshot(
          (s) => useSessionStore.setState(s),
          () => useSessionStore.getState(),
          tabId,
          (tab) => ({
            sessionId: typeof meta.sessionId === 'string' ? meta.sessionId : tab.sessionId,
            title: typeof meta.title === 'string' ? meta.title : tab.title,
            displayName: typeof meta.displayName === 'string' ? meta.displayName : tab.displayName,
            selectedModel:
              typeof meta.selectedModel === 'string'
                ? meta.selectedModel
                : typeof meta.modelConfigName === 'string'
                  ? meta.modelConfigName
                  : tab.selectedModel,
            modelProvider: typeof meta.modelProvider === 'string' ? meta.modelProvider : tab.modelProvider,
            status: 'ready',
          }),
        )
      }
      // Tab subprocess fully booted — populate meta and log.
      void store.refreshMeta(tabId)
      void store.refreshLog(tabId)
      void store.refreshStatus(tabId)
      void store.refreshModels(tabId)
      break
    }
    // ── log.changed: 日志有更新，刷新 log 和 status
    case 'log.changed': {
      touchTab(
        (s) => useSessionStore.setState(s),
        () => useSessionStore.getState(),
        tabId,
      )
      const status = (params as { status?: SessionStatus })?.status
      void store.refreshLog(tabId)
      if (status) {
        patchTabState(
          (s) => useSessionStore.setState(s),
          () => useSessionStore.getState(),
          tabId,
          () => ({ status }),
        )
      } else {
        void store.refreshStatus(tabId)
      }
      break
    }
    // ── turn.started: 新的 turn 开始
    case 'turn.started': {
      touchTab(
        (s) => useSessionStore.setState(s),
        () => useSessionStore.getState(),
        tabId,
      )
      void store.refreshStatus(tabId)
      break
    }
    // ── turn.ended: turn 结束，更新状态并刷新历史
    case 'turn.ended': {
      const ended = params as { status?: unknown } | undefined
      patchTabState(
        (s) => useSessionStore.setState(s),
        () => useSessionStore.getState(),
        tabId,
        (prev) => prev.status
          ? {
              status: {
                ...prev.status,
                currentTurnRunning: false,
                sessionPhase: 'idle',
                activeLogEntryId: null,
                lastTurnEndStatus: typeof ended?.status === 'string'
                  ? ended.status
                  : prev.status.lastTurnEndStatus,
              },
              activeLogEntryId: null,
            }
          : {},
      )
      void store.refreshStatus(tabId)
      void store.refreshLog(tabId)
      void store.refreshHistory()
      break
    }
    // ── session.saved: 会话已保存，刷新历史
    case 'session.saved': {
      void store.refreshHistory()
      break
    }
    // ── ask.pending:有待批准的请求（工具执行等）
    case 'ask.pending': {
      const ask = params as { id: string; kind: string; summary: string }
      patchTabState(
        (s) => useSessionStore.setState(s),
        () => useSessionStore.getState(),
        tabId,
        () => ({ pendingAsk: ask }),
      )
      break
    }
    // ── ask.resolved: 批准请求已解决
    case 'ask.resolved': {
      patchTabState(
        (s) => useSessionStore.setState(s),
        () => useSessionStore.getState(),
        tabId,
        () => ({ pendingAsk: null }),
      )
      break
    }
    case 'plan.changed': {
      // Plan state updates — the renderer can pull on demand
      break
    }
    // ── model.changed: 模型变更
    case 'model.changed': {
      void store.refreshMeta(tabId)
      break
    }
    case 'permission.changed': {
      void store.refreshStatus(tabId)
      break
    }
    // ── server.stderr: stderr 输出（诊断）
    case 'server.stderr': {
      const text = (params as { text: string })?.text ?? ''
      patchTabState(
        (s) => useSessionStore.setState(s),
        () => useSessionStore.getState(),
        tabId,
        (prev) => ({ stderrLog: [...prev.stderrLog, text].slice(-100) }),
      )
      break
    }
    // ── tab.closed: Tab 被关闭
    case 'tab.closed': {
      const tabs = useSessionStore.getState().tabs.filter((t) => t.tabId !== tabId)
      const perTab = { ...useSessionStore.getState().perTab }
      delete perTab[tabId]
      let activeTabId = useSessionStore.getState().activeTabId
      if (activeTabId === tabId) activeTabId = tabs[0]?.tabId ?? null
      useSessionStore.setState({ tabs, perTab, activeTabId })
      storeActiveTabId(activeTabId)
      break
    }
    // ── tab.error: Tab 启动错误
    case 'tab.error': {
      // 将错误通过 stderrLog 显示
      const text = `[error] ${(params as { message: string })?.message ?? 'unknown'}\n`
      patchTabState(
        (s) => useSessionStore.setState(s),
        () => useSessionStore.getState(),
        tabId,
        (prev) => ({ stderrLog: [...prev.stderrLog, text].slice(-100) }),
      )
      break
    }
  }
}

/** 更新 tabs 数组中指定 tabId 的 SessionTab 快照 */
function patchTabSnapshot(
  set: (s: Partial<SessionStoreState>) => void,
  get: () => SessionStoreState,
  tabId: string,
  patch: (prev: SessionTab) => Partial<SessionTab>,
): void {
  const tabs = get().tabs.map((tab) => (
    tab.tabId === tabId ? { ...tab, ...patch(tab) } : tab
  ))
  set({ tabs })
}

/** 更新 Tab 的 lastActiveAt 时间戳 */
function touchTab(
  set: (s: Partial<SessionStoreState>) => void,
  get: () => SessionStoreState,
  tabId: string,
): void {
  patchTabSnapshot(set, get, tabId, () => ({ lastActiveAt: Date.now() }))
}

/** 获取工作区最近使用过的模型 */
function currentModelForWorkspace(tabs: readonly SessionTab[], workDir: string): string | null {
  const workspaceTab = [...tabs]
    .reverse()
    .find((tab) => tab.workDir === workDir && tab.selectedModel)
  if (workspaceTab?.selectedModel) return workspaceTab.selectedModel
  const anyTab = [...tabs].reverse().find((tab) => tab.selectedModel)
  return anyTab?.selectedModel ?? null
}

function readStoredActiveTabId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_TAB_KEY)
  } catch {
    return null
  }
}

function readStoredMarkdownMode(): 'rendered' | 'raw' {
  try {
    return localStorage.getItem(MARKDOWN_MODE_KEY) === 'raw' ? 'raw' : 'rendered'
  } catch {
    return 'rendered'
  }
}

function storeActiveTabId(tabId: string | null): void {
  try {
    if (tabId) localStorage.setItem(ACTIVE_TAB_KEY, tabId)
    else localStorage.removeItem(ACTIVE_TAB_KEY)
  } catch {
    // ignore
  }
}
