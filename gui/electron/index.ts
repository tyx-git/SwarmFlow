import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { SessionManager } from './sessionManager.js'
import type {
  ArchiveSessionInput,
  GitBulkActionInput,
  GitFileActionInput,
  GitFileChange,
  GitFileDiffInput,
  GitStatus,
  McpServerInput,
  ProviderSettingsItem,
  SettingsDefaultsPatch,
  SetSessionPinnedInput,
  SessionHistoryItem,
  SettingsSnapshot,
  WorkspaceFileEntry,
  WorkspaceTextSearchInput,
  WorkspaceTextSearchResult,
  WorkspaceHistoryGroup,
} from '../shared/rpc.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DEV = !app.isPackaged
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL ?? 'http://localhost:5174'
const execFileAsync = promisify(execFile)

// Expose CDP in dev so the Claude electron skill / agent-browser can attach.
if (DEV) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

let mainWindow: BrowserWindow | null = null
const manager = new SessionManager()

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#0b0b10',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => undefined)
    return { action: 'deny' }
  })

  manager.bindWebContents(mainWindow.webContents)

  if (DEV) {
    mainWindow.loadURL(DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  await manager.closeAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  await manager.closeAll()
})

function registerIpc(): void {
  ipcMain.handle('tabs:list', () => manager.listTabs())

  ipcMain.handle('tabs:create', async (_e, input: { workDir: string; selectedModel?: string; selectedAgent?: string }) => {
    return manager.createTab(input)
  })

  ipcMain.handle('tabs:close', async (_e, tabId: string) => {
    await manager.closeTab(tabId)
  })

  ipcMain.handle('rpc:request', async (_e, args: { tabId: string; method: string; params?: unknown }) => {
    return manager.request(args.tabId, args.method, args.params)
  })

  ipcMain.handle('history:listWorkspaces', () => listWorkspaceHistory())

  ipcMain.handle('history:archiveSession', (_e, input: ArchiveSessionInput) => {
    archiveSessionHistory(input)
  })

  ipcMain.handle('history:setSessionPinned', (_e, input: SetSessionPinnedInput) => {
    setSessionPinned(input)
  })

  ipcMain.handle('workspace:pickDirectory', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose a workspace directory',
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  ipcMain.handle('workspace:pickFiles', async (_e, workDir: string) => {
    const res = await dialog.showOpenDialog({
      defaultPath: workDir,
      properties: ['openFile', 'multiSelections'],
      title: 'Attach files',
    })
    if (res.canceled || res.filePaths.length === 0) return []
    return res.filePaths
  })

  ipcMain.handle('workspace:listFiles', async (_e, workDir: string) => {
    return listWorkspaceFiles(workDir)
  })

  ipcMain.handle('workspace:searchText', async (_e, input: WorkspaceTextSearchInput) => {
    return searchWorkspaceText(input)
  })

  ipcMain.handle('workspace:openPath', async (_e, workDir: string) => {
    const err = await shell.openPath(workDir)
    if (err) throw new Error(err)
  })

  ipcMain.handle('git:status', async (_e, workDir: string) => {
    return readGitStatus(workDir)
  })

  ipcMain.handle('git:diff', async (_e, input: GitFileDiffInput) => {
    return readGitFileDiff(input)
  })

  ipcMain.handle('git:stage', async (_e, input: GitFileActionInput) => {
    await execGit(input.workDir, ['add', '--', input.path])
  })

  ipcMain.handle('git:unstage', async (_e, input: GitFileActionInput) => {
    await unstageGitFile(input)
  })

  ipcMain.handle('git:stageAll', async (_e, input: GitBulkActionInput) => {
    await execGit(input.workDir, ['add', '-A', '--'])
  })

  ipcMain.handle('git:unstageAll', async (_e, input: GitBulkActionInput) => {
    await unstageAllGitFiles(input)
  })

  ipcMain.handle('settings:get', () => readSettingsSnapshot())

  ipcMain.handle('settings:setAutoUpdate', (_e, enabled: boolean) => {
    writeGlobalSettingsPatch({ auto_update: enabled })
    return readSettingsSnapshot()
  })

  ipcMain.handle('settings:upsertMcpServer', (_e, input: McpServerInput) => {
    upsertMcpServer(input)
    return readSettingsSnapshot()
  })

  ipcMain.handle('settings:updateDefaults', (_e, patch: SettingsDefaultsPatch) => {
    const update: Record<string, unknown> = {}
    if ('defaultModel' in patch) {
      const v = patch.defaultModel
      if (v === null || v === undefined || v === '') update.default_model = null
      else update.default_model = String(v)
    }
    if ('thinkingLevel' in patch) {
      const v = patch.thinkingLevel
      if (v === null || v === undefined || v === '') update.thinking_level = null
      else update.thinking_level = String(v)
    }
    if ('permissionMode' in patch) {
      const v = patch.permissionMode
      if (v === null || v === undefined || v === '') update.permission_mode = null
      else update.permission_mode = String(v)
    }
    // Strip null values so they don't pollute the JSON.
    const merged = { ...readGlobalSettings() } as Record<string, unknown>
    for (const [k, v] of Object.entries(update)) {
      if (v === null) delete merged[k]
      else merged[k] = v
    }
    const file = globalSettingsPath()
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(merged, null, 2))
    renameSync(tmp, file)
    return readSettingsSnapshot()
  })

  ipcMain.handle('settings:deleteMcpServer', (_e, name: string) => {
    deleteMcpServer(name)
    return readSettingsSnapshot()
  })

  ipcMain.handle('settings:openFile', async () => {
    ensureGlobalSettingsFile()
    const err = await shell.openPath(globalSettingsPath())
    if (err) throw new Error(err)
  })

  ipcMain.handle('theme:getSystem', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'))
  nativeTheme.on('updated', () => {
    mainWindow?.webContents.send('theme:systemChanged', nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  })
}

function readSettingsSnapshot(): SettingsSnapshot {
  const settings = readGlobalSettings()
  const providers = readProviderSettings(settings)
  return {
    autoUpdate: settings.auto_update !== false,
    settingsPath: globalSettingsPath(),
    providers,
    defaultModel: typeof settings.default_model === 'string' ? settings.default_model : null,
    thinkingLevel: typeof settings.thinking_level === 'string' ? settings.thinking_level : null,
    permissionMode: typeof settings.permission_mode === 'string' ? settings.permission_mode : null,
  }
}

function readGlobalSettings(): Record<string, unknown> & { auto_update?: boolean } {
  const file = globalSettingsPath()
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(stripJsoncComments(readFileSync(file, 'utf-8'))) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> & { auto_update?: boolean }
      : {}
  } catch {
    return {}
  }
}

function writeGlobalSettingsPatch(patch: Record<string, unknown>): void {
  const file = globalSettingsPath()
  const next = { ...readGlobalSettings(), ...patch }
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2))
  renameSync(tmp, file)
}

