/**
 * Session persistence 鈥?log-native session storage on disk.
 *
 * Storage layout:
 *
 *   <base_dir>/
 *   鈹斺攢鈹€ projects/
 *       鈹溾攢鈹€ <project_slug>/           # <dir_name>_<sha256[:6]>
 *       鈹?  鈹溾攢鈹€ project.json
 *       鈹?  鈹溾攢鈹€ <session_uuid_v7>/    # e.g. 019de786-1e41-7d21-b1e6-43919a4be1ce
 *       鈹?  鈹?  鈹溾攢鈹€ log.json
 *       鈹?  鈹?  鈹溾攢鈹€ meta.json
 *       鈹?  鈹?  鈹斺攢鈹€ artifacts/
 *       鈹?  鈹斺攢鈹€ ...
 *       鈹斺攢鈹€ general/                  # sessions without a project path
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
import { getSwarmflowHomeDir } from "./lib/home-path.js";
import { LogIdAllocator, type LogEntry, type LogEntryType, type TuiDisplayKind } from "./context/log-entry.js";
import type { ChildSessionMetaRecord } from "./session-tree-types.js";
import { parseJsonc } from "./lib/jsonc.js";
import type { MCPServerConfig } from "./config/config.js";

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const SETTINGS_FILE = "settings.json";
const STATE_DIR = "state";
const MODEL_SELECTION_FILE = "model-selection.json";

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function projectSlug(projectPath: string): string {
  const name = basename(projectPath) || "root";
  const h = createHash("sha256").update(projectPath).digest("hex").slice(0, 6);
  return `${name}_${h}`;
}

function resolvePreferredBaseDir(baseDir?: string): string {
  if (baseDir) return baseDir.replace(/^~/, homedir());
  return getSwarmflowHomeDir();
}

function resolveSessionTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

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

function toLocalIsoFromUtc(utcIso: string): string {
  if (!utcIso) return "";
  const ms = Date.parse(utcIso);
  if (!Number.isFinite(ms)) return "";
  return formatLocalIso(new Date(ms));
}

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
 * Generate a UUIDv7 鈥?48-bit ms timestamp (big-endian) + version + random.
 * Time-ordered so lexicographic and chronological listings agree, useful as
 * the session directory name (which doubles as the session ID).
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

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeSessionId(name: string): boolean {
  return SESSION_ID_RE.test(name);
}

// ------------------------------------------------------------------
// SessionStore
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

  // -- lifecycle --

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

  private static _findUniqueSessionDir(projectDir: string): string {
    // UUIDv7 collisions are astronomically unlikely; if it ever happens,
    // we just regenerate.
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = join(projectDir, randomSessionId());
      if (!existsSync(candidate)) return candidate;
    }
    throw new Error("Failed to allocate a unique session directory.");
  }

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

        // Ensure global AGENTS.md exists (fallback for users who skipped init wizard)
        const globalAgentsMd = join(baseDir, "AGENTS.md");
        if (!existsSync(globalAgentsMd)) {
          try { writeFileSync(globalAgentsMd, ""); } catch { /* non-critical */ }
        }

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

  /** Clear the current session directory (used by /new to defer creation). */
  clearSession(): void {
    this._sessionDir = undefined;
    this._predictedSessionDir = undefined;
  }

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

  attachToExistingSession(sessionDir: string): void {
    this._sessionDir = sessionDir;
    this._predictedSessionDir = undefined;
    this._projectDir = dirname(sessionDir);

    const projectsDir = dirname(this._projectDir);
    if (basename(projectsDir) === "projects") {
      this._activeBaseDir = dirname(projectsDir);
    }
  }

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

  predictNextArtifactsDir(): string {
    return join(this.predictNextSessionDir(), "artifacts");
  }

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

      // Prefer meta.json for fast listing
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
          // Skip empty sessions (0 turns) and archived sessions
          if (turns === 0) continue;
          if (raw.archived) continue;
          sessions.push({ sessionId, path: d, created, lastActiveAt, summary, title, turns });
          continue;
        } catch {
          // Fall through to log.json
        }
      }

      // Fallback to log.json
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

    // Sort by lastActiveAt descending (most recently active first)
    sessions.sort((a, b) => {
      if (!a.lastActiveAt && !b.lastActiveAt) return 0;
      if (!a.lastActiveAt) return 1;
      if (!b.lastActiveAt) return -1;
      return b.lastActiveAt.localeCompare(a.lastActiveAt);
    });

    return sessions;
  }

  /** List all projects across the storage directory, sorted by last_active_at descending. */
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

    // Sort by last_active_at descending
    result.sort((a, b) => {
      if (!a.lastActiveAt && !b.lastActiveAt) return 0;
      if (!a.lastActiveAt) return 1;
      if (!b.lastActiveAt) return -1;
      return b.lastActiveAt.localeCompare(a.lastActiveAt);
    });

    return result;
  }

  get projectDir(): string {
    return this._projectDir;
  }

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

  get sessionDir(): string | undefined {
    return this._sessionDir;
  }

  set sessionDir(value: string) {
    this._sessionDir = value;
  }

  /**
   * Scan every session's log.json across all projects and sum token_update
   * entries. Returns cumulative input/output/cached/uncached + session count.
   * Designed for the /stat panel 鈥?tolerates corrupt/missing files gracefully.
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

export interface GlobalTokenStats {
  cumulativeInput: number;
  cumulativeOutput: number;
  cumulativeCacheRead: number;
  cumulativeUncached: number;
  sessionCount: number;
}

// ====================================================================
// Log-native persistence (v2)
// ====================================================================

// ------------------------------------------------------------------
// LogSessionMeta
// ------------------------------------------------------------------

export interface LogSessionMeta {
  version: number;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  projectPath: string;
  modelConfigName: string;
  modelProvider?: string;
  modelSelectionKey?: string;
  modelId?: string;
  /** Model identity at session creation. Stable across resumes and /model switches. */
  initialModel?: string;
  summary: string;
  title?: string;
  turnCount: number;
  compactCount: number;
  thinkingLevel: string;
  childSessions?: ChildSessionMetaRecord[];
  /** Root session's frozen inbox (persisted on close for snapshot/restore). */
  inbox?: import("./session-tree-types.js").MessageEnvelope[];
}

