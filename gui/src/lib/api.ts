/**
 * Renderer-side typed wrapper over the preload bridge.
 * The preload script exposes `window.swarmflow`; we re-export it here with types
 * so the rest of the codebase can import a single api object.
 */
import type {
  CreateTabInput,
  ArchiveSessionInput,
  GitBulkActionInput,
  GitFileActionInput,
  GitFileDiffInput,
  GitStatus,
  McpServerInput,
  RpcEvent,
  SetSessionPinnedInput,
  SessionTab,
  SettingsDefaultsPatch,
  SettingsSnapshot,
  WorkspaceFileEntry,
  WorkspaceHistoryGroup,
  WorkspaceTextSearchInput,
  WorkspaceTextSearchResult,
} from '@shared/rpc.js'

interface SwarmflowApi {
  tabs: {
    list(): Promise<readonly SessionTab[]>
    create(input: CreateTabInput): Promise<SessionTab>
    close(tabId: string): Promise<void>
  }
  rpc: {
    request<T = unknown>(tabId: string, method: string, params?: unknown): Promise<T>
    onEvent(handler: (e: RpcEvent) => void): () => void
  }
  history: {
    listWorkspaces(): Promise<readonly WorkspaceHistoryGroup[]>
    archiveSession(input: ArchiveSessionInput): Promise<void>
    setSessionPinned(input: SetSessionPinnedInput): Promise<void>
  }
  workspace: {
    pickDirectory(): Promise<string | null>
    pickFiles(workDir: string): Promise<string[]>
    listFiles(workDir: string): Promise<readonly WorkspaceFileEntry[]>
    searchText(input: WorkspaceTextSearchInput): Promise<readonly WorkspaceTextSearchResult[]>
    openPath(workDir: string): Promise<void>
  }
  git: {
    status(workDir: string): Promise<GitStatus>
    diff(input: GitFileDiffInput): Promise<string>
    stage(input: GitFileActionInput): Promise<void>
    unstage(input: GitFileActionInput): Promise<void>
    stageAll(input: GitBulkActionInput): Promise<void>
    unstageAll(input: GitBulkActionInput): Promise<void>
  }
  settings: {
    get(): Promise<SettingsSnapshot>
    setAutoUpdate(enabled: boolean): Promise<SettingsSnapshot>
    upsertMcpServer(input: McpServerInput): Promise<SettingsSnapshot>
    deleteMcpServer(name: string): Promise<SettingsSnapshot>
    updateDefaults(patch: SettingsDefaultsPatch): Promise<SettingsSnapshot>
    openFile(): Promise<void>
  }
  theme: {
    getSystem(): Promise<'dark' | 'light'>
    onSystemChanged(handler: (theme: 'dark' | 'light') => void): () => void
  }
}

declare global {
  interface Window {
    swarmflow: SwarmflowApi
  }
}

export const api: SwarmflowApi = window.swarmflow