function upsertMcpServer(input: McpServerInput): void {
  const name = input.name.trim()
  if (!name) throw new Error('Server name is required')
  if (!input.command && !input.url) throw new Error('Either command or url must be provided')
  const settings = readGlobalSettings()
  const current = (settings.mcpServers && typeof settings.mcpServers === 'object'
    ? settings.mcpServers as Record<string, unknown>
    : {})
  const next: Record<string, unknown> = { ...current }
  if (input.previousName && input.previousName !== name) {
    delete next[input.previousName]
  }
  const entry: Record<string, unknown> = {}
  if (input.command) entry.command = input.command
  if (input.args && input.args.length > 0) entry.args = input.args
  if (input.env && Object.keys(input.env).length > 0) entry.env = input.env
  if (input.url) entry.url = input.url
  next[name] = entry
  writeGlobalSettingsPatch({ mcpServers: next })
}

function deleteMcpServer(name: string): void {
  const settings = readGlobalSettings()
  const current = settings.mcpServers && typeof settings.mcpServers === 'object'
    ? settings.mcpServers as Record<string, unknown>
    : {}
  if (!(name in current)) return
  const next = { ...current }
  delete next[name]
  writeGlobalSettingsPatch({ mcpServers: next })
}

function ensureGlobalSettingsFile(): void {
  const file = globalSettingsPath()
  if (existsSync(file)) return
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, "{}\n")
}