/** Local inference server config (oMLX, LM Studio, etc.) */
/** One model under a custom/local provider (resolved runtime shape). */
export interface LocalModelEntry {
  id: string;
  contextLength: number;
  maxOutputTokens?: number;
  multimodal?: boolean;
  thinkingLevels?: string[];
  webSearch?: boolean;
}

/**
 * A custom / local provider: one endpoint, one or more models. Covers both
 * user-defined custom providers and the legacy single-model local servers
 * (which resolve to a one-element `models`).
 */
export interface LocalProviderConfig {
  baseUrl: string;
  /** Wire protocol. Default "openai-chat". */
  protocol?: "openai-chat" | "anthropic";
  /** API key for endpoints that require auth. Defaults to "local" if omitted. */
  apiKey?: string;
  /** Display name shown in the picker. */
  label?: string;
  models: LocalModelEntry[];
}

// ------------------------------------------------------------------
// New settings types (replaces GlobalTuiPreferences)
// ------------------------------------------------------------------

/** A single sub-agent model tier entry: stable model identity + thinking level. */
export interface ModelTierEntry {
  provider: string;
  selection_key: string;
  model_id: string;
  /** Required. Use one of the model's available levels, or "none" for non-thinking models. */
  thinking_level: string;
}

/** Per-template model pin: locks a specific agent template to a fixed model. */
export type AgentModelEntry = ModelTierEntry;

/** User-editable settings. Lives in settings.json (JSONC). */
export interface SwarmflowSettings {
  // -- Model --
  /** Declarative default model. Overrides state/model-selection.json. */
  default_model?: string;
  /** Sub-agent model tiers. Each level maps to a model + optional thinking level. */
  model_tiers?: {
    high?: ModelTierEntry;
    medium?: ModelTierEntry;
    low?: ModelTierEntry;
  };
  /** Default thinking level for the main agent. */
  thinking_level?: string;
  /** Main-session context budget percentage (1鈥?00). */
  context_budget_percent?: number;

  // -- Providers (global only, not overridden by local settings) --
  /** Cloud provider 鈫?env var name, or local provider 鈫?full config. */
  providers?: Record<string, ProviderEntry>;

