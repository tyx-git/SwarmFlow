/**
 * 会话持久化——基于日志的磁盘存储。
 *
 * 存储布局：
 *
 *   <base_dir>/
 *   └── projects/
 *       ├── <project_slug>/           # <dir_name>_<sha256[:6]>
 *       │   ├── project.json
 *       │   ├── <session_uuid_v7>/    # 例如 019de786-1e41-7d21-b1e6-43919a4be1ce
 *       │   │   ├── log.json
 *       │   │   ├── meta.json
 *       │   │   └── artifacts/
 *       │   └── ...
 *       └── general/                  # 无项目路径的会话
 */

import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getSwarmflowHomeDir } from "../lib/home-path.js";
import { LogIdAllocator, type LogEntry, type LogEntryType, type TuiDisplayKind } from "../context/log-entry.js";
import type { ChildSessionMetaRecord } from "../session-tree-types.js";
import { parseJsonc } from "../lib/jsonc.js";
import type { MCPServerConfig } from "../config/config.js";

// ------------------------------------------------------------------
// 常量
// ------------------------------------------------------------------

/** 设置文件名 */
const SETTINGS_FILE = "settings.json";
/** 状态目录名 */
const STATE_DIR = "state";
/** 模型选择文件名 */
const MODEL_SELECTION_FILE = "model-selection.json";

// ------------------------------------------------------------------
// 辅助函数
// ------------------------------------------------------------------

/** 生成项目路径的 slug 格式：<name>_<sha256前6位> */
function projectSlug(projectPath: string): string {
  const name = basename(projectPath) || "root";
  const h = createHash("sha256").update(projectPath).digest("hex").slice(0, 6);
  return `${name}_${h}`;
}

/** 解析首选基础目录，将 ~ 替换为用户主目录 */
function resolvePreferredBaseDir(baseDir?: string): string {
  if (baseDir) return baseDir.replace(/^~/, homedir());
  return getSwarmflowHomeDir();
}

