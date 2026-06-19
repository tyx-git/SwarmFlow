/**
 * GUI tab 的主进程注册表。一个 tab ↔ 一个 swarmflow 子进程。
 *
 * 职责：
 *   - 管理所有 SessionProcess 实例（生命周期、事件路由）
 *   - 将子进程的 NDJSON 事件转发给渲染器
 *   - 转发渲染器的 RPC 请求给对应 Tab 的子进程
 *
 * 事件流向：
 *   swarmflow 子进程 → SessionProcess → SessionManager → webContents.send → 渲染器
 *   渲染器 → ipcMain.handle → SessionManager → SessionProcess.request → 子进程
 */

// =============================================================================
// TabRecord — 单个 Tab 的运行时状态
// =============================================================================

import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { SessionProcess, type SessionProcessOptions, type ReadyMeta } from './sessionProcess.js'
import type { SessionTab } from '../shared/rpc.js'

interface TabRecord {
  readonly tabId: string
  readonly process: SessionProcess
  readonly workDir: string
  sessionId: string | null
  title: string | null
  displayName: string | null
  selectedModel: string | null
  modelProvider: string | null
  status: 'starting' | 'ready' | 'error' | 'closed'
  errorMessage?: string
  readonly createdAt: number
  lastActiveAt: number
}

function snapshot(r: TabRecord): SessionTab {
  return {
    tabId: r.tabId,
    workDir: r.workDir,
    sessionId: r.sessionId,
    title: r.title,
    displayName: r.displayName,
    selectedModel: r.selectedModel,
    modelProvider: r.modelProvider,
    createdAt: r.createdAt,
    lastActiveAt: r.lastActiveAt,
    status: r.status,
    errorMessage: r.errorMessage,
  }
}

// =============================================================================
// SessionManager — Tab 注册表
// =============================================================================

export class SessionManager {
  readonly #tabs = new Map<string, TabRecord>()   // tabId → TabRecord
  #webContents: WebContents | null = null          // 当前 BrowserWindow

  /** 绑定渲染进程的 webContents，用于向渲染器推送事件 */
  bindWebContents(webContents: WebContents): void {
    this.#webContents = webContents
  }

  /** 列出所有 Tab 的快照（不含 process 引用） */
  listTabs(): readonly SessionTab[] {
    return [...this.#tabs.values()].map(snapshot)
  }

  /**
   * 创建新 Tab：
   *   1. 创建 SessionProcess（启动 swarmflow --server 子进程）
   *   2. 监听 ready 事件以获取 sessionId
   *   3. 等待子进程 ready（20s 超时）
   */
  async createTab(options: SessionProcessOptions): Promise<SessionTab> {
    const tabId = randomUUID()
    const proc = new SessionProcess(options)
    const record: TabRecord = {
      tabId,
      process: proc,
      workDir: options.workDir,
      sessionId: null,
      title: null,
      displayName: null,
      selectedModel: options.selectedModel ?? null,
      modelProvider: null,
      status: 'starting',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    }
    this.#tabs.set(tabId, record)

    proc.on('event', (method, params) => {
      if (method === 'ready' || method === 'turn.started' || method === 'log.changed') {
        record.lastActiveAt = Date.now()
      }
      if (method === 'ready') {
        const meta = params as ReadyMeta | null
        if (meta) {
          record.sessionId = meta.sessionId
          record.selectedModel = meta.selectedModel
          record.modelProvider = meta.modelProvider
          record.title = meta.title ?? null
          record.displayName = meta.displayName ?? null
          record.status = 'ready'
        }
      }
      this.#emit(tabId, method, params)
    })

    proc.on('exit', (code, signal) => {
      record.status = 'closed'
      this.#emit(tabId, 'tab.closed', { code, signal })
      this.#tabs.delete(tabId)
    })

    proc.on('stderr', (text) => {
      this.#emit(tabId, 'server.stderr', { text })
    })

    try {
      await proc.waitReady(20_000)
    } catch (err) {
      record.status = 'error'
      record.errorMessage = err instanceof Error ? err.message : String(err)
      this.#emit(tabId, 'tab.error', { message: record.errorMessage })
    }
    return snapshot(record)
  }

  async closeTab(tabId: string): Promise<void> {
    const r = this.#tabs.get(tabId)
    if (!r) return
    await r.process.shutdown()
    this.#tabs.delete(tabId)
  }

  async closeAll(): Promise<void> {
    const all = [...this.#tabs.values()]
    this.#tabs.clear()
    await Promise.allSettled(all.map((r) => r.process.shutdown()))
  }

  async request(tabId: string, method: string, params?: unknown): Promise<unknown> {
    const r = this.#tabs.get(tabId)
    if (!r) throw new Error(`unknown tab: ${tabId}`)
    return r.process.request(method, params)
  }

  #emit(tabId: string, method: string, params: unknown): void {
    const wc = this.#webContents
    if (!wc || wc.isDestroyed()) return
    try {
      wc.send('rpc:event', { tabId, method, params })
    } catch {
      // 忽略
    }
  }
}