function readProviderSettings(settings: Record<string, unknown>): ProviderSettingsItem[] {
  const providers = settings.providers
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return []
  return Object.entries(providers as Record<string, unknown>)
    .map(([id, raw]) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {
          id,
          kind: 'invalid' as const,
          apiKeyEnv: null,
          hasEnvValue: false,
          baseUrl: null,
          model: null,
          contextLength: null,
          hasInlineKey: false,
        }
      }
      const entry = raw as Record<string, unknown>
      const apiKeyEnv = typeof entry.api_key_env === 'string' ? entry.api_key_env : null
      const baseUrl = typeof entry.base_url === 'string' ? entry.base_url : null
      const model = typeof entry.model === 'string' ? entry.model : null
      const contextLength = typeof entry.context_length === 'number' && Number.isFinite(entry.context_length)
        ? entry.context_length
        : null
      return {
        id,
        kind: apiKeyEnv ? 'cloud' as const : baseUrl && model ? 'local' as const : 'invalid' as const,
        apiKeyEnv,
        hasEnvValue: apiKeyEnv ? Boolean(process.env[apiKeyEnv]) : false,
        baseUrl,
        model,
        contextLength,
        hasInlineKey: typeof entry.api_key === 'string' && entry.api_key.trim().length > 0,
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

function globalSettingsPath(): string {
  return path.join(swarmflowHomeDir(), 'settings.json')
}

function swarmflowHomeDir(): string {
  return process.env.SWARMFLOW_HOME || path.join(homedir(), '.swarmflow')
}

function listWorkspaceHistory(): WorkspaceHistoryGroup[] {
  const projectsDir = path.join(swarmflowHomeDir(), 'projects')
  if (!existsSync(projectsDir)) return []

  const groups: WorkspaceHistoryGroup[] = []
  for (const slug of safeReadDir(projectsDir)) {
    const projectDir = path.join(projectsDir, slug)
    if (!safeIsDirectory(projectDir)) continue

    const project = readJsonObject(path.join(projectDir, 'project.json'))
    const workDir = typeof project?.original_path === 'string' ? project.original_path : ''
    if (!workDir) continue

    const sessions = listSessionsInProjectDir(projectDir)
    groups.push({
      workDir,
      slug,
      createdAt: typeof project?.created_at === 'string' ? project.created_at : '',
      lastActiveAt: typeof project?.last_active_at === 'string'
        ? project.last_active_at
        : sessions[0]?.lastActiveAt ?? '',
      sessions,
    })
  }

  groups.sort((a, b) => compareIsoAsc(a.createdAt, b.createdAt))
  return groups
}

function listSessionsInProjectDir(projectDir: string): SessionHistoryItem[] {
  const sessions: SessionHistoryItem[] = []
  for (const name of safeReadDir(projectDir).sort().reverse()) {
    if (!looksLikeSessionId(name)) continue
    const sessionDir = path.join(projectDir, name)
    if (!safeIsDirectory(sessionDir)) continue
    const item = readSessionHistoryItem(sessionDir, name)
    if (item) sessions.push(item)
  }
  sessions.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return compareIsoDesc(a.lastActiveAt, b.lastActiveAt)
  })
  return sessions
}