  // -- Display --
  accent_color?: string;
  /** Theme mode: "auto" (follow terminal) | "light" | "dark". Default: "auto". */
  theme_mode?: "auto" | "light" | "dark";
  /** Inline write/edit diff display mode. Default: "compact". */
  diff_display?: "compact" | "full";
  /** Copy-on-select: auto-copy a drag selection to the clipboard. Default: true. */
  copy_on_select?: boolean;

  // -- Permissions --
  /** Default permission mode: "read_only" | "reversible" | "yolo". */
  permission_mode?: string;

  // -- Sub-agent inheritance --
  /** Sub-agents inherit the parent's MCP servers/tools. Default: true. */
  sub_agent_inherit_mcp?: boolean;
  /** Sub-agents inherit the parent's hooks. Default: true. */
  sub_agent_inherit_hooks?: boolean;

  // -- Skills --
  disabled_skills?: string[];

  // -- Agent Models (per-template model pins, global + local merge) --
  agent_models?: Record<string, AgentModelEntry>;

  // -- MCP Servers (global + local merge) --
  mcp_servers?: Record<string, MCPServerSettingsEntry>;

  // -- Updates --
  /**
   * Background update behavior. Default: true.
   * - true: patch/minor auto-download + staged; major notify only
   * - "notify": all versions notify only, never auto-download
   * - false: disable update checks entirely
   */
  auto_update?: boolean | "notify";

  // -- Summarize hints --
  /**
   * Two-tier context summarize hints (main session). Managed by the
   * /summarize_hint command. Levels are integers, 0 < level1 < level2 < 85.
   */
  summarize_hint?: {
    /** Master switch for the two-tier hints. Default: true. */
    enabled?: boolean;
    /** Level-1 trigger (percentage of effective context budget). Default: 50. */
    level1?: number;
    /** Level-2 trigger (percentage). Default: 75. */
    level2?: number;
  };
}

/**
 * A provider entry in settings.json.
 * Cloud providers have `api_key_env`; local providers have `base_url` + `model`.
 */
export interface ProviderEntry {
  /** Environment variable name holding the API key (cloud providers). */
  api_key_env?: string;
  /** Base URL (local providers / custom endpoints). */
  base_url?: string;
  /** Model identifier (legacy single-model local providers). */
  model?: string;
  /** Context window size (legacy single-model local providers). */
  context_length?: number;
  /** Optional API key for local servers / custom endpoints that need auth. */
  api_key?: string;
  /** Marks a user-defined custom provider (arbitrary name + endpoint). */
  custom?: boolean;
  /** Display name shown in the picker (custom providers). */
  label?: string;
  /** Wire protocol for a custom endpoint. Default "openai-chat". */
  protocol?: "openai-chat" | "anthropic";
  /** Multiple models under one custom provider (preferred over single `model`). */
  models?: CustomModelEntry[];
}

/** One model under a custom provider (settings.json shape). */
export interface CustomModelEntry {
  /** API model id sent to the endpoint. */
  id: string;
  /** Context window. Required 鈥?the UI won't save without it. */
  context_length: number;
  /** Max output tokens (used as the request max_tokens cap). */
  max_output_tokens?: number;
  /** Image / multimodal input. Default false. */
  multimodal?: boolean;
  /** Thinking levels, e.g. ["off","on"]. Default none (not a thinking model). */
  thinking_levels?: string[];
  /** Native web search. Default false. */
  web_search?: boolean;
}

/** MCP server entry in settings.json. Same shape as the old mcp.json values. */
export interface MCPServerSettingsEntry {
  transport?: "stdio" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  env_allowlist?: string[];
  sensitive_tools?: string[];
  disabled?: boolean;
}

/** System-managed model selection state. Lives in state/model-selection.json. */
export interface ModelSelectionState {
  config_name?: string;
  provider?: string;
  selection_key?: string;
  model_id?: string;
  thinking_level?: string;
}

// ------------------------------------------------------------------
// Old preferences type (kept temporarily during migration)
// ------------------------------------------------------------------

