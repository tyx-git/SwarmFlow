/**
 * Shared types for the SwarmFlow GUI ↔ subprocess JSON-RPC.
 *
 * Mirrors src/server/rpc-transport.ts. Used by both the Electron main process
 * (which talks to the subprocess) and the renderer (which talks to main via
 * the preload bridge).
 */

export interface RpcEvent {
  readonly tabId: string
  readonly method: string
  readonly params?: unknown
}

export interface SessionTab {
  readonly tabId: string
  readonly workDir: string
  readonly sessionId: string | null
  readonly title: string | null
  readonly displayName: string | null
  readonly selectedModel: string | null
  readonly modelProvider: string | null
  readonly createdAt: number
  readonly lastActiveAt: number
  readonly status: 'draft' | 'starting' | 'ready' | 'error' | 'closed'
  readonly errorMessage?: string
}

export interface CreateTabInput {
  readonly workDir: string
  readonly selectedModel?: string
  readonly selectedAgent?: string
}

export interface SessionMeta {
  readonly sessionId: string
  readonly title: string | undefined
  readonly displayName: string
  readonly sessionDir: string | null
  readonly workDir: string
  readonly modelConfigName: string
  readonly modelProvider: string
  readonly thinkingLevel: string
  readonly accentColor: string | undefined
  readonly turnCount: number
}

export interface SessionHistoryItem {
  readonly sessionId: string
  readonly path: string
  readonly created: string
  readonly lastActiveAt: string
  readonly summary: string
  readonly title?: string
  readonly turns: number
  readonly pinned: boolean
}

export interface WorkspaceHistoryGroup {
  readonly workDir: string
  readonly slug: string
  readonly createdAt: string
  readonly lastActiveAt: string
  readonly sessions: readonly SessionHistoryItem[]
}

export interface WorkspaceFileEntry {
  readonly path: string
  readonly size: number
  readonly mtimeMs: number
}

export interface WorkspaceTextSearchInput {
  readonly workDir: string
  readonly query: string
}

export interface WorkspaceTextSearchResult {
  readonly path: string
  readonly line: number
  readonly column: number
  readonly text: string
}

export interface ArchiveSessionInput {
  readonly workDir: string
  readonly sessionId: string
}

export interface SetSessionPinnedInput {
  readonly workDir: string
  readonly sessionId: string
  readonly pinned: boolean
}

export type PermissionMode = 'read_only' | 'reversible' | 'yolo'

export interface SessionStatus {
  readonly currentTurnRunning: boolean
  readonly sessionPhase: string
  readonly lastTurnEndStatus: string | null
  readonly pendingInboxCount: number
  readonly lifetimeToolCallCount: number
  readonly lastToolCallSummary: string
  readonly lastInputTokens: number
  readonly lastTotalTokens: number
  readonly lastCacheReadTokens: number
  readonly contextBudget: number
  readonly activeLogEntryId: string | null
  readonly hasPendingTurn: boolean
  readonly permissionMode: PermissionMode
}

export interface ModelDescriptor {
  readonly name: string
  readonly provider: string
  readonly model: string
  readonly contextLength: number
  readonly supportsThinking: boolean
  readonly supportsMultimodal: boolean
  readonly tierThinkingLevels?: readonly string[]
}

export type ModelTierLevel = 'high' | 'medium' | 'low'

export interface ModelTierInfo {
  readonly level: ModelTierLevel
  readonly provider: string | null
  readonly selectionKey: string | null
  readonly modelId: string | null
  readonly thinkingLevel: string | null
  readonly configName: string | null
  readonly label: string
}

export interface ModelTierStatus {
  readonly tiers: readonly ModelTierInfo[]
}

export interface AgentRuntimeSettings {
  readonly subAgentInheritMcp: boolean
  readonly subAgentInheritHooks: boolean
  readonly agentModelPins: number
}

export interface AgentModelPinInfo {
  readonly name: string
  readonly description: string | null
  readonly provider: string | null
  readonly selectionKey: string | null
  readonly modelId: string | null
  readonly thinkingLevel: string | null
  readonly configName: string | null
  readonly label: string
}

export interface AgentModelPinsStatus {
  readonly templates: readonly AgentModelPinInfo[]
}

export interface GitFileChange {
  readonly path: string
  readonly originalPath?: string
  readonly staged: string
  readonly unstaged: string
  readonly stagedAdditions?: number | null
  readonly stagedDeletions?: number | null
  readonly unstagedAdditions?: number | null
  readonly unstagedDeletions?: number | null
}

export interface GitStatus {
  readonly isRepo: boolean
  readonly workDir: string
  readonly root: string | null
  readonly branch: string | null
  readonly upstream: string | null
  readonly ahead: number
  readonly behind: number
  readonly clean: boolean
  readonly files: readonly GitFileChange[]
  readonly error?: string
}

export interface GitFileActionInput {
  readonly workDir: string
  readonly path: string
}

export interface GitBulkActionInput {
  readonly workDir: string
}

export interface GitFileDiffInput {
  readonly workDir: string
  readonly path: string
  readonly staged: boolean
}

export interface SettingsSnapshot {
  readonly autoUpdate: boolean
  readonly settingsPath: string
  readonly providers: readonly ProviderSettingsItem[]
  readonly defaultModel: string | null
  readonly thinkingLevel: string | null
  readonly permissionMode: string | null
}

export interface SummarizeTarget {
  readonly kind: 'turn' | 'summary'
  readonly turnIndex: number
  readonly preview: string
  readonly timestamp: number
  readonly contextId?: string
}

export interface McpServerInput {
  readonly name: string
  readonly previousName?: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Record<string, string>
  readonly url?: string
}

export interface SettingsDefaultsPatch {
  readonly defaultModel?: string | null
  readonly thinkingLevel?: string | null
  readonly permissionMode?: string | null
}

export interface ProviderSettingsItem {
  readonly id: string
  readonly kind: 'cloud' | 'local' | 'invalid'
  readonly apiKeyEnv: string | null
  readonly hasEnvValue: boolean
  readonly baseUrl: string | null
  readonly model: string | null
  readonly contextLength: number | null
  readonly hasInlineKey: boolean
}
