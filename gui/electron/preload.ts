import { contextBridge, ipcRenderer } from 'electron'
import type {
  CreateTabInput,
  ArchiveSessionInput,
  GitBulkActionInput,
  GitFileActionInput,
  GitFileDiffInput,
  GitStatus,
  McpServerInput,
  RpcEvent,
  SettingsDefaultsPatch,
  SetSessionPinnedInput,
  SessionTab,
  SettingsSnapshot,
  WorkspaceFileEntry,
  WorkspaceHistoryGroup,
  WorkspaceTextSearchInput,
  WorkspaceTextSearchResult,
} from '../shared/rpc.js'

const api = {
  tabs: {
    list: (): Promise<readonly SessionTab[]> => ipcRenderer.invoke('tabs:list'),
    create: (input: CreateTabInput): Promise<SessionTab> => ipcRenderer.invoke('tabs:create', input),
    close: (tabId: string): Promise<void> => ipcRenderer.invoke('tabs:close', tabId),
  },
  rpc: {
    request: <T = unknown>(tabId: string, method: string, params?: unknown): Promise<T> =>
      ipcRenderer.invoke('rpc:request', { tabId, method, params }),
    onEvent: (handler: (e: RpcEvent) => void): (() => void) => {
      const listener = (_: unknown, e: RpcEvent) => handler(e)
      ipcRenderer.on('rpc:event', listener)
      return () => ipcRenderer.removeListener('rpc:event', listener)
    },
  },
  history: {
    listWorkspaces: (): Promise<readonly WorkspaceHistoryGroup[]> => ipcRenderer.invoke('history:listWorkspaces'),
    archiveSession: (input: ArchiveSessionInput): Promise<void> => ipcRenderer.invoke('history:archiveSession', input),
    setSessionPinned: (input: SetSessionPinnedInput): Promise<void> =>
      ipcRenderer.invoke('history:setSessionPinned', input),
  },
  workspace: {
    pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('workspace:pickDirectory'),
    pickFiles: (workDir: string): Promise<string[]> => ipcRenderer.invoke('workspace:pickFiles', workDir),
    listFiles: (workDir: string): Promise<readonly WorkspaceFileEntry[]> =>
      ipcRenderer.invoke('workspace:listFiles', workDir),
    searchText: (input: WorkspaceTextSearchInput): Promise<readonly WorkspaceTextSearchResult[]> =>
      ipcRenderer.invoke('workspace:searchText', input),
    openPath: (workDir: string): Promise<void> => ipcRenderer.invoke('workspace:openPath', workDir),
  },
  git: {
    status: (workDir: string): Promise<GitStatus> => ipcRenderer.invoke('git:status', workDir),
    diff: (input: GitFileDiffInput): Promise<string> => ipcRenderer.invoke('git:diff', input),
    stage: (input: GitFileActionInput): Promise<void> => ipcRenderer.invoke('git:stage', input),
    unstage: (input: GitFileActionInput): Promise<void> => ipcRenderer.invoke('git:unstage', input),
    stageAll: (input: GitBulkActionInput): Promise<void> => ipcRenderer.invoke('git:stageAll', input),
    unstageAll: (input: GitBulkActionInput): Promise<void> => ipcRenderer.invoke('git:unstageAll', input),
  },
  settings: {
    get: (): Promise<SettingsSnapshot> => ipcRenderer.invoke('settings:get'),
    setAutoUpdate: (enabled: boolean): Promise<SettingsSnapshot> =>
      ipcRenderer.invoke('settings:setAutoUpdate', enabled),
    upsertMcpServer: (input: McpServerInput): Promise<SettingsSnapshot> =>
      ipcRenderer.invoke('settings:upsertMcpServer', input),
    deleteMcpServer: (name: string): Promise<SettingsSnapshot> =>
      ipcRenderer.invoke('settings:deleteMcpServer', name),
    updateDefaults: (patch: SettingsDefaultsPatch): Promise<SettingsSnapshot> =>
      ipcRenderer.invoke('settings:updateDefaults', patch),
    openFile: (): Promise<void> => ipcRenderer.invoke('settings:openFile'),
  },
  theme: {
    getSystem: (): Promise<'dark' | 'light'> => ipcRenderer.invoke('theme:getSystem'),
    onSystemChanged: (handler: (theme: 'dark' | 'light') => void): (() => void) => {
      const listener = (_: unknown, t: 'dark' | 'light') => handler(t)
      ipcRenderer.on('theme:systemChanged', listener)
      return () => ipcRenderer.removeListener('theme:systemChanged', listener)
    },
  },
}

contextBridge.exposeInMainWorld('swarmflow', api)

export type SwarmflowApi = typeof api