export interface GlobalTuiPreferences {
  version: number;
  modelConfigName?: string;
  modelProvider?: string;
  modelSelectionKey?: string;
  modelId?: string;
  thinkingLevel: string;
  accentColor?: string;
  disabledSkills?: string[];
  /** Provider 鈫?environment variable name mapping (e.g. { "openai": "OPENAI_API_KEY_1" }) */
  providerEnvVars?: Record<string, string>;
  /** Local inference server configurations (e.g. { "lmstudio": { baseUrl, model, contextLength } }) */
  localProviders?: Record<string, LocalProviderConfig>;
  /** Main-session context budget percentage (1鈥?00). Default 100. */
  contextBudgetPercent?: number;
  /** Whether to show the Codex usage card in the sidebar. Default true. */
  showCodexUsage?: boolean;
  /** Permission mode preference. Default "reversible". */
  permissionMode?: string;
}

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
// camelCase 鈫?snake_case conversion for LogEntry
// ------------------------------------------------------------------

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
// Session meta.json (lightweight summary for fast listing)
// ------------------------------------------------------------------

export interface SessionMetaSummary {
  session_id?: string;
  created_at: string;
  last_active_at: string;
  summary: string;
  title?: string;
  turn_count: number;
  archived?: boolean;
}

export function saveSessionMeta(sessionDir: string, meta: LogSessionMeta): void {
  const metaFile = join(sessionDir, "meta.json");
  const tmp = metaFile + ".tmp";
  // Preserve fields set externally (e.g. "archived") by merging with existing meta
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
    // Best-effort update
  }
}

// ------------------------------------------------------------------
// saveLog / loadLog
// ------------------------------------------------------------------

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
    // entries marked meta.ephemeral === true are in-memory only (e.g. /fork
    // origin pointer); they reach the TUI but never persist.
    entries: entries.filter((e) => !e.meta?.["ephemeral"]).map(entryToSnake),
  };

  const logFile = join(dir, "log.json");
  const tmp = logFile + ".tmp";
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  renameSync(tmp, logFile);

  // Write lightweight meta.json alongside log.json
  try {
    saveSessionMeta(dir, meta);
  } catch {
    // Best-effort
  }

  // Update project.json last_active_at
  try {
    updateProjectLastActive(dirname(dir), meta.updatedAt);
  } catch {
    // Best-effort
  }
}

export interface LoadLogResult {
  meta: LogSessionMeta;
  entries: LogEntry[];
  idAllocator: LogIdAllocator;
}

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

  // Validate entry ID uniqueness
  const seenIds = new Set<string>();
  for (const entry of entries) {
    if (seenIds.has(entry.id)) {
      throw new Error(`Duplicate entry ID detected: ${entry.id}`);
    }
    seenIds.add(entry.id);
  }

  // Restore ID allocator via full scan
  const idAllocator = new LogIdAllocator();
  idAllocator.restoreFrom(entries);

  return { meta, entries, idAllocator };
}

// ------------------------------------------------------------------
// validateAndRepairLog
// ------------------------------------------------------------------

export interface LogRepairResult {
  entries: LogEntry[];
  repaired: boolean;
  warnings: string[];
}