function archiveSessionHistory(input: ArchiveSessionInput): void {
  const projectDir = findProjectDirForWorkDir(input.workDir)
  if (!projectDir) {
    throw new Error(`Workspace history not found: ${input.workDir}`)
  }

  const sessionDir = findSessionDir(projectDir, input.sessionId)
  if (!sessionDir) {
    throw new Error(`Session not found: ${input.sessionId}`)
  }

  const now = new Date().toISOString()
  const metaPath = path.join(sessionDir, 'meta.json')
  const logPath = path.join(sessionDir, 'log.json')
  let wrote = false
  const meta = readJsonObject(metaPath)
  if (meta) {
    writeJsonObject(metaPath, { ...meta, archived: true, archived_at: now })
    wrote = true
  }
  const log = readJsonObject(logPath)
  if (log) {
    writeJsonObject(logPath, { ...log, archived: true, archived_at: now })
    wrote = true
  }
  if (!wrote) {
    throw new Error(`Session metadata not found: ${input.sessionId}`)
  }
}

function setSessionPinned(input: SetSessionPinnedInput): void {
  const projectDir = findProjectDirForWorkDir(input.workDir)
  if (!projectDir) {
    throw new Error(`Workspace history not found: ${input.workDir}`)
  }

  const sessionDir = findSessionDir(projectDir, input.sessionId)
  if (!sessionDir) {
    throw new Error(`Session not found: ${input.sessionId}`)
  }

  const now = new Date().toISOString()
  const metaPath = path.join(sessionDir, 'meta.json')
  const logPath = path.join(sessionDir, 'log.json')
  let wrote = false
  const meta = readJsonObject(metaPath)
  if (meta) {
    writeJsonObject(metaPath, { ...meta, pinned: input.pinned, pinned_at: input.pinned ? now : null })
    wrote = true
  }
  const log = readJsonObject(logPath)
  if (log) {
    writeJsonObject(logPath, { ...log, pinned: input.pinned, pinned_at: input.pinned ? now : null })
    wrote = true
  }
  if (!wrote) {
    throw new Error(`Session metadata not found: ${input.sessionId}`)
  }
}

function findProjectDirForWorkDir(workDir: string): string | null {
  const projectsDir = path.join(swarmflowHomeDir(), 'projects')
  if (!existsSync(projectsDir)) return null
  for (const slug of safeReadDir(projectsDir)) {
    const projectDir = path.join(projectsDir, slug)
    if (!safeIsDirectory(projectDir)) continue
    const project = readJsonObject(path.join(projectDir, 'project.json'))
    if (typeof project?.original_path === 'string' && project.original_path === workDir) {
      return projectDir
    }
  }
  return null
}

function findSessionDir(projectDir: string, sessionId: string): string | null {
  for (const name of safeReadDir(projectDir)) {
    if (!looksLikeSessionId(name)) continue
    const sessionDir = path.join(projectDir, name)
    if (!safeIsDirectory(sessionDir)) continue
    if (name === sessionId) return sessionDir
    const meta = readJsonObject(path.join(sessionDir, 'meta.json'))
    if (typeof meta?.session_id === 'string' && meta.session_id === sessionId) return sessionDir
    const log = readJsonObject(path.join(sessionDir, 'log.json'))
    if (typeof log?.session_id === 'string' && log.session_id === sessionId) return sessionDir
  }
  return null
}

