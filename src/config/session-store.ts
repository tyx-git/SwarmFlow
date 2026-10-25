/**
 * SessionStore——会话目录的创建、绑定与列举。
 *
 * 存储布局：
 *
 *   <base_dir>/
 *   └── projects/
 *       ├── <project_slug>/           # <dir_name>_<sha256[:6]>
 *       │   ├── project.json
 *       │   ├── <session_uuid_v7>/    # 例如 019de786-1e41-7d21-b1e6-43919a4be1ce
 *       │   │   ├── log.jsonl
 *       │   │   ├── meta.json
 *       │   │   └── artifacts/
 *       │   └── ...
 *       └── general/                  # 无项目路径的会话
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { looksLikeSessionId, projectSlug, randomSessionId, resolvePreferredBaseDir } from "./storage-layout.js";
import {
  acquireSessionLock,
  releaseSessionLock,
  type AcquireSessionLockResult,
} from "./session-lock.js";
import { listSessionsInProject, type SessionInfo } from "./session-list.js";
import { COLD_ARCHIVE_DIR, archiveSessionDir, restoreSessionDir } from "./session-archive.js";
import { nowTimestamps } from "./timestamps.js";

// ------------------------------------------------------------------
// 冷会话归档结果
// ------------------------------------------------------------------

export type ArchiveSessionResult =
  | { ok: true; sessionId: string; from: string; to: string; logBytes: number; compressedBytes: number }
  | { ok: false; error: string };

export type RestoreSessionResult =
  | { ok: true; sessionId: string; from: string; to: string }
  | { ok: false; error: string };

// ------------------------------------------------------------------
// SessionStore——会话存储管理
// ------------------------------------------------------------------

export class SessionStore {
  private _projectPath: string | undefined;
  private _projectSlug: string;
  private _preferredBaseDir: string;
  private _activeBaseDir: string | undefined;
  private _projectDir: string;
  private _sessionDir: string | undefined;
  private _predictedSessionDir: string | undefined;
  private readonly _lockToken = randomUUID();
  private readonly _lockedDirs = new Set<string>();

  constructor(opts?: { projectPath?: string; baseDir?: string }) {
    // 元数据与 slug 都保存绝对路径，避免 GUI 传入 `.` 时与 TUI 的 cwd 不一致。
    this._projectPath = opts?.projectPath ? resolve(opts.projectPath) : undefined;
    this._projectSlug = this._projectPath
      ? projectSlug(this._projectPath)
      : "general";
    this._preferredBaseDir = resolvePreferredBaseDir(opts?.baseDir);
    this._projectDir = join(this._preferredBaseDir, "projects", this._projectSlug);
  }

  // -- 生命周期 --

  /** 返回候选的基础目录列表（首选目录 + 临时目录） */
  private _candidateBaseDirs(): string[] {
    const candidates = [
      this._preferredBaseDir,
      join(tmpdir(), "swarmflow", "sessions"),
    ];
    const seen = new Set<string>();
    const dedup: string[] = [];
    for (const c of candidates) {
      if (seen.has(c)) continue;
      seen.add(c);
      dedup.push(c);
    }
    return dedup;
  }

  /** 确保项目元数据文件存在，不存在则创建 */
  private _ensureProjectMetadata(projectDir: string): void {
    const projectJson = join(projectDir, "project.json");
    if (existsSync(projectJson)) return;
    const now = nowTimestamps().utcIso;
    writeFileSync(
      projectJson,
      JSON.stringify(
        {
          original_path: this._projectPath ?? "",
          created_at: now,
          last_active_at: now,
        },
        null,
        2,
      ),
    );
  }

  /** 查找唯一的会话目录，UUIDv7 碰撞概率极低，发生时重新生成 */
  private static _findUniqueSessionDir(projectDir: string): string {
    // UUIDv7 碰撞概率极低；如果发生，只需重新生成。
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = join(projectDir, randomSessionId());
      if (!existsSync(candidate)) return candidate;
    }
    throw new Error("Failed to allocate a unique session directory.");
  }

  /** 创建新的会话目录结构，返回会话目录路径 */
  createSession(): string {
    const errors: string[] = [];

    for (const baseDir of this._candidateBaseDirs()) {
      const projectDir = join(baseDir, "projects", this._projectSlug);
      try {
        mkdirSync(projectDir, { recursive: true });
        this._ensureProjectMetadata(projectDir);
        let sessionDir = this._predictedSessionDir;
        if (!sessionDir || dirname(sessionDir) !== projectDir || existsSync(sessionDir)) {
          sessionDir = SessionStore._findUniqueSessionDir(projectDir);
        }
        mkdirSync(sessionDir, { recursive: true });
        mkdirSync(join(sessionDir, "artifacts"), { recursive: true });
        const lock = this.acquireSessionLock(sessionDir);
        if (!lock.ok) throw new Error("session directory is locked by another writer");

        this._activeBaseDir = baseDir;
        this._projectDir = projectDir;
        this._sessionDir = sessionDir;
        this._predictedSessionDir = undefined;

        if (baseDir !== this._preferredBaseDir) {
          console.warn(
            `SessionStore fallback active: preferred '${this._preferredBaseDir}' not writable, using '${baseDir}'`,
          );
        }
        return sessionDir;
      } catch (exc) {
        errors.push(`${baseDir}: ${exc}`);
        continue;
      }
    }

    const detail = errors.length > 0 ? errors.join(" | ") : "no candidate paths available";
    throw new Error(`Unable to create session storage directory. Tried: ${detail}`);
  }

  /** 清除当前会话目录（用于 /new 延迟创建）；同时释放本 store 持有的锁。 */
  clearSession(): void {
    this.releaseSessionLocks();
    this._sessionDir = undefined;
    this._predictedSessionDir = undefined;
  }

  /** 尝试获取单写者锁；同一 store 对同一目录幂等。 */
  acquireSessionLock(dir: string): AcquireSessionLockResult {
    if (this._lockedDirs.has(dir)) return { ok: true };
    const result = acquireSessionLock(dir, this._lockToken);
    if (result.ok) this._lockedDirs.add(dir);
    return result;
  }

  holdsSessionLock(dir: string): boolean {
    return this._lockedDirs.has(dir);
  }

  /** 释放指定目录（默认全部）的锁。 */
  releaseSessionLock(dir?: string): void {
    const targets = dir ? [dir] : [...this._lockedDirs];
    for (const target of targets) {
      if (!this._lockedDirs.delete(target)) continue;
      releaseSessionLock(target, this._lockToken);
    }
  }

  /** 切换活动会话成功后，释放不再使用的旧目录锁。 */
  releaseOtherSessionLocks(keepDir: string): void {
    for (const dir of [...this._lockedDirs]) {
      if (dir === keepDir) continue;
      this.releaseSessionLock(dir);
    }
  }

  releaseSessionLocks(): void {
    this.releaseSessionLock();
  }

  /** 捕获当前绑定状态快照 */
  captureBindingState(): {
    activeBaseDir: string | undefined;
    projectDir: string;
    sessionDir: string | undefined;
    predictedSessionDir: string | undefined;
  } {
    return {
      activeBaseDir: this._activeBaseDir,
      projectDir: this._projectDir,
      sessionDir: this._sessionDir,
      predictedSessionDir: this._predictedSessionDir,
    };
  }

  /** 从快照恢复绑定状态 */
  restoreBindingState(state: {
    activeBaseDir: string | undefined;
    projectDir: string;
    sessionDir: string | undefined;
    predictedSessionDir: string | undefined;
  }): void {
    this._activeBaseDir = state.activeBaseDir;
    this._projectDir = state.projectDir;
    this._sessionDir = state.sessionDir;
    this._predictedSessionDir = state.predictedSessionDir;
  }

  /** 附加到现有会话目录 */
  attachToExistingSession(sessionDir: string): void {
    this._sessionDir = sessionDir;
    this._predictedSessionDir = undefined;
    this._projectDir = dirname(sessionDir);

    const projectsDir = dirname(this._projectDir);
    if (basename(projectsDir) === "projects") {
      this._activeBaseDir = dirname(projectsDir);
    }
  }

  /** 冷归档：把当前项目的会话搬到 archived_sessions/ 并压缩活动日志。 */
  archiveSession(sessionId: string): ArchiveSessionResult {
    if (!looksLikeSessionId(sessionId)) {
      return { ok: false, error: `无效的会话 id：${sessionId}` };
    }
    const source = this._findLiveSessionDir(sessionId);
    if (!source) return { ok: false, error: `找不到会话：${sessionId}` };
    if (this._sessionDir && resolve(source) === resolve(this._sessionDir)) {
      return { ok: false, error: "不能归档当前活动会话" };
    }
    try {
      const moved = archiveSessionDir(source);
      return {
        ok: true,
        sessionId,
        from: moved.from,
        to: moved.to,
        logBytes: moved.logBytes,
        compressedBytes: moved.compressedBytes,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 从 archived_sessions/ 还原会话；成功后重新出现在会话列表并可 --resume。 */
  restoreSession(sessionId: string): RestoreSessionResult {
    if (!looksLikeSessionId(sessionId)) {
      return { ok: false, error: `无效的会话 id：${sessionId}` };
    }
    const archived = this._findArchivedSessionDir(sessionId);
    if (!archived) return { ok: false, error: `找不到已归档会话：${sessionId}` };
    try {
      const moved = restoreSessionDir(archived);
      return { ok: true, sessionId, from: moved.from, to: moved.to };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private _findLiveSessionDir(sessionId: string): string | undefined {
    for (const baseDir of this._candidateBaseDirs()) {
      const dir = join(baseDir, "projects", this._projectSlug, sessionId);
      try {
        if (statSync(dir).isDirectory()) return dir;
      } catch { /* 该候选目录不存在 */ }
    }
    return undefined;
  }

  private _findArchivedSessionDir(sessionId: string): string | undefined {
    for (const baseDir of this._candidateBaseDirs()) {
      const dir = join(baseDir, COLD_ARCHIVE_DIR, this._projectSlug, sessionId);
      try {
        if (statSync(dir).isDirectory()) return dir;
      } catch { /* 该候选目录不存在 */ }
    }
    return undefined;
  }

  /** 预测下一个会话目录路径（不创建，仅预测） */
  predictNextSessionDir(): string {
    if (this._sessionDir) return this._sessionDir;
    if (this._predictedSessionDir) return this._predictedSessionDir;

    const errors: string[] = [];
    for (const baseDir of this._candidateBaseDirs()) {
      const projectDir = join(baseDir, "projects", this._projectSlug);
      try {
        mkdirSync(projectDir, { recursive: true });
        this._ensureProjectMetadata(projectDir);
        const sessionDir = SessionStore._findUniqueSessionDir(projectDir);
        this._activeBaseDir = baseDir;
        this._projectDir = projectDir;
        this._predictedSessionDir = sessionDir;
        return sessionDir;
      } catch (exc) {
        errors.push(`${baseDir}: ${exc}`);
      }
    }

    const detail = errors.length > 0 ? errors.join(" | ") : "no candidate paths available";
    throw new Error(`Unable to predict session storage directory. Tried: ${detail}`);
  }

  /** 预测下一个工件目录路径 */
  predictNextArtifactsDir(): string {
    return join(this.predictNextSessionDir(), "artifacts");
  }

  /** 列出当前项目的所有会话，按最后活跃时间降序排列（委托单一列表实现）。 */
  listSessions(): SessionInfo[] {
    return listSessionsInProject(this._projectDir);
  }

  /** 解析本项目下的活动会话目录（prune 等维护命令用）。 */
  resolveSessionDir(sessionId: string): string | undefined {
    if (!looksLikeSessionId(sessionId)) return undefined;
    return this._findLiveSessionDir(sessionId);
  }

  /** 列出存储目录中的所有项目，按最后活跃时间降序排列 */
  listProjects(): Array<{
    slug: string;
    originalPath: string;
    createdAt: string;
    lastActiveAt: string;
  }> {
    const projectsDir = join(this._preferredBaseDir, "projects");
    if (!existsSync(projectsDir)) return [];

    const result: Array<{
      slug: string;
      originalPath: string;
      createdAt: string;
      lastActiveAt: string;
    }> = [];

    for (const name of readdirSync(projectsDir)) {
      const d = join(projectsDir, name);
      try {
        if (!statSync(d).isDirectory()) continue;
      } catch { continue; }

      const projectJson = join(d, "project.json");
      if (!existsSync(projectJson)) continue;

      try {
        const raw = JSON.parse(readFileSync(projectJson, "utf-8"));
        result.push({
          slug: name,
          originalPath: raw.original_path ?? "",
          createdAt: raw.created_at ?? "",
          lastActiveAt: raw.last_active_at ?? "",
        });
      } catch { continue; }
    }

    // 按 last_active_at 降序排列
    result.sort((a, b) => {
      if (!a.lastActiveAt && !b.lastActiveAt) return 0;
      if (!a.lastActiveAt) return 1;
      if (!b.lastActiveAt) return -1;
      return b.lastActiveAt.localeCompare(a.lastActiveAt);
    });

    return result;
  }

  /** 获取项目目录路径 */
  get projectDir(): string {
    return this._projectDir;
  }

  /** 获取工件目录路径，不存在时自动创建 */
  get artifactsDir(): string | undefined {
    if (!this._sessionDir) return undefined;
    const d = join(this._sessionDir, "artifacts");
    try {
      mkdirSync(d, { recursive: true });
    } catch (exc) {
      console.warn(`Failed to ensure artifacts directory '${d}': ${exc}`);
      return undefined;
    }
    return d;
  }

  /** 获取当前会话目录路径 */
  get sessionDir(): string | undefined {
    return this._sessionDir;
  }

  set sessionDir(value: string) {
    this._sessionDir = value;
  }

  /**
   * 扫描所有项目的每个会话的 log.json，汇总 token_update 条目。
   * 返回累计输入/输出/缓存/未缓存 token 数 + 会话数。
   * 为用量统计页设计——优雅地容忍损坏/缺失的文件。
   */
  computeGlobalTokenStats(): GlobalTokenStats {
    const projectsDir = join(this._preferredBaseDir, "projects");
    const empty: GlobalTokenStats = {
      cumulativeInput: 0,
      cumulativeOutput: 0,
      cumulativeCacheRead: 0,
      cumulativeUncached: 0,
      sessionCount: 0,
      sessionsWithoutTokens: [],
    };
    if (!existsSync(projectsDir)) return empty;

    let cumulativeInput = 0;
    let cumulativeOutput = 0;
    let cumulativeCacheRead = 0;
    let cumulativeUncached = 0;
    let sessionCount = 0;
    const sessionsWithoutTokens: string[] = [];

    for (const projectName of readdirSync(projectsDir)) {
      const projectDir = join(projectsDir, projectName);
      try { if (!statSync(projectDir).isDirectory()) continue; } catch { continue; }

      for (const sessionName of readdirSync(projectDir)) {
        const sessionDir = join(projectDir, sessionName);
        try {
          if (!statSync(sessionDir).isDirectory()) continue;
        } catch { continue; }
        if (!looksLikeSessionId(sessionName)) continue;

        // 单一权威源：只读 meta.json.tokens，不再整读日志（P-11/D8）。
        const metaFile = join(sessionDir, "meta.json");
        if (!existsSync(metaFile)) {
          sessionsWithoutTokens.push(sessionName);
          continue;
        }
        try {
          const raw = JSON.parse(readFileSync(metaFile, "utf-8")) as Record<string, unknown>;
          const tokens = raw.tokens as Record<string, unknown> | null | undefined;
          const input = tokens?.["input"];
          const output = tokens?.["output"];
          const cacheRead = tokens?.["cacheRead"];
          if (
            typeof input !== "number" || !Number.isFinite(input) || input < 0
            || typeof output !== "number" || !Number.isFinite(output) || output < 0
            || typeof cacheRead !== "number" || !Number.isFinite(cacheRead) || cacheRead < 0
          ) {
            sessionsWithoutTokens.push(sessionName);
            continue;
          }
          if (input === 0 && output === 0 && cacheRead === 0) continue;
          cumulativeInput += input;
          cumulativeOutput += output;
          cumulativeCacheRead += cacheRead;
          cumulativeUncached += Math.max(0, input - cacheRead);
          sessionCount += 1;
        } catch {
          sessionsWithoutTokens.push(sessionName);
        }
      }
    }

    return {
      cumulativeInput,
      cumulativeOutput,
      cumulativeCacheRead,
      cumulativeUncached,
      sessionCount,
      sessionsWithoutTokens,
    };
  }
}

/** 全局 token 统计数据 */
export interface GlobalTokenStats {
  /** 累计输入 token 数 */
  cumulativeInput: number;
  /** 累计输出 token 数 */
  cumulativeOutput: number;
  /** 累计缓存读取 token 数 */
  cumulativeCacheRead: number;
  /** 累计未缓存 token 数 */
  cumulativeUncached: number;
  /** 包含 token 数据的会话数 */
  sessionCount: number;
  /** 没有 meta.json.tokens 的会话（D8(a)：列出但不整读日志） */
  sessionsWithoutTokens: string[];
}