export function validateAndRepairLog(
  entries: LogEntry[],
): LogRepairResult {
  const warnings: string[] = [];
  let repaired = false;

  if (!entries || entries.length === 0) {
    return { entries: entries ?? [], repaired: false, warnings: [] };
  }

  // --- 1. Orphaned compactPhase entries (no compact_marker after them) ---
  {
    // Find the last compact_marker index
    let lastCompactMarkerIdx = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type === "compact_marker" && !entries[i].discarded) {
        lastCompactMarkerIdx = i;
        break;
      }
    }
    // Mark compactPhase entries after the last compact_marker as discarded
    for (let i = lastCompactMarkerIdx + 1; i < entries.length; i++) {
      if (entries[i].meta?.compactPhase && !entries[i].discarded) {
        entries[i].discarded = true;
        warnings.push(`Discarded orphaned compactPhase entry ${entries[i].id}.`);
        repaired = true;
      }
    }
  }

  // --- 2. Fix orphaned tool_calls (missing tool_results) ---
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type !== "tool_call" || entry.discarded) continue;
    if (entry.apiRole !== "assistant") continue;

    const toolCallId = entry.meta.toolCallId as string;
    // Check if there's a matching tool_result
    let hasResult = false;
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[j].type === "tool_result" && entries[j].meta.toolCallId === toolCallId && !entries[j].discarded) {
        hasResult = true;
        break;
      }
    }
    if (!hasResult) {
      // Check if this is the last entry or near the end 鈥?likely a crash
      const isNearEnd = entries.length - i <= 5;
      if (isNearEnd) {
        const execState = entry.meta.toolExecState as string | undefined;
        const recoveredContent =
          execState === "running"
            ? "Session recovered. Tool execution was interrupted and may have caused partial or unknown real-world effects."
            : "Session recovered. Tool result unavailable due to abnormal termination.";
        // Add a recovered tool_result (we need an ID 鈥?use a predictable format)
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

  // --- 3. ask repair ---
  {
    // Build ask_request 鈫?ask_resolution mapping
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

    // Orphan ask_resolution (no matching ask_request) 鈫?discard
    for (const [askId, idx] of askResolutions) {
      if (!askRequests.has(askId)) {
        entries[idx].discarded = true;
        warnings.push(`Discarded orphan ask_resolution ${entries[idx].id} (askId=${askId}).`);
        repaired = true;
      }
    }

    // ask_resolution exists but no tool_result 鈫?add recovered tool_result
    for (const [askId, resIdx] of askResolutions) {
      if (entries[resIdx].discarded) continue;
      const reqIdx = askRequests.get(askId);
      if (reqIdx === undefined) continue;

      const reqEntry = entries[reqIdx];
      const toolCallId = reqEntry.meta.toolCallId as string;
      if (!toolCallId) continue;

      // Check if there's a tool_result for this toolCallId after the resolution
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

  // --- 4. Heal reasoning entries split from their round by a stale turnIndex ---
  // Pre-fix (see Session._runActivation / activationTurnIndex), a queued
  // message draining mid-activation could advance `_turnCount` so a round's
  // streamed `reasoning` got a higher turnIndex than its sibling tool_call /
  // tool_result entries. projectToApiMessages groups by (turnIndex, roundIndex),
  // so such reasoning becomes an orphan 鈫?a degenerate "thinking-only" assistant
  // message that strict backends (DeepSeek /anthropic) reject. Re-stamp an
  // orphaned reasoning entry to the turnIndex of its own round's action
  // entries. Tightly scoped: only fires when the reasoning's (turn,round) has
  // NO action sibling AND the round's real entries live under one other turn.
  {
    const ACTION_TYPES = new Set(["tool_call", "tool_result", "assistant_text", "no_reply"]);
    for (const entry of entries) {
      if (entry.type !== "reasoning" || entry.discarded) continue;
      if (entry.roundIndex === undefined) continue;

      // Is this reasoning's own (turnIndex, roundIndex) missing any action? If
      // an action sibling shares its exact turn+round, it is not orphaned.
      let hasOwnAction = false;
      const roundTurns = new Set<number>();
      for (const e of entries) {
        if (e.discarded || e.roundIndex !== entry.roundIndex) continue;
        if (!ACTION_TYPES.has(e.type)) continue;
        if (e.turnIndex === entry.turnIndex) { hasOwnAction = true; break; }
        roundTurns.add(e.turnIndex);
      }
      if (hasOwnAction) continue;
      // The round's action entries must all live under exactly one other turn,
      // otherwise we can't unambiguously pick the correct turnIndex.
      if (roundTurns.size !== 1) continue;

      const targetTurn = [...roundTurns][0];
      warnings.push(
        `Re-stamped orphaned reasoning ${entry.id} turnIndex ${entry.turnIndex} 鈫?${targetTurn} ` +
        `(round ${entry.roundIndex}; split by mid-activation turn drift).`,
      );
      entry.turnIndex = targetTurn;
      repaired = true;
    }
  }

  return { entries, repaired, warnings };
}

// ------------------------------------------------------------------
// Archive window
// ------------------------------------------------------------------

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
  // Write first, strip after 鈥?a failed write must leave content resident
  // (a stripped entry with no archive file is unrecoverable).
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
 * Archive the content of the given entries into `archive/<fileName>`,
 * nulling each entry's content and marking it archived (same contract as
 * archiveWindow, but with an explicit target list). Entries that are already
 * archived or have no content are skipped. No file is written when nothing
 * qualifies; returns the number of entries archived. Write-then-strip: if
 * the write throws, every entry keeps its content.
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
 * Load an archive file by name. Returns null when the file doesn't exist
 * (e.g. archives written by an older binary, or a session dir that was
 * pruned) 鈥?callers degrade to leaving the entries archived.
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
 * Restore archived content back into entries (in-memory only). Restored
 * entries drop their archived flag so they re-enter API projection and can
 * be re-archived by a later summary/compact.
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
// fixStorage 鈥?repair missing project.json and meta.json
// ------------------------------------------------------------------

export interface FixStorageResult {
  projectsChecked: number;
  projectsFixed: number;
  sessionsChecked: number;
  sessionsFixed: number;
  warnings: string[];
}

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

    // Check / create project.json
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

    // Scan sessions and fix meta.json
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
        // meta.json exists 鈥?track latest for project-level update
        try {
          const raw = JSON.parse(readFileSync(metaFile, "utf-8"));
          const activeAt = raw.last_active_at ?? "";
          if (activeAt > latestActiveAt) {
            latestActiveAt = activeAt;
          }
        } catch { /* skip */ }
      }
    }

    // Update project.json last_active_at if missing or stale
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
// New settings API
// ------------------------------------------------------------------