function readSessionHistoryItem(sessionDir: string, fallbackSessionId: string): SessionHistoryItem | null {
  const meta = readJsonObject(path.join(sessionDir, 'meta.json'))
  if (meta) {
    const turns = numberField(meta.turn_count)
    if (turns === 0 || meta.archived === true) return null
    const created = stringField(meta.created_at)
    return {
      sessionId: stringField(meta.session_id) || fallbackSessionId,
      path: sessionDir,
      created,
      lastActiveAt: stringField(meta.last_active_at) || created,
      summary: stringField(meta.summary),
      title: optionalStringField(meta.title),
      turns,
      pinned: meta.pinned === true,
    }
  }

  const log = readJsonObject(path.join(sessionDir, 'log.json'))
  if (!log) return null
  const turns = numberField(log.turn_count)
  if (turns === 0 || log.archived === true) return null
  const created = stringField(log.created_at)
  return {
    sessionId: stringField(log.session_id) || fallbackSessionId,
    path: sessionDir,
    created,
    lastActiveAt: stringField(log.updated_at) || created,
    summary: stringField(log.summary),
    title: optionalStringField(log.title),
    turns,
    pinned: log.pinned === true,
  }
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function safeIsDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function readJsonObject(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as unknown
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function writeJsonObject(file: string, value: Record<string, unknown>): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, file)
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function optionalStringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function compareIsoDesc(a: string, b: string): number {
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  return b.localeCompare(a)
}

function compareIsoAsc(a: string, b: string): number {
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  return a.localeCompare(b)
}

function looksLikeSessionId(name: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)
}

function stripJsoncComments(text: string): string {
  return text.replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match) => (
    match.startsWith('"') ? match : match.replace(/[^\n]/g, ' ')
  ))
}

const WORKSPACE_FILE_LIMIT = 500
const WORKSPACE_SEARCH_LIMIT = 200
const WORKSPACE_FILE_IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'out',
  'dist',
  'build',
  '.next',
  '.vite',
  '.turbo',
  'coverage',
])

async function listWorkspaceFiles(workDir: string): Promise<readonly WorkspaceFileEntry[]> {
  const root = await resolveGitRoot(workDir)
  const base = root ?? workDir
  const paths = root ? await listGitWorkspacePaths(workDir) : listFilesystemWorkspacePaths(workDir)
  const entries: WorkspaceFileEntry[] = []

  for (const filePath of paths) {
    if (entries.length >= WORKSPACE_FILE_LIMIT) break
    const abs = path.join(base, filePath)
    try {
      const st = statSync(abs)
      if (!st.isFile()) continue
      entries.push({ path: filePath, size: st.size, mtimeMs: st.mtimeMs })
    } catch {
      // The file can disappear while the panel is refreshing.
    }
  }

  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

async function resolveGitRoot(workDir: string): Promise<string | null> {
  try {
    return (await execGit(workDir, ['rev-parse', '--show-toplevel'])).trim() || null
  } catch {
    return null
  }
}

async function listGitWorkspacePaths(workDir: string): Promise<string[]> {
  const out = await execGit(workDir, ['ls-files', '--full-name', '--cached', '--others', '--exclude-standard'])
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((filePath) => !isIgnoredWorkspacePath(filePath))
}

function listFilesystemWorkspacePaths(workDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix = ''): void => {
    if (out.length >= WORKSPACE_FILE_LIMIT) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (out.length >= WORKSPACE_FILE_LIMIT) break
      if (WORKSPACE_FILE_IGNORE_DIRS.has(name)) continue
      const rel = prefix ? `${prefix}/${name}` : name
      const abs = path.join(dir, name)
      try {
        const st = statSync(abs)
        if (st.isDirectory()) walk(abs, rel)
        else if (st.isFile()) out.push(rel)
      } catch {
        // Skip transient files.
      }
    }
  }
  walk(workDir)
  return out
}

function isIgnoredWorkspacePath(filePath: string): boolean {
  return filePath.split('/').some((part) => WORKSPACE_FILE_IGNORE_DIRS.has(part))
}