/** 获取当前会话的时区标识符 */
function resolveSessionTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** 将 Date 对象格式化为带本地时区偏移的 ISO 字符串 */
function formatLocalIso(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  const offsetHours = pad(Math.floor(absOffset / 60));
  const offsetMins = pad(absOffset % 60);
  return [
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`,
    `${sign}${offsetHours}:${offsetMins}`,
  ].join("");
}

/** 将 UTC ISO 字符串转换为带本地时区偏移的 ISO 字符串 */
function toLocalIsoFromUtc(utcIso: string): string {
  if (!utcIso) return "";
  const ms = Date.parse(utcIso);
  if (!Number.isFinite(ms)) return "";
  return formatLocalIso(new Date(ms));
}

/** 获取当前时间的多种格式时间戳 */
function nowTimestamps(): {
  utcIso: string;
  localIso: string;
  epochMs: number;
  timeZone: string;
} {
  const now = new Date();
  return {
    utcIso: now.toISOString(),
    localIso: formatLocalIso(now),
    epochMs: now.getTime(),
    timeZone: resolveSessionTimezone(),
  };
}

/**
 * 生成 UUIDv7——48 位毫秒时间戳（大端序）+ 版本号 + 随机数。
 * 时间有序，使得字典序和时间顺序一致，用作会话目录名（同时作为会话 ID）。
 */
export function randomSessionId(): string {
  const ts = BigInt(Date.now());
  const buf = new Uint8Array(16);
  buf[0] = Number((ts >> 40n) & 0xffn);
  buf[1] = Number((ts >> 32n) & 0xffn);
  buf[2] = Number((ts >> 24n) & 0xffn);
  buf[3] = Number((ts >> 16n) & 0xffn);
  buf[4] = Number((ts >> 8n) & 0xffn);
  buf[5] = Number(ts & 0xffn);
  const rand = randomBytes(10);
  buf.set(rand, 6);
  buf[6] = (buf[6]! & 0x0f) | 0x70; // version 7
  buf[8] = (buf[8]! & 0x3f) | 0x80; // variant 10
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** UUID 格式的会话 ID 正则表达式 */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 检查字符串是否看起来像会话 ID */
function looksLikeSessionId(name: string): boolean {
  return SESSION_ID_RE.test(name);
}

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

  constructor(opts?: { projectPath?: string; baseDir?: string }) {
    this._projectPath = opts?.projectPath;
    this._projectSlug = opts?.projectPath
      ? projectSlug(opts.projectPath)
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

  /** 清除当前会话目录（用于 /new 延迟创建） */
  clearSession(): void {
    this._sessionDir = undefined;
    this._predictedSessionDir = undefined;
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

  /** 列出当前项目的所有会话，按最后活跃时间降序排列 */
  listSessions(): Array<{ sessionId: string; path: string; created: string; lastActiveAt: string; summary: string; title?: string; turns: number }> {
    if (!existsSync(this._projectDir)) return [];

    const sessions: Array<{ sessionId: string; path: string; created: string; lastActiveAt: string; summary: string; title?: string; turns: number }> = [];
    const entries = readdirSync(this._projectDir).sort().reverse();

    for (const name of entries) {
      if (!looksLikeSessionId(name)) continue;
      const d = join(this._projectDir, name);
      try {
        if (!statSync(d).isDirectory()) continue;
      } catch {
        continue;
      }

      // 优先使用 meta.json 进行快速列表
      const metaFile = join(d, "meta.json");
      if (existsSync(metaFile)) {
        try {
          const raw = JSON.parse(readFileSync(metaFile, "utf-8"));
          const createdUtc = (raw.created_at as string) ?? "";
          const created = toLocalIsoFromUtc(createdUtc) || createdUtc;
          const lastActiveUtc = (raw.last_active_at as string) ?? createdUtc;
          const lastActiveAt = toLocalIsoFromUtc(lastActiveUtc) || lastActiveUtc;
          const summary = raw.summary ?? "";
          const title = raw.title ?? undefined;
          const turns = raw.turn_count ?? 0;
          const sessionId = (raw.session_id as string | undefined) || name;
          // 跳过空会话（0 轮）和已归档的会话
          if (turns === 0) continue;
          if (raw.archived) continue;
          sessions.push({ sessionId, path: d, created, lastActiveAt, summary, title, turns });
          continue;
        } catch {
          // Fall through to log.json
        }
      }

      // 回退到 log.json
      const logFile = join(d, "log.json");
      if (!existsSync(logFile)) continue;
      try {
        const raw = JSON.parse(readFileSync(logFile, "utf-8"));
        const createdUtc = (raw["created_at"] as string) ?? "";
        const created = toLocalIsoFromUtc(createdUtc) || createdUtc;
        const lastActiveUtc = (raw["updated_at"] as string) ?? createdUtc;
        const lastActiveAt = toLocalIsoFromUtc(lastActiveUtc) || lastActiveUtc;
        const summary = raw["summary"] ?? "";
        const title = raw["title"] ?? undefined;
        const turns = raw["turn_count"] ?? 0;
        const sessionId = (raw["session_id"] as string | undefined) || name;
        // Skip empty sessions (0 turns) and archived sessions
        if (turns === 0) continue;
        if (raw.archived) continue;
        sessions.push({ sessionId, path: d, created, lastActiveAt, summary, title, turns });
      } catch {
        continue;
      }
    }

    // 按最后活跃时间降序排列（最近活跃的排在前面）
    sessions.sort((a, b) => {
      if (!a.lastActiveAt && !b.lastActiveAt) return 0;
      if (!a.lastActiveAt) return 1;
      if (!b.lastActiveAt) return -1;
      return b.lastActiveAt.localeCompare(a.lastActiveAt);
    });

    return sessions;
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
   * 为 /stat 面板设计——优雅地容忍损坏/缺失的文件。
   */
  computeGlobalTokenStats(): GlobalTokenStats {
    const projectsDir = join(this._preferredBaseDir, "projects");
    if (!existsSync(projectsDir)) return { cumulativeInput: 0, cumulativeOutput: 0, cumulativeCacheRead: 0, cumulativeUncached: 0, sessionCount: 0 };

    let cumulativeInput = 0;
    let cumulativeOutput = 0;
    let cumulativeCacheRead = 0;
    let cumulativeUncached = 0;
    let sessionCount = 0;

    for (const projectName of readdirSync(projectsDir)) {
      const projectDir = join(projectsDir, projectName);
      try { if (!statSync(projectDir).isDirectory()) continue; } catch { continue; }

      for (const sessionName of readdirSync(projectDir)) {
        const logFile = join(projectDir, sessionName, "log.json");
        try {
          if (!statSync(join(projectDir, sessionName)).isDirectory()) continue;
          const raw = JSON.parse(readFileSync(logFile, "utf-8"));
          const entries = raw.entries as Array<Record<string, unknown>> | undefined;
          if (!entries) continue;
          let hasTokens = false;
          for (const e of entries) {
            if (e.type !== "token_update") continue;
            const meta = e.meta as Record<string, unknown> | undefined;
            if (!meta) continue;
            const input = meta["input_tokens"] as number ?? meta["inputTokens"] as number ?? 0;
            if (!Number.isFinite(input) || input <= 0) continue;
            const total = (meta["total_tokens"] as number ?? meta["totalTokens"] as number ?? input) as number;
            const cacheRead = (meta["cache_read_tokens"] as number ?? meta["cacheReadTokens"] as number ?? 0) as number;
            cumulativeInput += input;
            cumulativeOutput += Math.max(0, total - input);
            cumulativeCacheRead += cacheRead;
            cumulativeUncached += Math.max(0, input - cacheRead);
            hasTokens = true;
          }
          if (hasTokens) sessionCount++;
        } catch { continue; }
      }
    }

    return { cumulativeInput, cumulativeOutput, cumulativeCacheRead, cumulativeUncached, sessionCount };
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
}

// ====================================================================
// 基于日志的持久化（v2）
// ====================================================================

// ------------------------------------------------------------------
// LogSessionMeta——会话元数据接口
// ------------------------------------------------------------------

/** 会话元数据——存储在 meta.json 中 */
export interface LogSessionMeta {
  /** 元数据版本号 */
  version: number;
  /** 会话 UUID */
  sessionId: string;
  /** 创建时间（UTC ISO 格式） */
  createdAt: string;
  /** 最后更新时间（UTC ISO 格式） */
  updatedAt: string;
  /** 原始项目路径 */
  projectPath: string;
  /** 模型配置名称 */
  modelConfigName: string;
  /** 模型提供商 */
  modelProvider?: string;
  /** 模型选择键 */
  modelSelectionKey?: string;
  /** 模型 ID */
  modelId?: string;
  /** 会话创建时的模型身份，在恢复和 /model 切换时保持稳定 */
  initialModel?: string;
  /** 会话摘要 */
  summary: string;
  /** 会话标题 */
  title?: string;
  /** 对话轮数 */
  turnCount: number;
  /** 压缩次数 */
  compactCount: number;
  /** 思维链级别 */
  thinkingLevel: string;
  /** 子会话元数据记录 */
  childSessions?: ChildSessionMetaRecord[];
  /** 根会话的冻结收件箱（关闭时持久化，用于快照/恢复） */
  inbox?: import("../session-tree-types.js").MessageEnvelope[];
}

/** 自定义/本地提供商下的单个模型（解析后的运行时形状） */
export interface LocalModelEntry {
  /** 模型 ID */
  id: string;
  /** 上下文长度（token 数） */
  contextLength: number;
  /** 最大输出 token 数 */
  maxOutputTokens?: number;
  /** 是否支持多模态输入 */
  multimodal?: boolean;
  /** 可用的思维链级别列表 */
  thinkingLevels?: string[];
  /** 是否支持网络搜索 */
  webSearch?: boolean;
}

/**
 * 自定义/本地提供商：一个端点，一个或多个模型。
 * 涵盖用户定义的自定义提供商和旧版单模型本地服务器
 * （后者解析为单元素 `models`）。
 */
export interface LocalProviderConfig {
  /** API 基础 URL */
  baseUrl: string;
  /** 传输协议。默认 "openai-chat" */
  protocol?: "openai-chat" | "anthropic" | "openai-responses" | "gemini" | "anthropic-messages" | "openai-chat-completions" | "gemini-generate-content";
  /** 需要认证的端点的 API 密钥。省略时默认为 "local" */
  apiKey?: string;
  /** 选择器中显示的名称 */
  label?: string;
  /** 模型列表 */
  models: LocalModelEntry[];
}

// ------------------------------------------------------------------
// 新设置类型（替代 GlobalTuiPreferences）
// ------------------------------------------------------------------

/** 子代理模型层级条目：稳定的模型身份 + 思维链级别 */
export interface ModelTierEntry {
  /** 服务提供商 */
  provider: string;
  /** 选择键 */
  selection_key: string;
  /** 模型 ID */
  model_id: string;
  /** 必填。使用模型的可用级别之一，或 "none" 用于非思维链模型 */
  thinking_level: string;
}

/** 每模板模型固定配置：将特定代理模板锁定到固定模型 */
export type AgentModelEntry = ModelTierEntry;

/** 用户可编辑的设置。存储在 settings.json（JSONC）中 */
export interface SwarmflowSettings {
  // -- 模型 --
  /** 声明式默认模型。覆盖 state/model-selection.json */
  default_model?: string;
  /** 子代理模型层级。每个级别映射到一个模型 + 可选思维链级别 */
  model_tiers?: {
    high?: ModelTierEntry;
    medium?: ModelTierEntry;
    low?: ModelTierEntry;
  };
  /** 主代理的默认思维链级别 */
  thinking_level?: string;
  /** 主会话上下文预算百分比（1-100） */
  context_budget_percent?: number;

  // -- 提供商（仅全局，不被本地设置覆盖）--
  /** 云提供商 → 环境变量名，或本地提供商 → 完整配置 */
  providers?: Record<string, ProviderEntry>;

  // -- 显示 --
  /** 强调色 */
  accent_color?: string;
  /** 主题模式："auto"（跟随终端）| "light" | "dark" | "default"（Catppuccin）| "nord" | "dracula"。默认："auto" */
  theme_mode?: "auto" | "light" | "dark" | "default" | "nord" | "dracula";
  /** 内联写入/编辑差异显示模式。默认："compact" */
  diff_display?: "compact" | "full";
  /** 选择时自动复制：将拖拽选择自动复制到剪贴板。默认：true */
  copy_on_select?: boolean;

  // -- 权限 --
  /** 默认权限模式："read_only" | "reversible" | "yolo" */
  permission_mode?: string;

  // -- 子代理继承 --
  /** 子代理继承父代理的 MCP 服务器/工具。默认：true */
  sub_agent_inherit_mcp?: boolean;
  /** 子代理继承父代理的钩子。默认：true */
  sub_agent_inherit_hooks?: boolean;

  // -- 技能 --
  /** 禁用的技能列表 */
  disabled_skills?: string[];

  // -- 代理模型（每模板模型固定配置，全局 + 本地合并）--
  agent_models?: Record<string, AgentModelEntry>;

  // -- MCP 服务器（全局 + 本地合并）--
  mcp_servers?: Record<string, MCPServerSettingsEntry>;

  // -- 更新 --
  /**
   * 后台更新行为。默认：true。
   * - true：补丁/次版本自动下载 + 暂存；主版本仅通知
   * - "notify"：所有版本仅通知，不自动下载
   * - false：完全禁用更新检查
   */
  auto_update?: boolean | "notify";

  // -- 摘要提示 --
  /**
   * 双层上下文摘要提示（主会话）。由 /summarize_hint 命令管理。
   * 级别为整数，0 < level1 < level2 < 85。
   */
  summarize_hint?: {
    /** 双层提示的主开关。默认：true */
    enabled?: boolean;
    /** 第一层触发器（有效上下文预算的百分比）。默认：50 */
    level1?: number;
    /** 第二层触发器（百分比）。默认：75 */
    level2?: number;
  };
}

/**
 * A provider entry in settings.json.
 * Cloud providers have `api_key_env`; local providers have `base_url` + `model`.
 */
/** settings.json 中的提供商条目。云提供商有 `api_key_env`；本地提供商有 `base_url` + `model` */
export interface ProviderEntry {
  /** 持有 API 密钥的环境变量名（云提供商） */
  api_key_env?: string;
  /** 基础 URL（本地提供商/自定义端点） */
  base_url?: string;
  /** 模型标识符（旧版单模型本地提供商） */
  model?: string;
  /** 上下文窗口大小（旧版单模型本地提供商） */
  context_length?: number;
  /** 需要认证的本地服务器/自定义端点的可选 API 密钥 */
  api_key?: string;
  /** 标记为用户定义的自定义提供商（任意名称 + 端点） */
  custom?: boolean;
  /** 选择器中显示的名称（自定义提供商） */
  label?: string;
  /** 自定义端点的传输协议。默认 "openai-chat" */
  protocol?: "openai-chat" | "anthropic" | "openai-responses" | "gemini" | "anthropic-messages" | "openai-chat-completions" | "gemini-generate-content";
  /** 一个自定义提供商下的多个模型（优先于单个 `model`） */
  models?: CustomModelEntry[];
}

/** 自定义提供商下的单个模型（settings.json 形状） */
export interface CustomModelEntry {
  /** 发送到端点的 API 模型 ID */
  id: string;
  /** 上下文窗口。必填——UI 不保存没有它的条目 */
  context_length: number;
  /** 最大输出 token 数（用作请求 max_tokens 上限） */
  max_output_tokens?: number;
  /** 图像/多模态输入。默认 false */
  multimodal?: boolean;
  /** 思维链级别，例如 ["off","on"]。默认 none（非思维链模型） */
  thinking_levels?: string[];
  /** 原生网络搜索。默认 false */
  web_search?: boolean;
}

/** settings.json 中的 MCP 服务器条目。与旧版 mcp.json 值形状相同 */
export interface MCPServerSettingsEntry {
  /** 传输类型 */
  transport?: "stdio" | "sse";
  /** 启动命令 */
  command?: string;
  /** 命令行参数 */
  args?: string[];
  /** SSE URL */
  url?: string;
  /** 环境变量 */
  env?: Record<string, string>;
  /** 环境变量白名单 */
  env_allowlist?: string[];
  /** 敏感工具列表 */
  sensitive_tools?: string[];
  /** 是否禁用 */
  disabled?: boolean;
}

/** 系统管理的模型选择状态。存储在 state/model-selection.json 中 */
export interface ModelSelectionState {
  /** 模型配置名称 */
  config_name?: string;
  /** 服务提供商 */
  provider?: string;
  /** 选择键 */
  selection_key?: string;
  /** 模型 ID */
  model_id?: string;
  /** 思维链级别 */
  thinking_level?: string;
}

// ------------------------------------------------------------------
// 旧版偏好设置类型（迁移期间临时保留）
// ------------------------------------------------------------------

/** 旧版全局 TUI 偏好设置（已弃用，保留用于迁移） */
export interface GlobalTuiPreferences {
  /** 版本号 */
  version: number;
  /** 模型配置名称 */
  modelConfigName?: string;
  /** 模型提供商 */
  modelProvider?: string;
  /** 模型选择键 */
  modelSelectionKey?: string;
  /** 模型 ID */
  modelId?: string;
  /** 思维链级别 */
  thinkingLevel: string;
  /** 强调色 */
  accentColor?: string;
  /** 禁用的技能列表 */
  disabledSkills?: string[];
  /** 提供商 → 环境变量名映射（例如 { "openai": "OPENAI_API_KEY_1" }） */
  providerEnvVars?: Record<string, string>;
  /** 本地推理服务器配置（例如 { "lmstudio": { baseUrl, model, contextLength } }） */
  localProviders?: Record<string, LocalProviderConfig>;
  /** 主会话上下文预算百分比（1-100）。默认 100 */
  contextBudgetPercent?: number;
  /** 是否在侧边栏显示 Codex 使用量卡片。默认 true */
  showCodexUsage?: boolean;
  /** 权限模式偏好。默认 "reversible" */
  permissionMode?: string;
}

/** 创建默认的全局 TUI 偏好设置对象 */
export function createGlobalTuiPreferences(
  partial?: Partial<GlobalTuiPreferences>,
): GlobalTuiPreferences {
  return {
    version: 1,
    modelConfigName: undefined,
    modelProvider: undefined,
    modelSelectionKey: undefined,
    modelId: undefined,
    thinkingLevel: "",
    ...partial,
  };
}

/** 创建默认的会话元数据对象 */
export function createLogSessionMeta(
  partial?: Partial<LogSessionMeta>,
): LogSessionMeta {
  return {
    version: 2,
    sessionId: "",
    createdAt: "",
    updatedAt: "",
    projectPath: "",
    modelConfigName: "",
    modelProvider: undefined,
    modelSelectionKey: undefined,
    modelId: undefined,
    summary: "",
    title: undefined,
    turnCount: 0,
    compactCount: 0,
    thinkingLevel: "",
    childSessions: undefined,
    ...partial,
  };
}

// ------------------------------------------------------------------
// LogEntry 的 camelCase → snake_case 转换
// ------------------------------------------------------------------

/** 将 LogEntry 对象转换为 snake_case 键名的记录（用于 JSON 序列化） */
function entryToSnake(entry: LogEntry): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    id: entry.id,
    type: entry.type,
    timestamp: entry.timestamp,
    turn_index: entry.turnIndex,
    tui_visible: entry.tuiVisible,
    display_kind: entry.displayKind,
    display: entry.display,
    api_role: entry.apiRole,
    content: entry.content,
    archived: entry.archived,
    meta: entry.meta,
  };
  if (entry.roundIndex !== undefined) obj.round_index = entry.roundIndex;
  if (entry.discarded) obj.discarded = true;
  return obj;
}

/** 从 snake_case 键名的记录恢复为 LogEntry 对象（用于 JSON 反序列化） */
function entryFromSnake(obj: Record<string, unknown>): LogEntry {
  return {
    id: obj.id as string,
    type: obj.type as LogEntryType,
    timestamp: obj.timestamp as number,
    turnIndex: (obj.turn_index as number) ?? 0,
    roundIndex: obj.round_index as number | undefined,
    tuiVisible: (obj.tui_visible as boolean) ?? false,
    displayKind: (obj.display_kind as TuiDisplayKind | null) ?? null,
    display: (obj.display as string) ?? "",
    apiRole: (obj.api_role as LogEntry["apiRole"]) ?? null,
    content: obj.content ?? null,
    archived: (obj.archived as boolean) ?? false,
    meta: (obj.meta as Record<string, unknown>) ?? {},
    ...(obj.discarded ? { discarded: true } : {}),
  };
}

// ------------------------------------------------------------------
// 会话 meta.json（轻量级摘要，用于快速列表）
// ------------------------------------------------------------------

/** 会话元数据摘要——用于快速列表展示 */
export interface SessionMetaSummary {
  /** 会话 ID */
  session_id?: string;
  /** 创建时间 */
  created_at: string;
  /** 最后活跃时间 */
  last_active_at: string;
  /** 会话摘要 */
  summary: string;
  /** 会话标题 */
  title?: string;
  /** 对话轮数 */
  turn_count: number;
  /** 是否已归档 */
  archived?: boolean;
}

/** 保存会话元数据到 meta.json 文件 */
export function saveSessionMeta(sessionDir: string, meta: LogSessionMeta): void {
  const metaFile = join(sessionDir, "meta.json");
  const tmp = metaFile + ".tmp";
  // 通过与现有元数据合并来保留外部设置的字段（例如 "archived"）
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(metaFile)) {
      existing = JSON.parse(readFileSync(metaFile, "utf-8"));
    }
  } catch { /* ignore */ }
  const payload: Record<string, unknown> = {
    ...existing,
    session_id: meta.sessionId,
    created_at: meta.createdAt,
    last_active_at: meta.updatedAt,
    summary: meta.summary,
    title: meta.title,
    turn_count: meta.turnCount,
  };
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  renameSync(tmp, metaFile);
}

/** 更新项目元数据中的最后活跃时间 */
function updateProjectLastActive(projectDir: string, lastActiveAt: string): void {
  const projectJson = join(projectDir, "project.json");
  if (!existsSync(projectJson)) return;
  try {
    const raw = JSON.parse(readFileSync(projectJson, "utf-8"));
    raw.last_active_at = lastActiveAt;
    const tmp = projectJson + ".tmp";
    writeFileSync(tmp, JSON.stringify(raw, null, 2));
    renameSync(tmp, projectJson);
  } catch {
    // 尽力更新
  }
}

// ------------------------------------------------------------------
// saveLog / loadLog——日志保存与加载
// ------------------------------------------------------------------

/** 保存会话日志到磁盘（log.json + meta.json） */
export function saveLog(
  dir: string,
  meta: LogSessionMeta,
  entries: LogEntry[],
): void {
  const now = nowTimestamps();
  meta.updatedAt = now.utcIso;
  if (!meta.createdAt) meta.createdAt = now.utcIso;
  if (!meta.sessionId) meta.sessionId = basename(dir);

  const payload: Record<string, unknown> = {
    version: meta.version,
    session_id: meta.sessionId,
    created_at: meta.createdAt,
    updated_at: meta.updatedAt,
    project_path: meta.projectPath,
    model_config_name: meta.modelConfigName,
    model_provider: meta.modelProvider ?? null,
    model_selection_key: meta.modelSelectionKey ?? null,
    model_id: meta.modelId ?? null,
    summary: meta.summary,
    title: meta.title ?? null,
    turn_count: meta.turnCount,
    compact_count: meta.compactCount,
    thinking_level: meta.thinkingLevel,
    child_sessions: meta.childSessions ?? null,
    // 标记为 meta.ephemeral === true 的条目仅存在于内存中（例如 /fork
    // 来源指针）；它们会到达 TUI 但永远不会持久化。
    entries: entries.filter((e) => !e.meta?.["ephemeral"]).map(entryToSnake),
  };

  const logFile = join(dir, "log.json");
  const tmp = logFile + ".tmp";
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  renameSync(tmp, logFile);

  // 在 log.json 旁边写入轻量级 meta.json
  try {
    saveSessionMeta(dir, meta);
  } catch {
    // 尽力而为
  }

  // 更新 project.json 的 last_active_at
  try {
    updateProjectLastActive(dirname(dir), meta.updatedAt);
  } catch {
    // 尽力而为
  }
}

/** 日志加载结果 */
export interface LoadLogResult {
  /** 会话元数据 */
  meta: LogSessionMeta;
  /** 日志条目列表 */
  entries: LogEntry[];
  /** ID 分配器 */
  idAllocator: LogIdAllocator;
}

/** 从磁盘加载会话日志（log.json） */
export function loadLog(dir: string): LoadLogResult {
  const logFile = join(dir, "log.json");
  const raw = JSON.parse(readFileSync(logFile, "utf-8"));

  const meta: LogSessionMeta = {
    version: raw.version ?? 2,
    sessionId: raw.session_id ?? "",
    createdAt: raw.created_at ?? "",
    updatedAt: raw.updated_at ?? "",
    projectPath: raw.project_path ?? "",
    modelConfigName: raw.model_config_name ?? "",
    modelProvider: raw.model_provider ?? undefined,
    modelSelectionKey: raw.model_selection_key ?? undefined,
    modelId: raw.model_id ?? undefined,
    summary: raw.summary ?? "",
    title: raw.title ?? undefined,
    turnCount: raw.turn_count ?? 0,
    compactCount: raw.compact_count ?? 0,
    thinkingLevel: raw.thinking_level ?? "",
    childSessions: Array.isArray(raw.child_sessions) ? raw.child_sessions as ChildSessionMetaRecord[] : undefined,
  };

  const rawEntries = (raw.entries ?? []) as Array<Record<string, unknown>>;
  const entries = rawEntries.map(entryFromSnake);

  // 验证条目 ID 唯一性
  const seenIds = new Set<string>();
  for (const entry of entries) {
    if (seenIds.has(entry.id)) {
      throw new Error(`Duplicate entry ID detected: ${entry.id}`);
    }
    seenIds.add(entry.id);
  }

  // 通过全量扫描恢复 ID 分配器
  const idAllocator = new LogIdAllocator();
  idAllocator.restoreFrom(entries);

  return { meta, entries, idAllocator };
}

// ------------------------------------------------------------------
// validateAndRepairLog——日志验证与修复
// ------------------------------------------------------------------

/** 日志修复结果 */
export interface LogRepairResult {
  /** 修复后的日志条目列表 */
  entries: LogEntry[];
  /** 是否进行了修复 */
  repaired: boolean;
  /** 修复过程中产生的警告信息 */
  warnings: string[];
}

/** 验证并修复日志条目，处理孤立的 compactPhase、缺失的 tool_result 等问题 */
export function validateAndRepairLog(
  entries: LogEntry[],
): LogRepairResult {
  const warnings: string[] = [];
  let repaired = false;

  if (!entries || entries.length === 0) {
    return { entries: entries ?? [], repaired: false, warnings: [] };
  }

  // --- 1. 孤立的 compactPhase 条目（后面没有 compact_marker）---
  {
    // 查找最后一个 compact_marker 的索引
    let lastCompactMarkerIdx = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type === "compact_marker" && !entries[i].discarded) {
        lastCompactMarkerIdx = i;
        break;
      }
    }
    // 将最后一个 compact_marker 之后的 compactPhase 条目标记为丢弃
    for (let i = lastCompactMarkerIdx + 1; i < entries.length; i++) {
      if (entries[i].meta?.compactPhase && !entries[i].discarded) {
        entries[i].discarded = true;
        warnings.push(`Discarded orphaned compactPhase entry ${entries[i].id}.`);
        repaired = true;
      }
    }
  }

  // --- 2. 修复孤立的 tool_calls（缺少 tool_results）---
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type !== "tool_call" || entry.discarded) continue;
    if (entry.apiRole !== "assistant") continue;

    const toolCallId = entry.meta.toolCallId as string;
    // 检查是否有匹配的 tool_result
    let hasResult = false;
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[j].type === "tool_result" && entries[j].meta.toolCallId === toolCallId && !entries[j].discarded) {
        hasResult = true;
        break;
      }
    }
    if (!hasResult) {
      // 检查这是否是最后或接近最后的条目——可能是崩溃
      const isNearEnd = entries.length - i <= 5;
      if (isNearEnd) {
        const execState = entry.meta.toolExecState as string | undefined;
        const recoveredContent =
          execState === "running"
            ? "Session recovered. Tool execution was interrupted and may have caused partial or unknown real-world effects."
            : "Session recovered. Tool result unavailable due to abnormal termination.";
        // 添加恢复的 tool_result（需要 ID——使用可预测的格式）
        const recoveredId = `tr-recovered-${toolCallId}`;
        const recoveredEntry: LogEntry = {
          id: recoveredId,
          type: "tool_result",
          timestamp: Date.now(),
          turnIndex: entry.turnIndex,
          roundIndex: entry.roundIndex,
          tuiVisible: false,
          displayKind: null,
          display: "",
          apiRole: "tool_result",
          content: {
            toolCallId,
            toolName: entry.meta.toolName as string,
            content: recoveredContent,
            toolSummary: "(recovered)",
          },
          archived: false,
          meta: {
            toolCallId,
            toolName: entry.meta.toolName,
            isError: false,
            recovered: true,
            ...(entry.meta.contextId !== undefined ? { contextId: entry.meta.contextId } : {}),
          },
        };
        // Insert after the tool_call
        entries.splice(i + 1, 0, recoveredEntry);
        warnings.push(`Added recovered tool_result for tool_call ${entry.id} (${toolCallId}).`);
        repaired = true;
      }
    }
  }

  // --- 3. ask 修复 ---
  {
    // 构建 ask_request → ask_resolution 映射
    const askRequests = new Map<string, number>();
    const askResolutions = new Map<string, number>();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.discarded) continue;
      if (e.type === "ask_request") {
        askRequests.set(e.meta.askId as string, i);
      } else if (e.type === "ask_resolution") {
        askResolutions.set(e.meta.askId as string, i);
      }
    }

    // 孤立的 ask_resolution（无匹配的 ask_request）→ 丢弃
    for (const [askId, idx] of askResolutions) {
      if (!askRequests.has(askId)) {
        entries[idx].discarded = true;
        warnings.push(`Discarded orphan ask_resolution ${entries[idx].id} (askId=${askId}).`);
        repaired = true;
      }
    }

    // ask_resolution 存在但无 tool_result → 添加恢复的 tool_result
    for (const [askId, resIdx] of askResolutions) {
      if (entries[resIdx].discarded) continue;
      const reqIdx = askRequests.get(askId);
      if (reqIdx === undefined) continue;

      const reqEntry = entries[reqIdx];
      const toolCallId = reqEntry.meta.toolCallId as string;
      if (!toolCallId) continue;

      // 检查解析后是否有此 toolCallId 的 tool_result
      let hasToolResult = false;
      for (let j = resIdx + 1; j < entries.length; j++) {
        if (entries[j].type === "tool_result" && entries[j].meta.toolCallId === toolCallId && !entries[j].discarded) {
          hasToolResult = true;
          break;
        }
      }
      if (!hasToolResult) {
        const recoveredId = `tr-askrecv-${toolCallId}`;
        const recoveredEntry: LogEntry = {
          id: recoveredId,
          type: "tool_result",
          timestamp: Date.now(),
          turnIndex: reqEntry.turnIndex,
          roundIndex: reqEntry.meta.roundIndex as number | undefined,
          tuiVisible: false,
          displayKind: null,
          display: "",
          apiRole: "tool_result",
          content: {
            toolCallId,
            toolName: reqEntry.meta.toolName ?? "ask",
            content: "Ask resolved. Session recovered from abnormal termination.",
            toolSummary: "(recovered)",
          },
          archived: false,
          meta: {
            toolCallId,
            toolName: reqEntry.meta.toolName ?? "ask",
            isError: false,
            recovered: true,
            ...(reqEntry.meta.contextId !== undefined ? { contextId: reqEntry.meta.contextId } : {}),
          },
        };
        entries.splice(resIdx + 1, 0, recoveredEntry);
        warnings.push(`Added recovered tool_result after ask_resolution ${entries[resIdx].id} (askId=${askId}).`);
        repaired = true;
      }
    }
  }

  // --- 4. 修复因过时的 turnIndex 而与轮次分离的推理条目 ---
  // Pre-fix (see Session._runActivation / activationTurnIndex), a queued
  // message draining mid-activation could advance `_turnCount` so a round's
  // streamed `reasoning` got a higher turnIndex than its sibling tool_call /
  // tool_result entries. projectToApiMessages groups by (turnIndex, roundIndex),
  // so such reasoning becomes an orphan →a degenerate "thinking-only" assistant
  // message that strict backends (DeepSeek /anthropic) reject. Re-stamp an
  // orphaned reasoning entry to the turnIndex of its own round's action
  // entries. Tightly scoped: only fires when the reasoning's (turn,round) has
  // NO action sibling AND the round's real entries live under one other turn.
  {
    const ACTION_TYPES = new Set(["tool_call", "tool_result", "assistant_text", "no_reply"]);
    for (const entry of entries) {
      if (entry.type !== "reasoning" || entry.discarded) continue;
      if (entry.roundIndex === undefined) continue;

      // 此推理条目自己的 (turnIndex, roundIndex) 是否缺少任何操作？
      // 如果操作兄弟条目共享完全相同的 turn+round，则它不是孤立的。
      let hasOwnAction = false;
      const roundTurns = new Set<number>();
      for (const e of entries) {
        if (e.discarded || e.roundIndex !== entry.roundIndex) continue;
        if (!ACTION_TYPES.has(e.type)) continue;
        if (e.turnIndex === entry.turnIndex) { hasOwnAction = true; break; }
        roundTurns.add(e.turnIndex);
      }
      if (hasOwnAction) continue;
      // 轮次的操作条目必须全部位于完全另一个 turn 下，
      // 否则我们无法明确选择正确的 turnIndex。
      if (roundTurns.size !== 1) continue;

      const targetTurn = [...roundTurns][0];
      warnings.push(
        `Re-stamped orphaned reasoning ${entry.id} turnIndex ${entry.turnIndex} →${targetTurn} ` +
        `(round ${entry.roundIndex}; split by mid-activation turn drift).`,
      );
      entry.turnIndex = targetTurn;
      repaired = true;
    }
  }

  return { entries, repaired, warnings };
}

// ------------------------------------------------------------------
// 归档窗口
// ------------------------------------------------------------------

/** 将归档条目压缩并写入归档文件 */
function writeArchiveFile(
  dir: string,
  fileName: string,
  archived: Array<{ id: string; content: unknown }>,
): void {
  const archiveDir = join(dir, "archive");
  mkdirSync(archiveDir, { recursive: true });
  const json = JSON.stringify(archived);
  const compressed = gzipSync(Buffer.from(json));
  writeFileSync(join(archiveDir, fileName), compressed);
}

/** 归档指定窗口范围内的日志条目内容到压缩文件 */
export function archiveWindow(
  dir: string,
  windowIndex: number,
  entries: LogEntry[],
  windowStartIdx: number,
  windowEndIdx: number,
): void {
  const targets: LogEntry[] = [];
  for (let i = windowStartIdx; i <= windowEndIdx && i < entries.length; i++) {
    const e = entries[i];
    if (e.content !== null && !e.archived) targets.push(e);
  }
  // 先写入，后剥离——写入失败时必须保留内容
  // （没有归档文件的已剥离条目无法恢复）。
  writeArchiveFile(
    dir,
    `window-${windowIndex}.json.gz`,
    targets.map((e) => ({ id: e.id, content: e.content })),
  );
  for (const e of targets) {
    e.content = null;
    e.archived = true;
  }
}

/**
 * 将指定条目的内容归档到 `archive/<fileName>`，
 * 将每个条目的内容置空并标记为已归档（与 archiveWindow 相同的契约，
 * 但使用显式目标列表）。已归档或无内容的条目会被跳过。
 * 没有符合条件的条目时不写入文件；返回归档的条目数。
 * 先写入后剥离：如果写入抛出异常，每个条目都保留其内容。
 */
export function archiveEntryContents(
  dir: string,
  fileName: string,
  targets: LogEntry[],
): number {
  const archivable = targets.filter((e) => e.content !== null && !e.archived);
  if (archivable.length === 0) return 0;
  writeArchiveFile(
    dir,
    fileName,
    archivable.map((e) => ({ id: e.id, content: e.content })),
  );
  for (const e of archivable) {
    e.content = null;
    e.archived = true;
  }
  return archivable.length;
}

/** 加载指定窗口索引的归档文件 */
export function loadArchive(
  dir: string,
  windowIndex: number,
): Array<{ id: string; content: unknown }> {
  const archiveFile = join(dir, "archive", `window-${windowIndex}.json.gz`);
  const compressed = readFileSync(archiveFile);
  const json = gunzipSync(compressed).toString("utf-8");
  return JSON.parse(json);
}

/**
 * 按名称加载归档文件。文件不存在时返回 null
 * （例如由旧版二进制写入的归档，或已被修剪的会话目录）
 * ——调用者会降级为保留条目的归档状态。
 */
export function loadArchiveFile(
  dir: string,
  fileName: string,
): Array<{ id: string; content: unknown }> | null {
  const archiveFile = join(dir, "archive", fileName);
  if (!existsSync(archiveFile)) return null;
  const compressed = readFileSync(archiveFile);
  const json = gunzipSync(compressed).toString("utf-8");
  return JSON.parse(json);
}

/**
 * 将归档内容恢复回条目中（仅内存中）。恢复的条目会丢弃其归档标志，
 * 以便重新进入 API 投影，并可被后续的摘要/压缩重新归档。
 */
export function restoreArchiveToEntries(
  entries: LogEntry[],
  archived: Array<{ id: string; content: unknown }>,
): void {
  const contentMap = new Map(archived.map((a) => [a.id, a.content]));
  for (const e of entries) {
    if (e.archived && contentMap.has(e.id)) {
      e.content = contentMap.get(e.id)!;
      e.archived = false;
    }
  }
}

// ------------------------------------------------------------------
// fixStorage——修复缺失的 project.json 和 meta.json
// ------------------------------------------------------------------

/** 存储修复结果 */
export interface FixStorageResult {
  /** 检查的项目数 */
  projectsChecked: number;
  /** 修复的项目数 */
  projectsFixed: number;
  /** 检查的会话数 */
  sessionsChecked: number;
  /** 修复的会话数 */
  sessionsFixed: number;
  /** 修复过程中产生的警告信息 */
  warnings: string[];
}

/** 修复存储中的缺失文件（project.json、meta.json） */
export function fixStorage(baseDir?: string): FixStorageResult {
  const resolvedBase = resolvePreferredBaseDir(baseDir);
  const projectsDir = join(resolvedBase, "projects");

  const result: FixStorageResult = {
    projectsChecked: 0,
    projectsFixed: 0,
    sessionsChecked: 0,
    sessionsFixed: 0,
    warnings: [],
  };

  if (!existsSync(projectsDir)) return result;

  for (const projectName of readdirSync(projectsDir)) {
    const projectDir = join(projectsDir, projectName);
    try {
      if (!statSync(projectDir).isDirectory()) continue;
    } catch { continue; }

    result.projectsChecked++;

    // 检查/创建 project.json
    const projectJson = join(projectDir, "project.json");
    let projectData: Record<string, unknown>;
    if (!existsSync(projectJson)) {
      projectData = {
        original_path: "",
        created_at: nowTimestamps().utcIso,
        last_active_at: "",
      };
      writeFileSync(projectJson, JSON.stringify(projectData, null, 2));
      result.projectsFixed++;
      result.warnings.push(`Created missing project.json for ${projectName} (original_path unknown)`);
    } else {
      try {
        projectData = JSON.parse(readFileSync(projectJson, "utf-8"));
      } catch {
        result.warnings.push(`Could not parse project.json for ${projectName}`);
        continue;
      }
    }

    // 扫描会话并修复 meta.json
    let latestActiveAt = "";
    for (const sessionName of readdirSync(projectDir)) {
      if (!looksLikeSessionId(sessionName)) continue;
      const sessionDir = join(projectDir, sessionName);
      try {
        if (!statSync(sessionDir).isDirectory()) continue;
      } catch { continue; }

      result.sessionsChecked++;

      const metaFile = join(sessionDir, "meta.json");
      const logFile = join(sessionDir, "log.json");

      if (!existsSync(metaFile)) {
        if (existsSync(logFile)) {
          try {
            const raw = JSON.parse(readFileSync(logFile, "utf-8"));
            const payload: SessionMetaSummary = {
              session_id: (raw.session_id as string | undefined) ?? sessionName,
              created_at: raw.created_at ?? "",
              last_active_at: raw.updated_at ?? "",
              summary: raw.summary ?? "",
              title: raw.title ?? undefined,
              turn_count: raw.turn_count ?? 0,
            };
            const tmp = metaFile + ".tmp";
            writeFileSync(tmp, JSON.stringify(payload, null, 2));
            renameSync(tmp, metaFile);
            result.sessionsFixed++;

            if (payload.last_active_at > latestActiveAt) {
              latestActiveAt = payload.last_active_at;
            }
          } catch {
            result.warnings.push(`Could not parse log.json for ${projectName}/${sessionName}`);
          }
        } else {
          result.warnings.push(`No log.json or meta.json for ${projectName}/${sessionName}`);
        }
      } else {
        // meta.json 存在——跟踪最新的用于项目级更新
        try {
          const raw = JSON.parse(readFileSync(metaFile, "utf-8"));
          const activeAt = raw.last_active_at ?? "";
          if (activeAt > latestActiveAt) {
            latestActiveAt = activeAt;
          }
        } catch { /* skip */ }
      }
    }

    // 如果 project.json 的 last_active_at 缺失或过时则更新
    if (latestActiveAt && projectData.last_active_at !== latestActiveAt) {
      projectData.last_active_at = latestActiveAt;
      try {
        const tmp = projectJson + ".tmp";
        writeFileSync(tmp, JSON.stringify(projectData, null, 2));
        renameSync(tmp, projectJson);
        result.projectsFixed++;
      } catch { /* skip */ }
    }
  }

  return result;
}

// ------------------------------------------------------------------
// 新设置 API
// ------------------------------------------------------------------

/** 从 ~/.swarmflow/settings.json（JSONC）加载全局设置 */
export function loadGlobalSettings(homeDir?: string): SwarmflowSettings {
  const dir = homeDir ?? getSwarmflowHomeDir();
  const path = join(dir, SETTINGS_FILE);
  if (!existsSync(path)) return {};
  try {
    const text = readFileSync(path, "utf-8");
    return parseJsonc<SwarmflowSettings>(text) ?? {};
  } catch {
    return {};
  }
}

/**
 * 加载项目本地设置。
 *
 * 两层（project-store < workspace，冲突时 workspace 胜出）：
 *   1. ~/.swarmflow/projects/<slug>/.swarmflow/settings.json  （系统管理）
 *   2. {projectPath}/.swarmflow/settings.json             （用户编写）
 *
 * 省略 projectStoreDir 时，仅加载 workspace 层
 * （与尚无 slug 的调用者向后兼容）。
 */
export function loadLocalSettings(projectPath: string, projectStoreDir?: string): SwarmflowSettings {
  let base: SwarmflowSettings = {};

  if (projectStoreDir) {
    const storePath = join(projectStoreDir, ".swarmflow", SETTINGS_FILE);
    if (existsSync(storePath)) {
      try {
        base = parseJsonc<SwarmflowSettings>(readFileSync(storePath, "utf-8")) ?? {};
      } catch { /* ignore */ }
    }
  }

  const workspacePath = join(projectPath, ".swarmflow", SETTINGS_FILE);
  if (!existsSync(workspacePath)) return base;
  try {
    const workspace = parseJsonc<SwarmflowSettings>(readFileSync(workspacePath, "utf-8")) ?? {};
    return Object.keys(base).length > 0 ? mergeSettings(base, workspace) : workspace;
  } catch {
    return base;
  }
}

/**
 * 合并全局和本地设置。
 *
 * 规则：
 * - 标量：本地覆盖全局
 * - 对象（model_tiers、mcp_servers）：按键合并（本地键覆盖）
 * - 数组（disabled_skills）：本地替换全局
 * - `providers`：仅全局——本地值被忽略
 */
export function mergeSettings(global: SwarmflowSettings, local: SwarmflowSettings): SwarmflowSettings {
  const merged: SwarmflowSettings = { ...global };

  // 标量——如果存在则本地覆盖
  if (local.default_model !== undefined) merged.default_model = local.default_model;
  if (local.thinking_level !== undefined) merged.thinking_level = local.thinking_level;
  if (local.context_budget_percent !== undefined) merged.context_budget_percent = local.context_budget_percent;
  if (local.accent_color !== undefined) merged.accent_color = local.accent_color;
  if (local.theme_mode !== undefined) merged.theme_mode = local.theme_mode;
  if (local.permission_mode !== undefined) merged.permission_mode = local.permission_mode;
  if (local.sub_agent_inherit_mcp !== undefined) merged.sub_agent_inherit_mcp = local.sub_agent_inherit_mcp;
  if (local.sub_agent_inherit_hooks !== undefined) merged.sub_agent_inherit_hooks = local.sub_agent_inherit_hooks;

  // 数组——本地替换
  if (local.disabled_skills !== undefined) merged.disabled_skills = local.disabled_skills;

  // 对象——按键合并
  if (local.model_tiers) {
    merged.model_tiers = { ...merged.model_tiers, ...local.model_tiers };
  }
  if (local.summarize_hint) {
    merged.summarize_hint = { ...merged.summarize_hint, ...local.summarize_hint };
  }
  if (local.mcp_servers) {
    merged.mcp_servers = { ...merged.mcp_servers, ...local.mcp_servers };
  }
  if (local.agent_models) {
    merged.agent_models = { ...merged.agent_models, ...local.agent_models };
  }

  // providers：仅全局——不合并 local.providers
  return merged;
}

/**
 * 解析进程本地的 `-c key=value` 覆盖项。这些有意限制为上下文预算，
 * 永远不会被持久化。
 */
export function parseSettingsOverrides(overrides: readonly string[] = []): SwarmflowSettings {
  const settings: SwarmflowSettings = {};

  for (const override of overrides) {
    const eq = override.indexOf("=");
    if (eq <= 0) {
      throw new Error(`Invalid -c override '${override}'. Expected key=value.`);
    }

    const key = override.slice(0, eq).trim();
    const rawValue = override.slice(eq + 1).trim();

    switch (key) {
      case "context_budget_percent": {
        const value = Number(rawValue);
        if (!Number.isFinite(value)) {
          throw new Error("context_budget_percent override must be a number.");
        }
        settings.context_budget_percent = value;
        break;
      }
      default:
        throw new Error(`Unsupported -c override '${key}'.`);
    }
  }

  return settings;
}

/** 从 state/model-selection.json 加载模型选择状态 */
export function loadModelSelectionState(homeDir?: string): ModelSelectionState {
  const dir = homeDir ?? getSwarmflowHomeDir();
  const path = join(dir, STATE_DIR, MODEL_SELECTION_FILE);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return {
      config_name: raw.config_name ?? undefined,
      provider: raw.provider ?? undefined,
      selection_key: raw.selection_key ?? undefined,
      model_id: raw.model_id ?? undefined,
      thinking_level: raw.thinking_level ?? undefined,
    };
  } catch {
    return {};
  }
}

/** 保存模型选择状态到 state/model-selection.json。原子写入。 */
export function saveModelSelectionState(state: ModelSelectionState, homeDir?: string): void {
  const dir = homeDir ?? getSwarmflowHomeDir();
  const stateDir = join(dir, STATE_DIR);
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, MODEL_SELECTION_FILE);
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

/**
 * 保存 settings.json（全局或本地）。原子写入。
 * 仅写入已定义的字段——undefined 字段会被省略。
 */
export function saveSettings(settings: SwarmflowSettings, filePath: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp";
  // 构建不含 undefined 值的干净对象
  const clean: Record<string, unknown> = {};
  if (settings.default_model !== undefined) clean.default_model = settings.default_model;
  if (settings.model_tiers !== undefined) clean.model_tiers = settings.model_tiers;
  if (settings.thinking_level !== undefined) clean.thinking_level = settings.thinking_level;
  if (settings.context_budget_percent !== undefined) clean.context_budget_percent = settings.context_budget_percent;
  if (settings.providers !== undefined) clean.providers = settings.providers;
  if (settings.accent_color !== undefined) clean.accent_color = settings.accent_color;
  if (settings.theme_mode !== undefined) clean.theme_mode = settings.theme_mode;
  if (settings.diff_display !== undefined) clean.diff_display = settings.diff_display;
  if (settings.permission_mode !== undefined) clean.permission_mode = settings.permission_mode;
  if (settings.disabled_skills !== undefined) clean.disabled_skills = settings.disabled_skills;
  if (settings.mcp_servers !== undefined) clean.mcp_servers = settings.mcp_servers;
  if (settings.agent_models !== undefined) clean.agent_models = settings.agent_models;
  if (settings.sub_agent_inherit_mcp !== undefined) clean.sub_agent_inherit_mcp = settings.sub_agent_inherit_mcp;
  if (settings.sub_agent_inherit_hooks !== undefined) clean.sub_agent_inherit_hooks = settings.sub_agent_inherit_hooks;
  if (settings.auto_update !== undefined) clean.auto_update = settings.auto_update;
  if (settings.summarize_hint !== undefined) clean.summarize_hint = settings.summarize_hint;
  writeFileSync(tmp, JSON.stringify(clean, null, 2));
  renameSync(tmp, filePath);
}

/** 将部分更新合并到全局 settings.json 文件 */
export function saveGlobalSettingsPatch(patch: Partial<SwarmflowSettings>, homeDir?: string): void {
  const existing = loadGlobalSettings(homeDir);
  saveSettings({ ...existing, ...patch }, globalSettingsPath(homeDir));
}

/** 获取全局 settings.json 路径 */
export function globalSettingsPath(homeDir?: string): string {
  return join(homeDir ?? getSwarmflowHomeDir(), SETTINGS_FILE);
}

/** 获取项目本地 settings.json 路径 */
export function localSettingsPath(projectPath: string): string {
  return join(projectPath, ".swarmflow", SETTINGS_FILE);
}

/**
 * 将 SwarmflowSettings 的 providers + mcp_servers 转换为
 * Config 和 MCPClientManager 期望的格式。
 */
export function settingsToConfigInputs(settings: SwarmflowSettings): {
  providerEnvVars: Record<string, string>;
  localProviders: Record<string, LocalProviderConfig>;
  mcpServers: MCPServerConfig[];
} {
  const providerEnvVars: Record<string, string> = {};
  const localProviders: Record<string, LocalProviderConfig> = {};

  if (settings.providers) {
    for (const [id, entry] of Object.entries(settings.providers)) {
      if (entry.api_key_env) {
        // 云提供商
        providerEnvVars[id] = entry.api_key_env;
      } else if (entry.base_url && (entry.models?.length || entry.model)) {
        // 自定义/本地提供商：优先使用 models[]；回退到旧版单模型。
        const models: LocalModelEntry[] = entry.models?.length
          ? entry.models.map((m) => ({
              id: m.id,
              contextLength: m.context_length,
              maxOutputTokens: m.max_output_tokens,
              multimodal: m.multimodal,
              thinkingLevels: m.thinking_levels,
              webSearch: m.web_search,
            }))
          : [{ id: entry.model!, contextLength: entry.context_length ?? 128_000 }];
        localProviders[id] = {
          baseUrl: entry.base_url,
          protocol: entry.protocol ?? "openai-chat",
          apiKey: entry.api_key,
          label: entry.label,
          models,
        };
      }
    }
  }

  const mcpServers: MCPServerConfig[] = [];
  if (settings.mcp_servers) {
    for (const [name, cfg] of Object.entries(settings.mcp_servers)) {
      if (!cfg || typeof cfg !== "object") continue;
      if (cfg.disabled) continue;
      const env: Record<string, string> = {};
      if (cfg.env) {
        for (const [k, v] of Object.entries(cfg.env)) {
          // 解析 ${ENV_VAR} 引用
          if (typeof v === "string" && v.startsWith("${") && v.endsWith("}")) {
            const envName = v.slice(2, -1);
            const resolved = process.env[envName];
            if (resolved !== undefined) env[k] = resolved;
          } else {
            env[k] = v;
          }
        }
      }
      mcpServers.push({
        name,
        transport: cfg.transport ?? "stdio",
        command: cfg.command ?? "",
        args: cfg.args ?? [],
        url: cfg.url ?? "",
        env,
        envAllowlist: cfg.env_allowlist,
        sensitiveTools: cfg.sensitive_tools,
      });
    }
  }

  return { providerEnvVars, localProviders, mcpServers };
}