/** Load global settings from ~/.swarmflow/settings.json (JSONC). */
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
 * Load project-local settings.
 *
 * Two layers (project-store < workspace, workspace wins on conflict):
 *   1. ~/.swarmflow/projects/<slug>/.swarmflow/settings.json  (system-managed)
 *   2. {projectPath}/.swarmflow/settings.json             (user-authored)
 *
 * When projectStoreDir is omitted, only the workspace layer is loaded
 * (backwards-compatible with callers that don't have the slug yet).
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
 * Merge global + local settings.
 *
 * Rules:
 * - Scalars: local overrides global
 * - Objects (model_tiers, mcp_servers): per-key merge (local keys override)
 * - Arrays (disabled_skills): local replaces global
 * - `providers`: global only 鈥?local value is ignored
 */
export function mergeSettings(global: SwarmflowSettings, local: SwarmflowSettings): SwarmflowSettings {
  const merged: SwarmflowSettings = { ...global };

  // Scalars 鈥?local overrides if present
  if (local.default_model !== undefined) merged.default_model = local.default_model;
  if (local.thinking_level !== undefined) merged.thinking_level = local.thinking_level;
  if (local.context_budget_percent !== undefined) merged.context_budget_percent = local.context_budget_percent;
  if (local.accent_color !== undefined) merged.accent_color = local.accent_color;
  if (local.theme_mode !== undefined) merged.theme_mode = local.theme_mode;
  if (local.permission_mode !== undefined) merged.permission_mode = local.permission_mode;
  if (local.sub_agent_inherit_mcp !== undefined) merged.sub_agent_inherit_mcp = local.sub_agent_inherit_mcp;
  if (local.sub_agent_inherit_hooks !== undefined) merged.sub_agent_inherit_hooks = local.sub_agent_inherit_hooks;

  // Arrays 鈥?local replaces
  if (local.disabled_skills !== undefined) merged.disabled_skills = local.disabled_skills;

  // Objects 鈥?per-key merge
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

  // providers: global only 鈥?do NOT merge local.providers
  return merged;
}

/**
 * Parse process-local `-c key=value` overrides. These are intentionally
 * limited to context budget and are never persisted.
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

/** Load model selection state from state/model-selection.json. */
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

/** Save model selection state to state/model-selection.json. Atomic write. */
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
 * Save settings.json (global or local). Atomic write.
 * Only writes the fields that are defined 鈥?undefined fields are omitted.
 */
export function saveSettings(settings: SwarmflowSettings, filePath: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp";
  // Build a clean object without undefined values
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

/** Merge a partial update into the global settings.json file. */
export function saveGlobalSettingsPatch(patch: Partial<SwarmflowSettings>, homeDir?: string): void {
  const existing = loadGlobalSettings(homeDir);
  saveSettings({ ...existing, ...patch }, globalSettingsPath(homeDir));
}

/** Get the global settings.json path. */
export function globalSettingsPath(homeDir?: string): string {
  return join(homeDir ?? getSwarmflowHomeDir(), SETTINGS_FILE);
}

/** Get the project-local settings.json path. */
export function localSettingsPath(projectPath: string): string {
  return join(projectPath, ".swarmflow", SETTINGS_FILE);
}

/**
 * Convert SwarmflowSettings providers + mcp_servers into the formats
 * expected by Config and MCPClientManager.
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
        // Cloud provider
        providerEnvVars[id] = entry.api_key_env;
      } else if (entry.base_url && (entry.models?.length || entry.model)) {
        // Custom / local provider: prefer models[]; fall back to legacy single model.
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
          // Resolve ${ENV_VAR} references
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