async function searchWorkspaceText(input: WorkspaceTextSearchInput): Promise<readonly WorkspaceTextSearchResult[]> {
  const query = input.query.trim()
  if (query.length < 2) return []

  const args = [
    '--line-number',
    '--column',
    '--no-heading',
    '--color=never',
    '--smart-case',
    '--fixed-strings',
    '--hidden',
    ...Array.from(WORKSPACE_FILE_IGNORE_DIRS).flatMap((dir) => ['--glob', `!${dir}/**`]),
    '--',
    query,
    '.',
  ]

  let stdout = ''
  try {
    const result = await execFileAsync('rg', args, {
      cwd: input.workDir,
      maxBuffer: 1024 * 1024 * 4,
    })
    stdout = result.stdout
  } catch (err) {
    const maybeStdout = typeof (err as { stdout?: unknown }).stdout === 'string'
      ? (err as { stdout: string }).stdout
      : ''
    stdout = maybeStdout
  }

  return stdout
    .split('\n')
    .filter(Boolean)
    .slice(0, WORKSPACE_SEARCH_LIMIT)
    .map(parseWorkspaceTextSearchLine)
    .filter((item): item is WorkspaceTextSearchResult => item !== null)
}

function parseWorkspaceTextSearchLine(line: string): WorkspaceTextSearchResult | null {
  const match = /^(.*?):(\d+):(\d+):(.*)$/.exec(line)
  if (!match) return null
  const pathValue = (match[1] ?? '').replace(/^\.\//, '')
  const lineNumber = Number.parseInt(match[2] ?? '', 10)
  const column = Number.parseInt(match[3] ?? '', 10)
  if (!pathValue || !Number.isFinite(lineNumber) || !Number.isFinite(column)) return null
  return {
    path: pathValue,
    line: lineNumber,
    column,
    text: match[4] ?? '',
  }
}

async function readGitStatus(workDir: string): Promise<GitStatus> {
  const base: GitStatus = {
    isRepo: false,
    workDir,
    root: null,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    clean: true,
    files: [],
  }

  try {
    const rootOut = await execGit(workDir, ['rev-parse', '--show-toplevel'])
    const root = rootOut.trim()
    const statusOut = await execGit(workDir, [
      'status',
      '--porcelain=v1',
      '-z',
      '-b',
      '--untracked-files=all',
    ])
    const records = statusOut.split('\0').filter(Boolean)
    const branchInfo = parseBranchLine(records[0] ?? '')
    const files = await enrichGitFileStats(workDir, parseStatusRecords(records.slice(1)))

    return {
      ...base,
      isRepo: true,
      root,
      branch: branchInfo.branch,
      upstream: branchInfo.upstream,
      ahead: branchInfo.ahead,
      behind: branchInfo.behind,
      clean: files.length === 0,
      files,
    }
  } catch (err) {
    return {
      ...base,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function execGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    maxBuffer: 1024 * 1024,
  })
  return stdout
}

async function execGitAllowDiffExit(cwd: string, args: string[]): Promise<string> {
  try {
    return await execGit(cwd, args)
  } catch (err) {
    const maybe = err as { code?: unknown; stdout?: unknown }
    if (maybe.code === 1 && typeof maybe.stdout === 'string') return maybe.stdout
    throw err
  }
}

async function readGitFileDiff(input: GitFileDiffInput): Promise<string> {
  const diffArgs = input.staged
    ? ['diff', '--cached', '--no-ext-diff', '--no-color', '--', input.path]
    : ['diff', '--no-ext-diff', '--no-color', '--', input.path]
  const diff = await execGitAllowDiffExit(input.workDir, diffArgs)
  if (diff.trim()) return diff

  if (input.staged) return ''
  const root = (await execGit(input.workDir, ['rev-parse', '--show-toplevel'])).trim()
  const absolutePath = path.resolve(root, input.path)
  if (!absolutePath.startsWith(`${root}${path.sep}`) && absolutePath !== root) return ''
  if (!existsSync(absolutePath) || safeIsDirectory(absolutePath)) return ''
  return execGitAllowDiffExit(input.workDir, [
    'diff',
    '--no-index',
    '--no-ext-diff',
    '--no-color',
    '--',
    '/dev/null',
    absolutePath,
  ])
}

async function enrichGitFileStats(workDir: string, files: GitFileChange[]): Promise<GitFileChange[]> {
  const [staged, unstaged] = await Promise.all([
    readGitNumstat(workDir, true),
    readGitNumstat(workDir, false),
  ])
  return files.map((file) => {
    const stagedStats = staged.get(file.path)
    const unstagedStats = unstaged.get(file.path)
    return {
      ...file,
      stagedAdditions: stagedStats?.additions ?? null,
      stagedDeletions: stagedStats?.deletions ?? null,
      unstagedAdditions: unstagedStats?.additions ?? null,
      unstagedDeletions: unstagedStats?.deletions ?? null,
    }
  })
}

async function readGitNumstat(
  workDir: string,
  staged: boolean,
): Promise<Map<string, { additions: number | null; deletions: number | null }>> {
  const out = await execGitAllowDiffExit(workDir, [
    'diff',
    staged ? '--cached' : '--no-ext-diff',
    ...(staged ? ['--no-ext-diff'] : []),
    '--numstat',
    '--',
  ])
  const result = new Map<string, { additions: number | null; deletions: number | null }>()
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const [addRaw, delRaw, ...pathParts] = line.split('\t')
    const filePath = pathParts.join('\t')
    if (!filePath) continue
    result.set(filePath, {
      additions: parseNumstatCount(addRaw),
      deletions: parseNumstatCount(delRaw),
    })
  }
  return result
}

function parseNumstatCount(value: string | undefined): number | null {
  if (!value || value === '-') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

async function unstageGitFile(input: GitFileActionInput): Promise<void> {
  try {
    await execGit(input.workDir, ['restore', '--staged', '--', input.path])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!message.includes('could not resolve HEAD')) throw err
    await execGit(input.workDir, ['rm', '--cached', '--quiet', '--', input.path])
  }
}

async function unstageAllGitFiles(input: GitBulkActionInput): Promise<void> {
  try {
    await execGit(input.workDir, ['restore', '--staged', '--', '.'])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!message.includes('could not resolve HEAD')) throw err
    await execGit(input.workDir, ['rm', '--cached', '--recursive', '--quiet', '--', '.'])
  }
}

function parseBranchLine(line: string): Pick<GitStatus, 'branch' | 'upstream' | 'ahead' | 'behind'> {
  const payload = line.replace(/^##\s*/, '')
  const [left, trackingRaw] = payload.split('...')
  const branch = parseBranchName(left)
  let upstream: string | null = null
  let ahead = 0
  let behind = 0

  if (trackingRaw) {
    const tracking = trackingRaw.trim()
    const bracket = tracking.match(/\[(.+)\]$/)
    upstream = tracking.replace(/\s*\[.+\]$/, '') || null
    const trackingStats = bracket?.[1]
    if (trackingStats) {
      const aheadMatch = trackingStats.match(/ahead (\d+)/)
      const behindMatch = trackingStats.match(/behind (\d+)/)
      ahead = aheadMatch ? Number(aheadMatch[1]) : 0
      behind = behindMatch ? Number(behindMatch[1]) : 0
    }
  }

  return { branch, upstream, ahead, behind }
}

function parseBranchName(raw: string | undefined): string {
  const name = raw?.trim()
  if (!name) return 'unknown'
  const unborn = name.match(/^No commits yet on (.+)$/)
  if (unborn) return unborn[1]!
  if (name === 'HEAD (no branch)' || name.startsWith('HEAD detached')) return 'detached'
  return name
}

function parseStatusRecords(records: string[]): GitFileChange[] {
  const files: GitFileChange[] = []
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]
    if (!record || record.length < 4) continue
    const staged = record[0] ?? ' '
    const unstaged = record[1] ?? ' '
    const pathName = record.slice(3)
    if (staged === 'R' || unstaged === 'R' || staged === 'C' || unstaged === 'C') {
      const originalPath = records[i + 1]
      if (originalPath) i += 1
      files.push({ path: pathName, originalPath, staged, unstaged })
    } else {
      files.push({ path: pathName, staged, unstaged })
    }
  }
  return files
}
