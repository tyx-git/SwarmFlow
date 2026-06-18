/**
 * Extensible slash-command system.
 *
 * Usage:
 *
 *   const registry = buildDefaultRegistry();
 *   const cmd = registry.lookup("/help");
 *   if (cmd) {
 *     await cmd.handler(ctx, "");
 *   }
 */

import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandPickerResult } from "./ui/command-picker.js";
import type { SessionStore, LocalProviderConfig, ModelSelectionState, SwarmflowSettings, ProviderEntry, CustomModelEntry, ModelTierEntry } from "./config/persistence.js";
import { fetchModelSpecSuggestion } from "./models/dev-lookup.js";
import { randomSessionId, saveModelSelectionState, saveGlobalSettingsPatch, loadGlobalSettings } from "./config/persistence.js";
import { validateSummarizeHintLevels } from "./config/settings.js";
import { VERSION } from "./version.js";
import { applySessionRestore, findSessionById } from "./session-resume.js";
import { setDotenvKey } from "./lifecycle/dotenv.js";
import { fetchModelsFromServer } from "./models/discovery.js";
import {
  getThinkingLevels,
  getTierEligibleThinkingLevels,
} from "./config/config.js";
import {
  PROVIDER_PRESETS,
  findProviderPreset,
} from "./providers/presets.js";
import {
  resolveModelSelection as resolveModelSelectionCore,
  type ResolvedModelSelection,
  createModelTierEntry,
  parseProviderModelTarget,
  runtimeModelName,
} from "./models/selection.js";
import {
  isManagedProvider,
} from "./config/managed-provider-credentials.js";
import {
  ensureManagedProviderCredential,
  runCredentialManageFlow,
  customProviderEnvVar,
  type CredentialPromptAdapter,
  type PromptSecretRequest,
  type PromptSelectRequest,
} from "./providers/credential-flow.js";
import { resolveSkillContent, type SkillMeta } from "./skills/loader.js";
import { buildModelPickerTree, buildCredentialEndpointTree, toCommandPickerOptions, type ModelPickerTreeContext } from "./models/picker-tree.js";
import { describeModel, formatCurrentModelScopedLabel, getCurrentModelDescriptor } from "./models/presentation.js";
import { hasOAuthTokens, isTokenExpiring, readOAuthAccessToken, clearOAuthTokens, ensureFreshToken } from "./auth/openai-oauth.js";
import { hasGitHubTokens, clearGitHubTokens } from "./auth/github-copilot-oauth.js";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

/**
 * Callback used by command handlers to display a message to the user.
 * The TUI layer supplies the concrete implementation.
 */
export type ShowMessageFn = (text: string) => void;

/**
 * Context passed to every command handler.
 *
 * Uses a generic interface so command handlers don't need direct TUI imports.
 */
export interface CommandContext {
  /** The active Session instance (typed as `any` to avoid circular deps). */
  session: any;

  /** Display a message in the conversation area. */
  showMessage: ShowMessageFn;

  /**
   * Brief, non-persistent UI hint shown in the input area's bottom-left
   * corner (TUI) 鈥?for short, no-copy-value confirmations like "Copied" or
   * "Wait until the agent finishes." Falls back to `showMessage` when not
   * wired (e.g. tests, server mode).
   */
  showHint?: (message: string) => void;

  /** The SessionStore for persistence (may be undefined). */
  store?: SessionStore;

  /** swarmflow home directory override, used by tests to avoid real user config. */
  swarmflowHomeDir?: string;

  /** Auto-save the current session (TUI provides the implementation). */
  autoSave: () => void;

  /** Reset TUI state (cancel workers, clear spinners, etc.). */
  resetUiState: () => void;

  /**
   * Force the next render to be a full repaint (TUI provides the impl).
   * Used after session restore so the physical terminal is re-asserted from
   * scratch instead of incrementally diffed against a possibly-drifted state.
   */
  requestFullRepaint?: () => void;

  /** Replace the active UI runtime with a freshly bootstrapped session. */
  restartRuntimeForNewSession?: () => Promise<void>;

  /** The command registry itself, so /help can enumerate commands. */
  commandRegistry: CommandRegistry;

  /** Request TUI-layer graceful exit. */
  exit?: () => Promise<void> | void;

  /** Inject content as a user message and trigger a new turn. */
  onTurnRequested?: (content: string) => void;

  /**
   * Inject a turn where the user sees `displayText` but the model receives
   * `content`. Used by /review and skill commands to keep the conversation
   * clean while sending detailed prompts to the model.
   */
  onInjectedTurnRequested?: (displayText: string, content: string) => void;

  /** Trigger a targeted summarize request through the TUI turn pipeline. */
  onManualSummarizeRequested?: (opts: { targetContextIds?: string[]; focusPrompt?: string }) => void;

  /** Trigger a manual compact request through the TUI execution pipeline. */
  onManualCompactRequested?: (instruction: string) => void;

  /** Open the background shells picker (badge / /shells command). */
  onShellsRequested?: () => void;

  /**
   * Copy text to the system clipboard. Returns true on success.
   * Implementations may be async (the platform-native tool runs in
   * a child process), so callers should `await` the return value.
   */
  copyToClipboard?: (text: string) => boolean | Promise<boolean>;

  /** True while the agent is producing output for the current turn. */
  isProcessing?: () => boolean;

  /** Prompt the user to choose one option during command execution. */
  promptSelect?: (request: PromptSelectRequest) => Promise<string | undefined>;

  /** Prompt the user for a secret value during command execution. */
  promptSecret?: (request: PromptSecretRequest) => Promise<string | undefined>;

  /**
   * Show the hierarchical command picker (with drill-down children support).
   * Returns the selected leaf value (and optional note), or undefined if cancelled.
   */
  promptCommandPicker?: (
    options: CommandOption[],
    config?: { title?: string; allowNote?: boolean },
  ) => Promise<CommandPickerResult | undefined>;

  /**
   * Show the inline OAuth login overlay for the given provider and return
   * on completion (resolved value is non-null on success, null on cancel).
   * The returned token type varies by provider; callers typically only care
   * that it's non-null.
   */
  requestOAuthLogin?: (
    provider: "codex" | "copilot",
  ) => Promise<unknown | null>;
}

/**
 * An option entry for command overlays.
 */
export type SemanticColor = "success" | "error" | "muted";

export interface CommandOption {
  /** Display label shown in the overlay. */
  label: string;
  /**
   * Rich label segments with optional per-segment color.
   * When present, the label is rendered as concatenated colored segments
   * instead of a plain string. `label` is still used for search/fallback.
   */
  labelParts?: Array<{ text: string; color?: SemanticColor }>;
  /** Value submitted as the command argument when selected. */
  value: string;
  /** Right-aligned detail text shown alongside the label (e.g., "+42 -18"). */
  detail?: string;
  /** Semantic color for the leading icon in detail text. */
  detailColor?: SemanticColor;
  /** Non-submittable row used for headings or notices. */
  disabled?: boolean;
  /** Child options for hierarchical selection (e.g., provider 鈫?model). */
  children?: CommandOption[];
  /** Checked state for checkbox picker mode. */
  checked?: boolean;
  /** When true, Enter opens an inline text input instead of submitting immediately. */
  customInput?: boolean;
  /** Label shown above the inline text input (default: "Your instructions:"). */
  inputLabel?: string;
  /** Placeholder inside the inline text input (default: "Type your instructions"). */
  inputPlaceholder?: string;
}

/** Context available when building dynamic picker options for a slash command. */
export interface CommandOptionsContext {
  session: any;
  store?: SessionStore;
}

/**
 * A single slash command.
 */
export interface SlashCommand {
  /** The command name, e.g. "/session". */
  name: string;
  /** Short description shown in /help output. */
  description: string;
  /** Async handler invoked when the command is executed. */
  handler: (ctx: CommandContext, args: string) => Promise<void>;
  /**
   * Optional callback that returns dynamic overlay options for this command.
   * When present, typing the command shows an option picker overlay.
   * Receives session/store context so it can compute dynamic picker options.
   */
  options?: (ctx: CommandOptionsContext) => CommandOption[];
  /** When true, TUI uses a checkbox multi-select picker instead of single-select. */
  checkboxMode?: boolean;
  /** Alternative names that also match during search. */
  aliases?: string[];
  /** Optional display title for the picker; the command name is still submitted. */
  pickerTitle?: string;
}

export class CommandExitSignal extends Error {
  code: number;

  constructor(code = 0) {
    super(`Command requested exit (${code})`);
    this.name = "CommandExitSignal";
    this.code = code;
  }
}

export function isCommandExitSignal(err: unknown): err is CommandExitSignal {
  return err instanceof CommandExitSignal ||
    ((err as { name?: unknown; code?: unknown } | null | undefined)?.name === "CommandExitSignal" &&
      typeof (err as { code?: unknown } | null | undefined)?.code === "number");
}

// ------------------------------------------------------------------
// CommandRegistry
// ------------------------------------------------------------------

export class CommandRegistry {
  private _commands = new Map<string, SlashCommand>();

  /** Register a command. Overwrites any existing command with the same name. */
  register(cmd: SlashCommand): void {
    this._commands.set(cmd.name, cmd);
  }

  /** Remove a command by its exact name. Returns true if it existed. */
  unregister(name: string): boolean {
    return this._commands.delete(name);
  }

  /** Look up a command by its exact name or alias. */
  lookup(name: string): SlashCommand | undefined {
    const direct = this._commands.get(name);
    if (direct) return direct;
    // Fallback: check aliases
    for (const cmd of this._commands.values()) {
      if (cmd.aliases?.includes(name)) return cmd;
    }
    return undefined;
  }

  /** Return all registered commands sorted alphabetically by name. */
  getAll(): SlashCommand[] {
    return Array.from(this._commands.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /** Return command names that start with the given prefix (for completion). */
  getCompletions(prefix: string): string[] {
    const results: string[] = [];
    for (const name of Array.from(this._commands.keys())) {
      if (name.startsWith(prefix)) {
        results.push(name);
      }
    }
    return results.sort();
  }
}

// ------------------------------------------------------------------
// Built-in command handlers
// ------------------------------------------------------------------

async function cmdHelp(ctx: CommandContext, _args: string): Promise<void> {
  ctx.showMessage("__help_panel__");
}

async function cmdUsage(ctx: CommandContext, _args: string): Promise<void> {
  ctx.showMessage("__usage_panel__");
}

async function cmdStat(ctx: CommandContext, _args: string): Promise<void> {
  ctx.showMessage("__stat_panel__");
}

async function cmdNew(ctx: CommandContext, _args: string): Promise<void> {
  if (ctx.restartRuntimeForNewSession) {
    await ctx.restartRuntimeForNewSession();
    return;
  }

  ctx.autoSave();

  // Clear session dir 鈥?a new directory will be created lazily on first save.
  // This avoids creating an empty session file when the user doesn't send any messages.
  if (ctx.store) {
    ctx.store.clearSession();
  }

  // Full session reset 鈥?store is updated, then conversation re-initialized
  // with correct paths. Equivalent to constructing a fresh Session.
  await ctx.session.resetForNewSession(ctx.store);
  ctx.resetUiState();
}

function formatSummarizeLabel(t: { kind: string; turnIndex: number; preview: string }): string {
  const prefix = t.kind === "summary" ? "(Summary)" : `Turn ${t.turnIndex}`;
  return `${prefix}: ${t.preview}`;
}

async function cmdSummarize(ctx: CommandContext, _args: string): Promise<void> {
  if (!ctx.onManualSummarizeRequested) {
    ctx.showMessage("Manual summarize is not available in this UI.");
    return;
  }

  const session = ctx.session;
  const targets: Array<{ kind: "turn" | "summary"; turnIndex: number; preview: string; timestamp: number; contextId?: string }> =
    session.getSummarizeTargets?.() ?? [];
  if (targets.length === 0) {
    ctx.showMessage("No turns available to summarize.");
    return;
  }

  if (!ctx.promptSelect) {
    ctx.showMessage("Interactive summarize is not available in this UI.");
    return;
  }

  // Step 1: Pick range start
  const startOptions = targets.map((t, i) => ({
    label: formatSummarizeLabel(t),
    value: String(i),
  }));
  const startPick = await ctx.promptSelect({
    message: "Summarize from:",
    options: startOptions,
  });
  if (!startPick) return;
  const startIdx = parseInt(startPick, 10);

  // Step 2: Pick range end (only items at or after start)
  const endOptions = targets.slice(startIdx).map((t, i) => ({
    label: formatSummarizeLabel(t),
    value: String(startIdx + i),
  }));
  const endPick = await ctx.promptSelect({
    message: "Summarize to:",
    options: endOptions,
  });
  if (!endPick) return;
  const endIdx = parseInt(endPick, 10);

  // Step 3: Optional focus prompt
  let focusPrompt: string | undefined;
  if (ctx.promptSecret) {
    const input = await ctx.promptSecret({
      message: "Focus prompt (optional, Enter to skip):",
      allowEmpty: true,
    });
    if (input === undefined) return;
    if (input?.trim()) {
      focusPrompt = input.trim();
    }
  }

  // Step 4: Compute context IDs from selected range, preserving spatial order
  const selected = targets.slice(startIdx, endIdx + 1);
  const contextIds: string[] = [];
  const seen = new Set<string>();

  for (const t of selected) {
    if (t.kind === "turn") {
      const turnContextIds = session.getContextIdsForTurnRange?.(t.turnIndex, t.turnIndex) ?? [];
      for (const id of turnContextIds) {
        if (!seen.has(id)) { contextIds.push(id); seen.add(id); }
      }
    } else if (t.kind === "summary" && t.contextId && !seen.has(t.contextId)) {
      contextIds.push(t.contextId);
      seen.add(t.contextId);
    }
  }

  if (contextIds.length === 0) {
    ctx.showMessage("No context groups found in the selected range.");
    return;
  }

  ctx.onManualSummarizeRequested({ targetContextIds: contextIds, focusPrompt });
}

async function cmdCompact(ctx: CommandContext, args: string): Promise<void> {
  if (!ctx.onManualCompactRequested) {
    ctx.showMessage("Manual compact is not available in this UI.");
    return;
  }
  ctx.onManualCompactRequested(args.trim());
}

async function cmdShells(ctx: CommandContext, _args: string): Promise<void> {
  if (!ctx.onShellsRequested) {
    ctx.showMessage("The shells panel is not available in this UI.");
    return;
  }
  ctx.onShellsRequested();
}

const SUMMARIZE_HINT_USAGE =
  "Usage: /summarize_hint on | off | <level1> <level2>  (integers, 0 < level1 < level2 < 85)";

function summarizeHintOptions(ctx: CommandOptionsContext): CommandOption[] {
  const current = typeof ctx.session?.getSummarizeHintConfig === "function"
    ? ctx.session.getSummarizeHintConfig() as { enabled: boolean; level1: number; level2: number }
    : { enabled: true, level1: 50, level2: 75 };
  return [
    { label: current.enabled ? "On (current)" : "On", value: "on" },
    { label: current.enabled ? "Off" : "Off (current)", value: "off" },
    {
      label: `Level 1 (${current.level1}%)`,
      value: "level1",
      customInput: true,
      inputLabel: "Level 1 trigger %:",
      inputPlaceholder: `integer 1-${current.level2 - 1} (below level 2: ${current.level2})`,
    },
    {
      label: `Level 2 (${current.level2}%)`,
      value: "level2",
      customInput: true,
      inputLabel: "Level 2 trigger %:",
      inputPlaceholder: `integer ${current.level1 + 1}-84 (above level 1: ${current.level1})`,
    },
  ];
}

async function cmdSummarizeHint(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  const hint = ctx.showHint ?? ctx.showMessage;

  const applyEnabled = (enabled: boolean): void => {
    const current = session.getSummarizeHintConfig();
    session.setSummarizeHintConfig({ enabled });
    persistSettingsPatch({
      summarize_hint: { enabled, level1: current.level1, level2: current.level2 },
    }, ctx.swarmflowHomeDir);
    hint(`Summarize hints: ${enabled ? "ON" : "OFF"}`);
  };

  const applyLevels = (level1: number, level2: number): boolean => {
    const current = session.getSummarizeHintConfig();
    const error = validateSummarizeHintLevels(level1, level2);
    if (error) {
      ctx.showMessage(`Invalid levels: ${error}\n${SUMMARIZE_HINT_USAGE}`);
      return false;
    }
    session.setSummarizeHintConfig({ level1, level2 });
    persistSettingsPatch({
      summarize_hint: { enabled: current.enabled, level1, level2 },
    }, ctx.swarmflowHomeDir);
    hint(`Summarize hint levels: ${level1}% / ${level2}%`);
    return true;
  };

  const input = args.trim();

  // Interactive path: no args 鈫?picker. Setting a level returns to the
  // picker (with refreshed labels) so both levels can be adjusted in one
  // visit; On/Off applies and closes.
  if (!input && ctx.promptCommandPicker) {
    for (;;) {
      const picked = await ctx.promptCommandPicker(
        summarizeHintOptions({ session: ctx.session, store: ctx.store }),
        { title: "Summarize Hints" },
      );
      if (!picked) return;
      if (picked.value === "on" || picked.value === "off") {
        applyEnabled(picked.value === "on");
        return;
      }
      const current = session.getSummarizeHintConfig();
      const typed = Number((picked.note ?? "").trim());
      if (picked.value === "level1") {
        applyLevels(typed, current.level2);
      } else if (picked.value === "level2") {
        applyLevels(current.level1, typed);
      }
    }
  }

  // Inline shortcut path: on | off | "<level1> <level2>".
  if (input === "on" || input === "off") {
    applyEnabled(input === "on");
    return;
  }

  const parts = input.split(/\s+/);
  if (parts.length === 2) {
    applyLevels(Number(parts[0]), Number(parts[1]));
    return;
  }

  const current = session.getSummarizeHintConfig();
  ctx.showMessage(
    `Summarize hints: ${current.enabled ? "on" : "off"} 路 level1 ${current.level1}% 路 level2 ${current.level2}%\n${SUMMARIZE_HINT_USAGE}`,
  );
}

async function cmdResume(ctx: CommandContext, args: string): Promise<void> {
  const store = ctx.store;
  if (!store) {
    ctx.showMessage("Session persistence not available.");
    return;
  }

  const sessions = store.listSessions();
  const trimmed = args.trim();

  if (!trimmed) {
    if (sessions.length === 0) {
      ctx.showMessage("No previous sessions in this project.");
      return;
    }
    const lines = ["Sessions", "", ...buildSessionTableRows(sessions)];
    lines.push("", "Use /session <sessionId> to load a session.");
    ctx.showMessage(lines.join("\n"));
    return;
  }

  // Resolve the requested session within the current project. Numeric index
  // (1-based) acts as a shortcut from the picker; otherwise match by UUID
  // (which equals the directory basename).
  const numericIdx = /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) - 1 : Number.NaN;
  const target = Number.isInteger(numericIdx)
    ? sessions[numericIdx]
    : sessions.find((s) => s.sessionId === trimmed || basename(s.path) === trimmed);

  if (!target) {
    // Not in this project 鈥?check if it lives elsewhere so we can give an
    // actionable hint instead of a bare "not found".
    const elsewhere = findSessionById(trimmed);
    if (elsewhere && elsewhere.projectPath) {
      ctx.showMessage(
        `This session belongs to ${elsewhere.projectPath}. Exit and run:\n` +
          `cd ${elsewhere.projectPath}\n` +
          `swarmflow --resume ${trimmed}`,
      );
      return;
    }
    ctx.showMessage(`Session not found: ${trimmed}`);
    return;
  }

  // Auto-save current first
  ctx.autoSave();
  ctx.resetUiState();

  const result = applySessionRestore(ctx.session, store, target.path);
  for (const w of result.warnings) ctx.showMessage(w);
  if (!result.ok && result.error) {
    ctx.showMessage(result.error);
  }
  if (result.ok) {
    // Session restore replaces the entire transcript. The renderer's buffer is
    // rebuilt, but the physical terminal is left as-is; an incremental diff
    // won't repair that drift (it compares new-buffer vs new-buffer). Force a
    // full repaint to re-assert ground truth 鈥?the same recovery a terminal
    // resize performs.
    ctx.requestFullRepaint?.();
  }
}

function formatRelativeTime(value: string | undefined, now: number): string {
  const ms = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) return "unknown";
  const deltaSeconds = Math.max(0, Math.round((now - ms) / 1000));
  if (deltaSeconds < 60) return deltaSeconds <= 1 ? "just now" : `${deltaSeconds}s ago`;
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 min ago" : `${minutes} mins ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function sessionTitle(session: {
  sessionId?: string;
  path: string;
  title?: string;
  summary?: string;
}): string {
  const customTitle = session.title?.trim();
  if (customTitle) return customTitle;
  const autoSummary = session.summary?.replace(/\s+/g, " ").trim();
  if (autoSummary) return autoSummary;
  return session.sessionId || basename(session.path);
}

function buildSessionTableRows(
  sessions: Array<{ sessionId?: string; path: string; created?: string; lastActiveAt?: string; summary?: string; title?: string }>,
): string[] {
  const now = Date.now();
  const createdValues = sessions.map((s) => formatRelativeTime(s.created, now));
  const activeValues = sessions.map((s) => formatRelativeTime(s.lastActiveAt, now));
  const createdHeader = "Created";
  const activeHeader = "Active";
  const titleHeader = "Title";
  const createdWidth = Math.max(createdHeader.length, ...createdValues.map((v) => v.length));
  const activeWidth = Math.max(activeHeader.length, ...activeValues.map((v) => v.length));
  const gap = "  ";
  const rows = [
    `${createdHeader.padEnd(createdWidth)}${gap}${activeHeader.padEnd(activeWidth)}${gap}${titleHeader}`,
  ];
  for (let i = 0; i < sessions.length; i += 1) {
    const s = sessions[i]!;
    rows.push(
      `${(createdValues[i] ?? "").padEnd(createdWidth)}${gap}${(activeValues[i] ?? "").padEnd(activeWidth)}${gap}${sessionTitle(s)}`,
    );
  }
  return rows;
}

function resumeOptions(ctx: CommandOptionsContext): CommandOption[] {
  const store = ctx.store;
  if (!store) return [];
  const sessions = store.listSessions();
  if (sessions.length === 0) return [];
  const rows = buildSessionTableRows(sessions);
  return [
    { label: rows[0] ?? "Created  Active  Title", value: "", disabled: true },
    ...sessions.map((s, i) => ({
      label: rows[i + 1] ?? sessionTitle(s),
      value: s.sessionId,
    })),
  ];
}

async function cmdQuit(ctx: CommandContext, _args: string): Promise<void> {
  if (ctx.exit) {
    await ctx.exit();
    return;
  }

  ctx.autoSave();
  try {
    if (typeof ctx.session.close === "function") {
      await ctx.session.close();
    }
  } catch {
    // ignore
  }
  // Non-TUI callers decide how to handle shutdown.
  throw new CommandExitSignal(0);
}

function currentSessionModelDisplayName(session: any): string {
  return getCurrentModelDescriptor(session)?.compactScopedDetailedLabel ?? "";
}

/**
 * Persist model selection state to state/model-selection.json.
 * Reads the current model selection from the session and the thinking level,
 * then writes them to the new state file.
 */
function persistModelSelection(ctx: CommandContext): void {
  try {
    const session = ctx.session;
    // Use getGlobalPreferences() which exposes the persisted model selection
    const prefs = typeof session.getGlobalPreferences === "function"
      ? session.getGlobalPreferences()
      : undefined;
    if (!prefs) return;
    const state: ModelSelectionState = {
      config_name: prefs.modelConfigName ?? undefined,
      provider: prefs.modelProvider ?? undefined,
      selection_key: prefs.modelSelectionKey ?? undefined,
      model_id: prefs.modelId ?? undefined,
      thinking_level: prefs.thinkingLevel && prefs.thinkingLevel !== "none"
        ? prefs.thinkingLevel
        : undefined,
    };
    saveModelSelectionState(state, ctx.swarmflowHomeDir);
  } catch {
    // Ignore persistence failures during command execution.
  }
}

/**
 * Persist a partial settings update to global settings.json.
 * Reads existing settings, merges the patch, and writes back.
 */
function persistSettingsPatch(patch: Partial<SwarmflowSettings>, homeDir?: string): void {
  try {
    saveGlobalSettingsPatch(patch, homeDir);
  } catch {
    // Ignore persistence failures during command execution.
  }
}

/**
 * Prompt the user to select a thinking level for the current model.
 * Called after model switch to let the user choose a thinking level
 * (replaces the removed /thinking command).
 *
 * Returns the selected level string, or undefined if the model doesn't
 * support thinking or the user cancelled.
 */
async function promptThinkingLevel(ctx: CommandContext): Promise<string | undefined> {
  const session = ctx.session;
  const model = session.currentModelName ?? "";
  const levels = getThinkingLevels(model);
  if (levels.length === 0) return undefined;

  // If only one level (e.g. "on" for models with non-configurable thinking),
  // auto-apply without prompting.
  if (levels.length === 1) {
    session.thinkingLevel = levels[0];
    return levels[0];
  }

  if (!ctx.promptSelect) {
    // Non-interactive environment 鈥?keep current/default thinking level.
    return undefined;
  }

  const current = session.thinkingLevel ?? "";
  const options = levels.map((level) => ({
    label: current === level ? `${level}  (current)` : level,
    value: level,
  }));

  const choice = await ctx.promptSelect({
    message: "Select thinking level",
    options,
  });
  if (!choice) return undefined;

  session.thinkingLevel = choice;
  return choice;
}



// ------------------------------------------------------------------
// /model command
// ------------------------------------------------------------------

function parseModelArgs(args: string): { target: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const target = tokens[0] ?? "";
  const rest = tokens.slice(1);
  const inlineKeySyntax = rest.some((t) => t.startsWith("key=") || t.startsWith("api_key="));
  if (inlineKeySyntax || rest.length === 1) {
    throw new Error(
      "Inline API keys in `/model` are no longer supported.\n" +
      "Use `/model` to select the model and follow the prompt to import or paste a key,\n" +
      "or run 'swarmflow init' to configure providers.",
    );
  }
  if (rest.length > 0) {
    throw new Error(
      "Invalid /model arguments.\n" +
      "Use a config name or provider:model (for example `openai:gpt-5.4`).",
    );
  }
  return { target };
}

function createCommandPromptAdapter(ctx: CommandContext): CredentialPromptAdapter | null {
  if (!ctx.promptSelect || !ctx.promptSecret) return null;
  return {
    select: (request) => ctx.promptSelect!(request),
    secret: (request) => ctx.promptSecret!(request),
  };
}

export function resolveModelSelection(
  session: any,
  target: string,
) {
  return resolveModelSelectionCore(session, target);
}

/**
 * Build options for /model picker.
 *
 * Supports three structures:
 * - Two-level: provider 鈫?model (for ungrouped providers like anthropic, openai)
 * - Three-level via group field: group 鈫?sub-provider 鈫?model (kimi, glm, minimax)
 * - Three-level via vendor prefix: openrouter 鈫?vendor 鈫?model
 */
function modelOptions(ctx: CommandOptionsContext): CommandOption[] {
  return modelOptionsWithTree(ctx);
}

/**
 * Flatten the hierarchical model picker tree to leaf-only options.
 * Used when the UI doesn't support drill-down children.
 */
function flatModelOptions(ctx: CommandOptionsContext): CommandOption[] {
  return flatModelOptionsWithTree(ctx);
}

type ModelPickerOverrides = Omit<ModelPickerTreeContext, "session">;

function modelOptionsWithTree(
  ctx: CommandOptionsContext,
  overrides?: ModelPickerOverrides,
): CommandOption[] {
  return toCommandPickerOptions(buildModelPickerTree({
    session: ctx.session,
    ...overrides,
  })) as CommandOption[];
}

function flatModelOptionsWithTree(
  ctx: CommandOptionsContext,
  overrides?: ModelPickerOverrides,
): CommandOption[] {
  const tree = buildModelPickerTree({
    session: ctx.session,
    ...overrides,
  });
  const flat: CommandOption[] = [];
  function walk(nodes: Array<{ label: string; value: string; children?: any[] }>) {
    for (const node of nodes) {
      if (node.children && node.children.length > 0) {
        walk(node.children);
      } else {
        flat.push({ label: node.label, value: node.value });
      }
    }
  }
  walk(toCommandPickerOptions(tree));
  return flat;
}

async function ensureModelSelectionReady(
  ctx: CommandContext,
  target: string,
): Promise<ResolvedModelSelection | undefined> {
  const parsedTarget = parseProviderModelTarget(target);

  if (parsedTarget?.provider === "openai-codex") {
    const existingToken = readOAuthAccessToken();
    if (hasOAuthTokens() && existingToken && isTokenExpiring(existingToken)) {
      try {
        await ensureFreshToken();
        ctx.session.config?.invalidateModelsByProvider?.("openai-codex");
        if (ctx.session.primaryAgent?.modelConfig?.provider === "openai-codex") {
          ctx.session.reloadCurrentModelConfig?.();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.session.appendErrorMessage?.(
          `OAuth token refresh failed: ${message}`,
          "oauth_refresh",
        );
      }
    }

    const currentToken = readOAuthAccessToken();
    const needsLogin = !hasOAuthTokens()
      || (currentToken && isTokenExpiring(currentToken));
    if (needsLogin && ctx.requestOAuthLogin) {
      const tokens = await ctx.requestOAuthLogin("codex");
      if (!tokens) return undefined;
      ctx.session.config?.invalidateModelsByProvider?.("openai-codex");
      if (ctx.session.primaryAgent?.modelConfig?.provider === "openai-codex") {
        ctx.session.reloadCurrentModelConfig?.();
      }
    } else if (needsLogin) {
      throw new Error(
        "OpenAI OAuth token is missing or expired.\n" +
        "Run 'swarmflow oauth' to log in.",
      );
    }
  }

  if (parsedTarget?.provider === "copilot" && !hasGitHubTokens()) {
    if (ctx.requestOAuthLogin) {
      const tokens = await ctx.requestOAuthLogin("copilot");
      if (!tokens) return undefined;
    } else {
      throw new Error(
        "Not logged in to GitHub Copilot.\n" +
        "Run 'swarmflow oauth' to log in.",
      );
    }
  }

  try {
    return resolveModelSelection(ctx.session, target);
  } catch (err) {
    const adapter = createCommandPromptAdapter(ctx);
    if (parsedTarget && isManagedProvider(parsedTarget.provider) && adapter) {
      const result = await ensureManagedProviderCredential(
        parsedTarget.provider,
        adapter,
        { mode: "model", allowReplaceExisting: false, homeDir: ctx.swarmflowHomeDir },
      );
      if (result.status === "skipped") return undefined;
      return resolveModelSelection(ctx.session, target);
    }
    throw err;
  }
}

async function pickResolvedModelSelection(
  ctx: CommandContext,
  opts?: {
    initialTarget?: string;
    treeOverrides?: ModelPickerOverrides;
    flatMessage?: string;
  },
): Promise<ResolvedModelSelection | undefined> {
  let target = opts?.initialTarget?.trim() ?? "";

  while (true) {
    if (!target) {
      if (ctx.promptCommandPicker) {
        target = (await ctx.promptCommandPicker(
          modelOptionsWithTree({ session: ctx.session, store: ctx.store }, opts?.treeOverrides),
        ))?.value ?? "";
      } else if (ctx.promptSelect) {
        const choice = await ctx.promptSelect({
          message: opts?.flatMessage ?? "Select model",
          options: flatModelOptionsWithTree({ session: ctx.session, store: ctx.store }, opts?.treeOverrides),
        });
        target = choice ?? "";
      } else {
        throw new Error("Interactive model selection is not available in this UI.");
      }
      if (!target) return undefined;
    }

    if (target === "__add_provider__") {
      await cmdAddCustomProvider(ctx);
      target = "";
      continue;
    }

    if (target.startsWith("manage:")) {
      await cmdManageCustomProvider(ctx, target.slice("manage:".length));
      target = "";
      continue;
    }

    if (target.endsWith(":__discover__")) {
      await cmdModelLocalDiscover(ctx, target.split(":")[0]);
      target = "";
      continue;
    }

    return ensureModelSelectionReady(ctx, target);
  }
}

/**
 * /model command: switch model by creating a new session.
 *
 * The selected value is either a config name or a provider:model target.
 */
async function cmdModel(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  const trimmed = args.trim();

  if (!trimmed) {
    const current = currentSessionModelDisplayName(session) || "unknown";
    ctx.showMessage(
      `Current model: ${current}\n` +
      "Use /model to select a new model.\n" +
      "For models marked 'key missing', run 'swarmflow init' or select the model to import/paste a key.",
    );
    return;
  }

  if (!session.switchModel) {
    ctx.showMessage("Model switching is not supported in this session.");
    return;
  }

  try {
    const { target } = parseModelArgs(trimmed);
    const resolvedSelection = await pickResolvedModelSelection(ctx, {
      initialTarget: target,
      flatMessage: "Select model",
    });
    if (!resolvedSelection) {
      ctx.showMessage("Model switch cancelled.");
      return;
    }
    const { selectedConfigName, selectedHint } = resolvedSelection;

    // Switch the active runtime in place; the session history remains intact.
    session.switchModel(selectedConfigName);
    session.setPersistedModelSelection?.({
      modelConfigName: selectedConfigName,
      modelProvider: resolvedSelection.modelProvider,
      modelSelectionKey: resolvedSelection.modelSelectionKey,
      modelId: resolvedSelection.modelId,
    });

    // Prompt for thinking level if the new model supports it
    await promptThinkingLevel(ctx);
    persistModelSelection(ctx);
    ctx.autoSave();

    void selectedHint;
  } catch (e) {
    ctx.showMessage(`Failed to switch model: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ------------------------------------------------------------------
// /key command 鈥?manage provider API keys (replace / remove / import)
// ------------------------------------------------------------------

function keyOptions(ctx: CommandOptionsContext): CommandOption[] {
  return toCommandPickerOptions(
    buildCredentialEndpointTree({ session: ctx.session }),
  ) as CommandOption[];
}

/** Re-resolve runtime model configs after a provider's key changed. */
function applyCredentialChange(ctx: CommandContext, providerId: string): void {
  ctx.session.config?.invalidateModelsByProvider?.(providerId);
  if (ctx.session.primaryAgent?.modelConfig?.provider === providerId) {
    ctx.session.reloadCurrentModelConfig?.();
  }
  ctx.autoSave();
}

/**
 * /key command: replace / remove / import the API key of a provider endpoint.
 * Covers env + managed registry providers and custom providers; OAuth and local
 * providers are excluded (OAuth uses /codex /copilot).
 */
async function cmdKey(ctx: CommandContext, args: string): Promise<void> {
  const adapter = createCommandPromptAdapter(ctx);
  if (!adapter || !ctx.promptCommandPicker) {
    ctx.showMessage("API key management is not available in this UI.");
    return;
  }

  let providerId = args.trim();
  if (!providerId) {
    const picked = await ctx.promptCommandPicker(
      keyOptions({ session: ctx.session, store: ctx.store }),
      { title: "Manage API key" },
    );
    providerId = picked?.value ?? "";
    if (!providerId) {
      ctx.showMessage("Cancelled.");
      return;
    }
  }

  const settings = loadGlobalSettings(ctx.swarmflowHomeDir);
  const label = settings.providers?.[providerId]?.label;

  try {
    const result = await runCredentialManageFlow(providerId, adapter, {
      homeDir: ctx.swarmflowHomeDir,
      label,
    });

    if (result.status === "skipped") {
      ctx.showMessage("No changes made.");
      return;
    }

    applyCredentialChange(ctx, providerId);

    if (result.status === "removed") {
      let msg = `Removed the saved key for ${result.label}.`;
      if (result.shellMayResurface) {
        msg += `\nNote: ${result.envVar} may still be exported in your shell 鈥?`
          + "it will be used again on next launch. To fully disable, unset it in your shell.";
      }
      ctx.showMessage(msg);
    } else {
      const verb = result.source === "imported" ? "Imported" : "Updated";
      ctx.showMessage(`${verb} the API key for ${result.label}.`);
    }
  } catch (e) {
    ctx.showMessage(`Failed to manage API key: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Local provider discovery sub-flow for /model.
 * Scans the server, lets user pick a model, registers it, and switches.
 */
async function cmdModelLocalDiscover(ctx: CommandContext, providerId: string): Promise<void> {
  const session = ctx.session;
  const preset = findProviderPreset(providerId);
  if (!preset?.localServer) {
    ctx.showMessage(`'${providerId}' is not a local provider.`);
    return;
  }
  if (!ctx.promptSelect) {
    ctx.showMessage("Interactive model discovery is not available in this UI.");
    return;
  }

  const defaultUrl = preset.defaultBaseUrl ?? "http://localhost:11434/v1";

  // Let user confirm or change the URL
  const urlChoice = await ctx.promptSelect({
    message: `${preset.name}: Server URL`,
    options: [
      { label: `Use default (${defaultUrl})`, value: defaultUrl },
      { label: "Enter custom URL...", value: "__custom__" },
    ],
  });
  if (!urlChoice) return;

  let baseUrl = urlChoice;
  if (urlChoice === "__custom__") {
    const custom = await ctx.promptSecret?.({
      message: `${preset.name}: Enter server URL`,
    });
    if (!custom?.trim()) return;
    baseUrl = custom.trim();
  }

  // Discover models 鈥?try without key first, then ask if needed
  ctx.showMessage(`Scanning ${baseUrl} ...`);
  let apiKey = "local";
  let discovered = await fetchModelsFromServer(baseUrl, 5000, apiKey);
  if (discovered.length === 0) {
    // May be an auth issue 鈥?ask for API key
    const keyInput = await ctx.promptSecret?.({
      message: `${preset.name}: API key (Enter to skip if none required)`,
      allowEmpty: true,
    });
    if (keyInput?.trim()) {
      apiKey = keyInput.trim();
      discovered = await fetchModelsFromServer(baseUrl, 5000, apiKey);
    }
  }
  if (discovered.length === 0) {
    ctx.showMessage(
      `No models found at ${baseUrl}.\n` +
      "Make sure the server is running and has at least one model loaded.",
    );
    return;
  }

  // Let user pick a model
  const modelChoice = await ctx.promptSelect({
    message: `${preset.name}: ${discovered.length} model(s) found`,
    options: discovered.map((m) => ({
      label: m.contextLength
        ? `${m.id} (${Math.round(m.contextLength / 1024)}K ctx)`
        : m.id,
      value: m.id,
    })),
  });
  if (!modelChoice) return;

  let contextLength = discovered.find((m) => m.id === modelChoice)?.contextLength;
  if (!contextLength) {
    // Most local servers don't report context length via /v1/models.
    // Prompt the user to specify it (same as init wizard).
    const ctxChoice = await ctx.promptSelect({
      message: `${preset.name}: Context length not reported by server`,
      options: [
        { label: "8K", value: "8192" },
        { label: "32K", value: "32768" },
        { label: "64K", value: "65536" },
        { label: "128K", value: "131072" },
        { label: "Enter custom...", value: "__custom__" },
      ],
    });
    if (!ctxChoice) return;
    if (ctxChoice === "__custom__") {
      const ctxInput = await ctx.promptSecret?.({
        message: `${preset.name}: Context length (tokens)`,
      });
      contextLength = parseInt(ctxInput ?? "", 10) || 32768;
    } else {
      contextLength = parseInt(ctxChoice, 10);
    }
  }

  // Register the model in config
  const config = session.config;
  const rtName = runtimeModelName(providerId, modelChoice);
  config.upsertModelRaw(rtName, {
    provider: providerId,
    model: modelChoice,
    api_key: apiKey,
    base_url: baseUrl,
    context_length: contextLength,
    supports_web_search: false,
  });

  // Persist local provider config to settings.json so it survives restarts
  {
    const existing = loadGlobalSettings(ctx.swarmflowHomeDir);
    const providerEntry: ProviderEntry = {
      base_url: baseUrl,
      model: modelChoice,
      context_length: contextLength,
    };
    if (apiKey !== "local") providerEntry.api_key = apiKey;
    persistSettingsPatch({
      providers: {
        ...(existing.providers ?? {}),
        [providerId]: providerEntry,
      },
    }, ctx.swarmflowHomeDir);
  }

  // Switch to the new model in place.
  session.switchModel(rtName);
  session.setPersistedModelSelection?.({
    modelConfigName: rtName,
    modelProvider: providerId,
    modelSelectionKey: modelChoice,
    modelId: modelChoice,
  });

  // Prompt for thinking level if the new model supports it
  await promptThinkingLevel(ctx);
  persistModelSelection(ctx);
  ctx.autoSave();

}

// ------------------------------------------------------------------
// "Add custom provider..." 鈥?multi-page wizard for arbitrary
// OpenAI-/Anthropic-compatible endpoints with one or more models.
// ------------------------------------------------------------------

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return n % 1_000_000 === 0 ? `${n / 1_000_000}M` : `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1000)}K`;
}

function slugifyProviderId(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "custom";
}

/**
 * Normalize a user-pasted endpoint into the base URL its SDK expects, and
 * infer the wire protocol from a recognized suffix.
 *
 * Provider docs almost always show the *full* endpoint (e.g.
 * `https://openrouter.ai/api/v1/chat/completions`), but both SDKs append their
 * own path to `baseURL` 鈥?OpenAI adds `/chat/completions`, Anthropic adds
 * `/v1/messages`. Pasting the full endpoint therefore double-appends and 404s.
 * We strip the recognized tail so the base is what the SDK wants:
 *   - `.../v1/chat/completions` 鈫?base `.../v1`         protocol `openai-chat`
 *   - `.../v1/messages`         鈫?base `...` (no /v1)    protocol `anthropic`
 * `changed` reports whether we rewrote the input (so the caller can tell the
 * user). `protocol` is null when no suffix matched 鈥?caller still asks.
 */
export function normalizeEndpointUrl(raw: string): {
  baseUrl: string;
  protocol: "openai-chat" | "anthropic" | null;
  changed: boolean;
} {
  const trimmed = raw.trim().replace(/\/+$/, "");
  // Anthropic Messages API: the SDK appends `/v1/messages`, so the base must
  // drop it entirely (including the `/v1`).
  if (/\/messages$/i.test(trimmed)) {
    const baseUrl = trimmed.replace(/\/(?:v\d+\/)?messages$/i, "");
    return { baseUrl, protocol: "anthropic", changed: baseUrl !== trimmed };
  }
  // OpenAI Chat Completions: the SDK appends `/chat/completions`; keep the `/v1`.
  if (/\/chat\/completions$/i.test(trimmed)) {
    const baseUrl = trimmed.replace(/\/chat\/completions$/i, "");
    return { baseUrl, protocol: "openai-chat", changed: baseUrl !== trimmed };
  }
  return { baseUrl: trimmed, protocol: null, changed: trimmed !== raw.trim() };
}

/** Best-effort reachability probe for a custom endpoint. */
async function testEndpoint(baseUrl: string, apiKey: string | undefined, protocol: string): Promise<{ ok: boolean; detail: string }> {
  if (protocol === "anthropic") return { ok: true, detail: "skipped (Anthropic endpoints have no /v1/models)" };
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const headers: Record<string, string> = {};
    if (apiKey && apiKey !== "local") headers["Authorization"] = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) return { ok: true, detail: `reachable (HTTP ${res.status})` };
    return { ok: false, detail: `HTTP ${res.status}${res.status === 401 || res.status === 403 ? " 鈥?check API key" : ""}` };
  } catch (e) {
    return { ok: false, detail: `unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Prompt for a token count: suggested value (if any) + common presets + custom; optional skip. */
async function promptTokenCount(
  ctx: CommandContext,
  message: string,
  suggested: number | undefined,
  opts: { allowSkip?: boolean },
): Promise<number | undefined> {
  const choices: CommandOption[] = [];
  if (suggested && suggested > 0) choices.push({ label: `${fmtTokens(suggested)}  (from models.dev)`, value: String(suggested) });
  if (opts.allowSkip) choices.push({ label: "Use default (skip)", value: "__skip__" });
  for (const v of [8192, 32768, 65536, 131072, 200000, 1_000_000]) {
    if (v !== suggested) choices.push({ label: fmtTokens(v), value: String(v) });
  }
  choices.push({ label: "Enter custom...", value: "__custom__" });
  const c = await ctx.promptSelect!({ message, options: choices });
  if (!c || c === "__skip__") return undefined;
  if (c === "__custom__") {
    const inp = (await ctx.promptSecret!({ message: "Enter number of tokens" }))?.trim();
    const n = parseInt(inp ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  return parseInt(c, 10);
}

/**
 * Discover (/v1/models) + multi-model add loop. Returns the models added, or
 * null if the user cancelled. Shared by the add-provider wizard and the
 * "add a model" management action. Doesn't close after each model.
 */
async function addModelsInteractive(
  ctx: CommandContext,
  opts: { label: string; baseUrl: string; protocol: string; apiKey?: string; existingIds?: Set<string> },
): Promise<CustomModelEntry[] | null> {
  const { label, baseUrl, protocol, apiKey } = opts;
  let discovered: Array<{ id: string; contextLength?: number }> = [];
  if (protocol === "openai-chat") {
    ctx.showMessage(`Scanning ${baseUrl} for models...`);
    discovered = await fetchModelsFromServer(baseUrl, 6000, apiKey || "local");
  }
  const added: CustomModelEntry[] = [];
  const addedIds = new Set<string>(opts.existingIds ?? []);
  while (true) {
    const remaining = discovered.filter((d) => !addedIds.has(d.id));
    const choices: CommandOption[] = [];
    for (const d of remaining) {
      choices.push({ label: d.contextLength ? `${d.id}  (${fmtTokens(d.contextLength)} ctx)` : d.id, value: `pick:${d.id}` });
    }
    choices.push({ label: "+ Enter a model id manually", value: "__manual__" });
    if (added.length > 0) choices.push({ label: `鉁?Done 鈥?save ${added.length} model${added.length > 1 ? "s" : ""}`, value: "__done__" });
    choices.push({ label: added.length > 0 ? "Cancel (discard)" : "Cancel", value: "__cancel__" });
    const choice = await ctx.promptSelect!({
      message: discovered.length ? `${label} 鈥?pick a model to add (${remaining.length} available)` : `${label} 鈥?add a model`,
      options: choices,
    });
    if (!choice || choice === "__cancel__") return null;
    if (choice === "__done__") return added;
    const modelId = choice === "__manual__"
      ? ((await ctx.promptSecret!({ message: `${label} 鈥?model id` }))?.trim() ?? "")
      : choice.slice("pick:".length);
    if (!modelId || addedIds.has(modelId)) continue;
    const sug = await fetchModelSpecSuggestion(modelId, { homeDir: ctx.swarmflowHomeDir });
    const reportedCtx = discovered.find((d) => d.id === modelId)?.contextLength;
    const ctxLen = await promptTokenCount(ctx, `${label} / ${modelId} 鈥?context length (required)`, sug?.contextLength ?? reportedCtx, { allowSkip: false });
    if (!ctxLen) { ctx.showMessage("Context length is required 鈥?model not added."); continue; }
    const mmChoice = await ctx.promptSelect!({
      message: `${label} / ${modelId} 鈥?multimodal (image input)?`,
      options: [
        { label: `No${sug?.multimodal ? "" : "  (default)"}`, value: "no" },
        { label: `Yes${sug?.multimodal ? "  (models.dev says yes)" : ""}`, value: "yes" },
      ],
    });
    if (mmChoice === undefined) continue;
    const maxOut = await promptTokenCount(ctx, `${label} / ${modelId} 鈥?max output tokens (optional)`, sug?.maxOutputTokens, { allowSkip: true });
    const entry: CustomModelEntry = { id: modelId, context_length: ctxLen };
    if (mmChoice === "yes") entry.multimodal = true;
    if (maxOut) entry.max_output_tokens = maxOut;
    if (sug?.thinkingLevels?.length) entry.thinking_levels = sug.thinkingLevels;
    added.push(entry);
    addedIds.add(modelId);
    ctx.showMessage(`Added ${modelId}${sug ? " (specs from models.dev)" : ""}. Pick another or choose Done.`);
  }
}

/** Register one custom model into the live runtime config. */
function registerCustomModel(config: any, providerId: string, baseUrl: string, protocol: string, apiKeyRef: string, m: CustomModelEntry): void {
  config.upsertModelRaw(`${providerId}:${m.id}`, {
    provider: providerId,
    model: m.id,
    api_key: apiKeyRef,
    base_url: baseUrl,
    context_length: m.context_length,
    transport_protocol: protocol === "anthropic" ? "anthropic" : "chat",
    supports_multimodal: m.multimodal ?? false,
    supports_web_search: false,
    ...(m.max_output_tokens ? { max_tokens: m.max_output_tokens } : {}),
  });
}

async function cmdAddCustomProvider(ctx: CommandContext): Promise<boolean> {
  if (!ctx.promptSecret || !ctx.promptSelect) {
    ctx.showMessage("Interactive provider setup is not available in this UI.");
    return false;
  }
  const config = ctx.session.config;

  // 1. Display name 鈫?unique provider id
  const label = (await ctx.promptSecret({ message: "Custom provider 鈥?display name (e.g. My LLM)" }))?.trim();
  if (!label) return false;
  const existingProviders = loadGlobalSettings(ctx.swarmflowHomeDir).providers ?? {};
  const baseId = slugifyProviderId(label);
  let providerId = baseId;
  for (let i = 2; existingProviders[providerId] || config.modelNames.some((m: string) => m.startsWith(providerId + ":")); i++) {
    providerId = `${baseId}-${i}`;
  }

  // 2. Endpoint URL 鈥?accept the full endpoint from provider docs and normalize.
  const rawUrl = (await ctx.promptSecret({ message: `${label} 鈥?endpoint URL (paste the full URL from the docs, e.g. https://api.example.com/v1/chat/completions)` }))?.trim();
  if (!rawUrl) return false;
  const norm = normalizeEndpointUrl(rawUrl);
  const baseUrl = norm.baseUrl;
  if (norm.changed) ctx.showMessage(`鈩?Using base URL ${baseUrl}`);

  // 3. Protocol 鈥?inferred from the URL suffix when recognized, else asked.
  let protocol: string | undefined;
  if (norm.protocol) {
    protocol = norm.protocol;
    ctx.showMessage(`鈩?Detected ${norm.protocol === "anthropic" ? "Anthropic" : "OpenAI"}-compatible endpoint 鈥?protocol set to "${norm.protocol}".`);
  } else {
    protocol = await ctx.promptSelect({
      message: `${label} 鈥?API protocol`,
      options: [
        { label: "OpenAI-compatible  (most endpoints)", value: "openai-chat" },
        { label: "Anthropic-compatible", value: "anthropic" },
      ],
    });
  }
  if (!protocol) return false;

  // 4. API key (optional)
  const apiKey = (await ctx.promptSecret({ message: `${label} 鈥?API key (Enter to skip if none required)`, allowEmpty: true }))?.trim();

  // Reachability probe (informational; the user can still continue either way).
  const probe = await testEndpoint(baseUrl, apiKey, protocol);
  ctx.showMessage(probe.ok ? `鉁?Endpoint ${probe.detail}` : `鈿?Endpoint ${probe.detail} 鈥?you can still continue and add models manually.`);

  // 5-6. Discover + add models (multi-model loop, doesn't close after each).
  const added = await addModelsInteractive(ctx, { label, baseUrl, protocol, apiKey });
  if (!added || added.length === 0) return false;

  // 7. Persist to settings.json + register in runtime config
  const entry: ProviderEntry = { custom: true, label, base_url: baseUrl, protocol: protocol as ProviderEntry["protocol"], models: added };
  let apiKeyRef = "local";
  if (apiKey) {
    const envVar = customProviderEnvVar(providerId);
    setDotenvKey(envVar, apiKey, ctx.swarmflowHomeDir);
    entry.api_key = `\${${envVar}}`;
    apiKeyRef = `\${${envVar}}`;
  }
  const cur = loadGlobalSettings(ctx.swarmflowHomeDir);
  persistSettingsPatch({ providers: { ...(cur.providers ?? {}), [providerId]: entry } }, ctx.swarmflowHomeDir);

  for (const m of added) registerCustomModel(config, providerId, baseUrl, protocol, apiKeyRef, m);
  ctx.showMessage(`鉁?Added custom provider "${label}" with ${added.length} model${added.length > 1 ? "s" : ""}.`);
  return true;
}

/** Manage an existing custom provider: add/remove models, delete the provider. */
async function cmdManageCustomProvider(ctx: CommandContext, providerId: string): Promise<void> {
  if (!ctx.promptSelect) { ctx.showMessage("Not available in this UI."); return; }
  const config = ctx.session.config;
  const settings = loadGlobalSettings(ctx.swarmflowHomeDir);
  const entry = settings.providers?.[providerId];
  if (!entry?.custom) { ctx.showMessage(`"${providerId}" is not a custom provider.`); return; }
  const label = entry.label ?? providerId;
  const models = entry.models ?? [];

  const action = await ctx.promptSelect({
    message: `Manage "${label}" (${models.length} model${models.length === 1 ? "" : "s"})`,
    options: [
      { label: "Add model(s)", value: "add" },
      { label: "Edit endpoint / API key", value: "edit" },
      { label: "Remove a model", value: "rm" },
      { label: "Delete this provider", value: "del" },
      { label: "Cancel", value: "cancel" },
    ],
  });
  if (!action || action === "cancel") return;

  const protocol = entry.protocol ?? "openai-chat";
  const apiKeyRef = entry.api_key ?? "local";
  const apiKeyForDiscover = apiKeyRef.startsWith("${") ? process.env[apiKeyRef.slice(2, -1)] : apiKeyRef;
  const saveProviders = (next: Record<string, ProviderEntry>) =>
    persistSettingsPatch({ providers: next }, ctx.swarmflowHomeDir);

  if (action === "edit") {
    const newUrl = (await ctx.promptSecret!({ message: `${label} 鈥?new endpoint URL (Enter to keep "${entry.base_url}")`, allowEmpty: true }))?.trim();
    const newKey = (await ctx.promptSecret!({ message: `${label} 鈥?new API key (Enter to keep current)`, allowEmpty: true }))?.trim();
    let newBaseUrl = entry.base_url || "";
    if (newUrl) {
      const norm = normalizeEndpointUrl(newUrl);
      newBaseUrl = norm.baseUrl;
      if (norm.changed) ctx.showMessage(`鈩?Using base URL ${newBaseUrl}`);
    }
    let apiKeyField = entry.api_key;
    if (newKey) {
      const envVar = customProviderEnvVar(providerId);
      setDotenvKey(envVar, newKey, ctx.swarmflowHomeDir);
      apiKeyField = `\${${envVar}}`;
    }
    const updated: ProviderEntry = { ...entry, base_url: newBaseUrl, ...(apiKeyField ? { api_key: apiKeyField } : {}) };
    saveProviders({ ...settings.providers, [providerId]: updated });
    const ref = apiKeyField ?? "local";
    for (const m of models) registerCustomModel(config, providerId, newBaseUrl, protocol, ref, m);
    const probeKey = newKey || (apiKeyField?.startsWith("${") ? process.env[apiKeyField.slice(2, -1)] : apiKeyField);
    const probe = await testEndpoint(newBaseUrl, probeKey, protocol);
    ctx.showMessage(`Updated "${label}". ${probe.ok ? "鉁?" + probe.detail : "鈿?" + probe.detail}`);
    return;
  }

  if (action === "add") {
    const existingIds = new Set(models.map((m) => m.id));
    const newModels = await addModelsInteractive(ctx, {
      label, baseUrl: entry.base_url ?? "", protocol, apiKey: apiKeyForDiscover, existingIds,
    });
    if (!newModels || newModels.length === 0) return;
    const merged = [...models, ...newModels];
    saveProviders({ ...settings.providers, [providerId]: { ...entry, models: merged } });
    for (const m of newModels) registerCustomModel(config, providerId, entry.base_url ?? "", protocol, apiKeyRef, m);
    ctx.showMessage(`Added ${newModels.length} model${newModels.length > 1 ? "s" : ""} to "${label}".`);
    return;
  }

  if (action === "rm") {
    if (models.length === 0) { ctx.showMessage("No models to remove."); return; }
    const pick = await ctx.promptSelect({
      message: `Remove which model from "${label}"?`,
      options: models.map((m) => ({ label: m.id, value: m.id })),
    });
    if (!pick) return;
    const kept = models.filter((m) => m.id !== pick);
    if (kept.length === 0) {
      // removing the last model deletes the provider
      const next = { ...settings.providers }; delete next[providerId];
      saveProviders(next);
    } else {
      saveProviders({ ...settings.providers, [providerId]: { ...entry, models: kept } });
    }
    config.removeModel?.(`${providerId}:${pick}`);
    ctx.showMessage(`Removed model ${pick}${kept.length === 0 ? ` and deleted empty provider "${label}"` : ""}.`);
    return;
  }

  if (action === "del") {
    const confirm = await ctx.promptSelect({
      message: `Delete custom provider "${label}" and its ${models.length} model(s)?`,
      options: [{ label: "Yes, delete", value: "yes" }, { label: "No, keep it", value: "no" }],
    });
    if (confirm !== "yes") return;
    const next = { ...settings.providers }; delete next[providerId];
    saveProviders(next);
    for (const m of models) config.removeModel?.(`${providerId}:${m.id}`);
    ctx.showMessage(`Deleted custom provider "${label}".`);
  }
}

// ------------------------------------------------------------------
// /diff 鈥?configure inline write/edit diff display
// ------------------------------------------------------------------

type DiffDisplayMode = NonNullable<SwarmflowSettings["diff_display"]>;

function normalizeDiffDisplayMode(value: unknown): DiffDisplayMode {
  return value === "full" ? "full" : "compact";
}

function diffDisplayOptions(_ctx: CommandOptionsContext): CommandOption[] {
  const current = normalizeDiffDisplayMode(loadGlobalSettings().diff_display);
  const mark = (mode: DiffDisplayMode) => mode === current ? " (current)" : "";
  return [
    {
      label: `Compact${mark("compact")}`,
      value: "compact",
      detail: "Short previews",
    },
    {
      label: `Full${mark("full")}`,
      value: "full",
      detail: "Expand inline",
    },
  ];
}

async function cmdDiff(ctx: CommandContext, args: string): Promise<void> {
  const hint = ctx.showHint ?? ctx.showMessage;
  let choice = args.trim().toLowerCase();

  if (!choice && ctx.promptCommandPicker) {
    const picked = await ctx.promptCommandPicker(
      diffDisplayOptions({ session: ctx.session, store: ctx.store }),
      { title: "Diff Display" },
    );
    if (!picked) return;
    choice = picked.value;
  }

  if (choice === "compact" || choice === "full") {
    persistSettingsPatch({ diff_display: choice }, ctx.swarmflowHomeDir);
    ctx.showMessage(`__diff_display__:${choice}`);
    hint(`Diff display: ${choice}`);
    return;
  }

  const current = normalizeDiffDisplayMode(loadGlobalSettings(ctx.swarmflowHomeDir).diff_display);
  ctx.showMessage(`Diff display is "${current}".\nUsage: /diff compact | full`);
}

// ------------------------------------------------------------------
// /autoupdate 鈥?toggle automatic update checks
// ------------------------------------------------------------------

// ------------------------------------------------------------------
// /theme 鈥?pick light / dark / auto
// ------------------------------------------------------------------

function themeModeOptions(_ctx: CommandOptionsContext): CommandOption[] {
  const current = loadGlobalSettings().theme_mode ?? "auto";
  const mark = (v: string) => (v === current ? " (current)" : "");
  return [
    { label: `Auto (follow terminal)${mark("auto")}`, value: "auto" },
    { label: `Light${mark("light")}`, value: "light" },
    { label: `Dark${mark("dark")}`, value: "dark" },
  ];
}

async function cmdTheme(ctx: CommandContext, args: string): Promise<void> {
  const hint = ctx.showHint ?? ctx.showMessage;
  let choice = args.trim().toLowerCase();

  if (!choice && ctx.promptCommandPicker) {
    const picked = await ctx.promptCommandPicker(
      themeModeOptions({ session: ctx.session, store: ctx.store }),
    );
    if (!picked) return;
    choice = picked.value;
  }

  if (choice === "auto" || choice === "light" || choice === "dark") {
    persistSettingsPatch({ theme_mode: choice }, ctx.swarmflowHomeDir);
    // Magic message 鈥?TUI intercepts and updates React state without restart.
    ctx.showMessage(`__theme_mode__:${choice}`);
    hint(`Theme: ${choice}`);
    return;
  }

  const current = loadGlobalSettings().theme_mode ?? "auto";
  ctx.showMessage(`Theme mode is "${current}".\nUsage: /theme auto | light | dark`);
}

// ------------------------------------------------------------------
// /autoupdate 鈥?toggle automatic update checks
// ------------------------------------------------------------------

function autoUpdateOptions(_ctx: CommandOptionsContext): CommandOption[] {
  const current = loadGlobalSettings().auto_update !== false;
  return [
    { label: current ? "On (current)" : "On", value: "on" },
    { label: current ? "Off" : "Off (current)", value: "off" },
  ];
}

async function cmdAutoUpdate(ctx: CommandContext, args: string): Promise<void> {
  const hint = ctx.showHint ?? ctx.showMessage;
  let choice = args.trim().toLowerCase();

  if (!choice && ctx.promptCommandPicker) {
    const picked = await ctx.promptCommandPicker(
      autoUpdateOptions({ session: ctx.session, store: ctx.store }),
    );
    if (!picked) return;
    choice = picked.value;
  }

  if (choice === "on" || choice === "off") {
    const enabled = choice === "on";
    const wasEnabled = loadGlobalSettings(ctx.swarmflowHomeDir).auto_update !== false;
    persistSettingsPatch({ auto_update: enabled }, ctx.swarmflowHomeDir);
    hint(`Auto-update: ${enabled ? "ON" : "OFF"}`);
    // Turning auto-update ON kicks off an immediate background check 鈥?the same
    // one that runs at startup when auto-update is enabled. The TUI's update
    // poll picks up the resulting state and shows the toast if an update exists.
    if (enabled && !wasEnabled) {
      try {
        const { checkForUpdates, setUpdateStateGetter } = await import("./lifecycle/update-check.js");
        setUpdateStateGetter(checkForUpdates(VERSION, ctx.swarmflowHomeDir, true));
      } catch { /* best effort 鈥?the setting is already persisted */ }
    }
    return;
  }

  const current = loadGlobalSettings().auto_update !== false;
  ctx.showMessage(`Auto-update is ${current ? "ON" : "OFF"}.\nUsage: /autoupdate on | off`);
}

// ------------------------------------------------------------------
// /autocopy 鈥?toggle copy-on-select (auto-copy a drag selection)
// ------------------------------------------------------------------

function autoCopyOptions(_ctx: CommandOptionsContext): CommandOption[] {
  const current = loadGlobalSettings().copy_on_select !== false;
  return [
    { label: current ? "On (current)" : "On", value: "on" },
    { label: current ? "Off" : "Off (current)", value: "off" },
  ];
}

async function cmdAutoCopy(ctx: CommandContext, args: string): Promise<void> {
  const hint = ctx.showHint ?? ctx.showMessage;
  let choice = args.trim().toLowerCase();

  if (!choice && ctx.promptCommandPicker) {
    const picked = await ctx.promptCommandPicker(
      autoCopyOptions({ session: ctx.session, store: ctx.store }),
    );
    if (!picked) return;
    choice = picked.value;
  }

  if (choice === "on" || choice === "off") {
    const enabled = choice === "on";
    persistSettingsPatch({ copy_on_select: enabled }, ctx.swarmflowHomeDir);
    // Magic message 鈥?the TUI intercepts and flips React state without restart.
    ctx.showMessage(`__copy_on_select__:${enabled ? "on" : "off"}`);
    hint(`Copy-on-select: ${enabled ? "ON" : "OFF"}`);
    return;
  }

  const current = loadGlobalSettings().copy_on_select !== false;
  ctx.showMessage(`Copy-on-select is ${current ? "ON" : "OFF"}.\nUsage: /autocopy on | off`);
}

// ------------------------------------------------------------------
// /rename 鈥?set a custom session title
// ------------------------------------------------------------------

async function cmdRename(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  if (!session || (session.turnCount ?? 0) === 0) {
    ctx.showMessage("Start a conversation first before renaming.");
    return;
  }

  const trimmed = args.trim();
  if (trimmed) {
    session.setTitle?.(trimmed);
    ctx.autoSave();
    ctx.showMessage(`Session renamed to: ${trimmed}`);
    return;
  }

  // Interactive: prompt for new title
  if (!ctx.promptSecret) {
    ctx.showMessage("Usage: /rename <new title>");
    return;
  }
  const currentName = session.getDisplayName?.() || "";
  const input = await ctx.promptSecret({
    message: `Rename session (current: ${currentName}):`,
    allowEmpty: true,
  });
  if (input === undefined) return; // cancelled
  const value = input.trim();
  if (value) {
    session.setTitle?.(value);
    ctx.autoSave();
    ctx.showMessage(`Session renamed to: ${value}`);
  } else {
    session.setTitle?.("");
    ctx.autoSave();
    ctx.showMessage("Session title cleared (using auto-generated name).");
  }
}

// ------------------------------------------------------------------
// /codex command
// ------------------------------------------------------------------

function codexOptions(): CommandOption[] {
  const token = readOAuthAccessToken();
  const loggedIn = hasOAuthTokens() && token && !isTokenExpiring(token);
  const options: CommandOption[] = [];
  if (loggedIn) {
    options.push({ label: "status", value: "status" });
    options.push({ label: "logout", value: "logout" });
  } else {
    options.push({ label: "login", value: "login" });
  }
  return options;
}

async function cmdCodex(ctx: CommandContext, args: string): Promise<void> {
  const sub = args.trim().toLowerCase();

  if (sub === "login" || sub === "") {
    const token = readOAuthAccessToken();
    const loggedIn = hasOAuthTokens() && token && !isTokenExpiring(token);
    if (loggedIn && sub !== "login") {
      ctx.showMessage("Already logged in to OpenAI ChatGPT.");
      return;
    }
    if (ctx.requestOAuthLogin) {
      const tokens = await ctx.requestOAuthLogin("codex");
      if (!tokens) {
        ctx.showMessage("Login cancelled.");
      }
    } else {
      ctx.showMessage("OAuth login is not available in this environment.");
    }
    return;
  }

  if (sub === "logout") {
    clearOAuthTokens();
    ctx.showMessage("OpenAI ChatGPT tokens cleared.");
    return;
  }

  if (sub === "status") {
    const token = readOAuthAccessToken();
    if (!token || !hasOAuthTokens()) {
      ctx.showMessage("Not logged in.");
      return;
    }
    if (isTokenExpiring(token)) {
      ctx.showMessage("Logged in (token expiring soon).");
    } else {
      ctx.showMessage("Logged in.");
    }
    return;
  }

  ctx.showMessage(`Unknown /codex subcommand: ${sub}`);
}

// ------------------------------------------------------------------
// /copilot command
// ------------------------------------------------------------------

function copilotOptions(): CommandOption[] {
  const options: CommandOption[] = [];
  if (hasGitHubTokens()) {
    options.push({ label: "status", value: "status" });
    options.push({ label: "logout", value: "logout" });
  } else {
    options.push({ label: "login", value: "login" });
  }
  return options;
}

async function cmdCopilot(ctx: CommandContext, args: string): Promise<void> {
  const sub = args.trim().toLowerCase();

  if (sub === "login" || sub === "") {
    if (hasGitHubTokens() && sub !== "login") {
      ctx.showMessage("Already logged in to GitHub Copilot.");
      return;
    }
    if (ctx.requestOAuthLogin) {
      const result = await ctx.requestOAuthLogin("copilot");
      if (!result) {
        ctx.showMessage("Login cancelled.");
      }
    } else {
      ctx.showMessage("OAuth login is not available in this environment.");
    }
    return;
  }

  if (sub === "logout") {
    clearGitHubTokens();
    // Drop the per-account model-visibility cache so a future login for a
    // different plan doesn't inherit the wrong hidden-model set.
    try {
      const { clearCopilotModelsCache } = await import(
        "./providers/copilot-models-cache.js"
      );
      clearCopilotModelsCache();
    } catch {
      // ignore
    }
    ctx.showMessage("GitHub Copilot tokens cleared.");
    return;
  }

  if (sub === "status") {
    if (!hasGitHubTokens()) {
      ctx.showMessage("Not logged in.");
      return;
    }
    ctx.showMessage("Logged in.");
    return;
  }

  ctx.showMessage(`Unknown /copilot subcommand: ${sub}`);
}

// ------------------------------------------------------------------
// /tier command 鈥?configure sub-agent model tiers
// ------------------------------------------------------------------

function describeTierModel(session: any, entry: ModelTierEntry): string {
  const configName =
    typeof session?.config?.findModelConfigName === "function"
      ? session.config.findModelConfigName(entry.provider, entry.model_id)
      : undefined;
  const desc = describeModel({
    providerId: entry.provider,
    selectionKey: entry.selection_key,
    modelId: entry.model_id,
    configName: configName ?? `${entry.provider}:${entry.selection_key}`,
  });
  return desc.scopedDetailedLabel || `${entry.provider}:${entry.selection_key}`;
}

function tierOptions(ctx: CommandOptionsContext): CommandOption[] {
  const tiers = ctx.session?.config?.modelTiers ?? {};
  const levels: Array<"high" | "medium" | "low"> = ["high", "medium", "low"];
  const opts: CommandOption[] = [];

  for (const level of levels) {
    const entry = tiers[level];
    if (entry) {
      const label = describeTierModel(ctx.session, entry);
      const thinkingSuffix = entry.thinking_level ? ` [${entry.thinking_level}]` : "";
      opts.push({
        label: `${level}: ${label}${thinkingSuffix}`,
        value: level,
      });
    } else {
      opts.push({
        label: `${level}: (inherits main model)`,
        value: level,
      });
    }
  }

  opts.push({ label: "Clear all tiers", value: "clear" });
  return opts;
}

async function cmdTier(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  const tiers: { high?: ModelTierEntry; medium?: ModelTierEntry; low?: ModelTierEntry } =
    session.config?.modelTiers ?? {};
  const trimmed = args.trim().toLowerCase();

  if (!trimmed) {
    // No arg 鈥?show current tiers
    const levels: Array<"high" | "medium" | "low"> = ["high", "medium", "low"];
    const lines = ["Model tiers:"];
    for (const level of levels) {
      const entry = tiers[level];
      if (entry) {
        const label = describeTierModel(session, entry);
        const thinkingSuffix = entry.thinking_level ? ` [${entry.thinking_level}]` : "";
        lines.push(`  ${level}: ${label}${thinkingSuffix}`);
      } else {
        lines.push(`  ${level}: (inherits main model)`);
      }
    }
    lines.push("");
    lines.push("Use /tier to configure a tier.");
    ctx.showMessage(lines.join("\n"));
    return;
  }

  // Handle "clear" 鈥?remove all tiers
  if (trimmed === "clear") {
    persistSettingsPatch({ model_tiers: {} }, ctx.swarmflowHomeDir);
    // Update runtime config
    session.config?.setModelTiers?.({});
    ctx.showMessage("All model tiers cleared. Sub-agents will inherit the main model.");
    return;
  }

  // Handle tier level selection
  const validLevels: Array<"high" | "medium" | "low"> = ["high", "medium", "low"];
  if (!validLevels.includes(trimmed as any)) {
    ctx.showMessage(`Invalid tier: "${trimmed}". Use high, medium, low, or clear.`);
    return;
  }
  const level = trimmed as "high" | "medium" | "low";

  // Prompt for action: assign model or clear this tier
  if (!ctx.promptSelect) {
    ctx.showMessage("Interactive tier configuration is not available in this UI.");
    return;
  }

  const currentEntry = tiers[level];
  const actionOptions: CommandOption[] = [
    { label: "Assign model...", value: "assign" },
  ];
  if (currentEntry) {
    actionOptions.push({ label: "Clear this tier", value: "clear_one" });
  }

  const action = await ctx.promptSelect({
    message: `${level} tier`,
    options: actionOptions,
  });
  if (!action) return;

  if (action === "clear_one") {
    const updatedTiers = { ...tiers };
    delete updatedTiers[level];
    persistSettingsPatch({ model_tiers: updatedTiers }, ctx.swarmflowHomeDir);
    session.config?.setModelTiers?.(updatedTiers);
    ctx.showMessage(`Tier '${level}' cleared. Sub-agents at this level will inherit the main model.`);
    return;
  }

  const resolvedSelection = await pickResolvedModelSelection(ctx, {
    flatMessage: `Select model for ${level} tier`,
  });
  if (!resolvedSelection) {
    ctx.showMessage(`Tier '${level}' configuration cancelled.`);
    return;
  }
  const selectedConfigName = resolvedSelection.selectedConfigName;

  // Get the resolved model's actual model ID for thinking level check
  let resolvedModelId: string;
  try {
    const mc = session.config.getModel(selectedConfigName);
    resolvedModelId = mc.model;
  } catch {
    resolvedModelId = selectedConfigName;
  }

  // Determine thinking level for the chosen model. Required when the model
  // supports thinking; "none" otherwise. Picker offers tier-eligible levels
  // only (native "off" / "none" filtered out). Cancelling aborts the save.
  let thinkingLevel: string;

  if (getThinkingLevels(resolvedModelId).length === 0) {
    thinkingLevel = "none";
  } else {
    const eligible = getTierEligibleThinkingLevels(resolvedModelId);
    if (eligible.length === 0) {
      ctx.showMessage(
        `Tier '${level}' cancelled: model '${resolvedModelId}' has no eligible thinking levels (only off/none).`,
      );
      return;
    }
    const thinkingChoice = await ctx.promptSelect({
      message: `Thinking level for ${level} tier (required)`,
      options: eligible.map((l) => ({ label: l, value: l })),
    });
    if (!thinkingChoice) {
      ctx.showMessage(`Tier '${level}' configuration cancelled (thinking level required).`);
      return;
    }
    thinkingLevel = thinkingChoice;
  }

  // Build the tier entry
  const tierEntry = createModelTierEntry({
    provider: resolvedSelection.modelProvider,
    selectionKey: resolvedSelection.modelSelectionKey,
    modelId: resolvedSelection.modelId,
  }, thinkingLevel);

  // Persist
  const updatedTiers = { ...tiers, [level]: tierEntry };
  persistSettingsPatch({ model_tiers: updatedTiers }, ctx.swarmflowHomeDir);

  // Update runtime config
  session.config?.setModelTiers?.(updatedTiers);

  const displayLabel = describeTierModel(session, tierEntry);
  ctx.showMessage(`Tier '${level}' set to: ${displayLabel} [${thinkingLevel}]`);
}

// ------------------------------------------------------------------
// /review 鈥?code review
// ------------------------------------------------------------------

function loadReviewPromptTemplate(): string {
  const { getBundledAssetsDir } = require("./config/config.js") as { getBundledAssetsDir: () => string };
  const promptPath = join(getBundledAssetsDir(), "prompts", "review.md");
  try {
    return readFileSync(promptPath, "utf-8");
  } catch {
    return "";
  }
}

function buildReviewTarget(kind: string, detail?: string): string {
  switch (kind) {
    case "uncommitted":
      return [
        "Review all uncommitted changes in the current repository.",
        "Run `git diff` for unstaged changes, `git diff --cached` for staged changes,",
        "and `git status --short` to identify untracked files. Read their contents.",
      ].join("\n");
    case "base": {
      const branch = detail || "main";
      return [
        `Review all changes on the current branch compared to \`${branch}\`.`,
        `Run \`git diff ${branch}...HEAD\` to get the diff.`,
        "Also check `git log --oneline " + branch + "..HEAD` for commit context.",
      ].join("\n");
    }
    case "commit": {
      const sha = detail || "HEAD";
      return [
        `Review the specific commit \`${sha}\`.`,
        `Run \`git show ${sha}\` to get the diff and commit message.`,
      ].join("\n");
    }
    default:
      return "Review the changes described in the user instructions below.";
  }
}

function buildReviewPrompt(reviewTarget: string, userInstructions: string): string {
  const template = loadReviewPromptTemplate();
  if (!template) {
    return `Review the following code changes.\n\n${reviewTarget}\n\n${userInstructions}`;
  }
  return template
    .replace("{REVIEW_TARGET}", reviewTarget)
    .replace("{USER_INSTRUCTIONS}", userInstructions || "(No additional instructions.)");
}

function gitCurrentBranch(): string {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const result = spawnSync("git", ["branch", "--show-current"], {
    encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
  });
  return (result.stdout ?? "").trim() || "HEAD";
}

function gitBranchOptions(): CommandOption[] {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const current = gitCurrentBranch();
  const result = spawnSync("git", ["branch", "-a", "--format=%(refname:short)"], {
    encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
  });
  const branches = (result.stdout ?? "").split("\n").map(l => l.trim()).filter(Boolean)
    .filter(b => b !== current && !b.endsWith("/HEAD"));
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const b of branches) {
    const short = b.replace(/^origin\//, "");
    if (!seen.has(short)) {
      seen.add(short);
      deduped.push(b);
    }
  }
  if (deduped.length === 0) {
    return [{ label: "No other branches found", value: "", disabled: true }];
  }
  return deduped.map(b => ({
    label: `${current} 鈫?${b}`,
    value: b,
  }));
}

function gitCommitOptions(): CommandOption[] {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const result = spawnSync("git", ["log", "--oneline", "-20"], {
    encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
  });
  const commits = (result.stdout ?? "").split("\n").map(l => l.trim()).filter(Boolean);
  if (commits.length === 0) {
    return [{ label: "No commits found", value: "", disabled: true }];
  }
  return commits.map(line => {
    const spaceIdx = line.indexOf(" ");
    return {
      label: line,
      value: spaceIdx > 0 ? line.slice(0, spaceIdx) : line,
    };
  });
}

function reviewOptions(_ctx: CommandOptionsContext): CommandOption[] {
  return [
    {
      label: "Review against a base branch",
      value: "base",
      detail: "(PR Style)",
      children: gitBranchOptions(),
    },
    { label: "Review uncommitted changes", value: "uncommitted" },
    {
      label: "Review a commit",
      value: "commit",
      children: gitCommitOptions(),
    },
    { label: "Custom review instructions", value: "custom", customInput: true },
  ];
}

function reviewDisplayText(kind: string, detail: string, note: string): string {
  const parts = ["/review"];
  switch (kind) {
    case "uncommitted": parts.push("uncommitted changes"); break;
    case "base": parts.push(`against ${detail || "base"}`); break;
    case "commit": parts.push(`commit ${detail || "HEAD"}`); break;
    case "custom": break;
  }
  if (note) parts.push(note);
  return parts.join(" ");
}

function dispatchReview(ctx: CommandContext, kind: string, detail: string, note: string): void {
  const target = buildReviewTarget(kind, detail);
  const content = buildReviewPrompt(target, note);
  const displayText = reviewDisplayText(kind, detail, note);
  if (ctx.onInjectedTurnRequested) {
    ctx.onInjectedTurnRequested(displayText, content);
  } else if (ctx.onTurnRequested) {
    ctx.onTurnRequested(content);
  }
}

async function cmdReview(ctx: CommandContext, args: string): Promise<void> {
  const trimmed = args.trim();

  if (trimmed) {
    // When dispatched from the command-overlay picker (startCommandPicker),
    // the value arrives as args (e.g. "uncommitted", a SHA, or a branch name).
    // Detect known review-target values and route them; everything else is
    // free-form user instructions for an uncommitted-changes review.
    if (trimmed === "uncommitted") {
      dispatchReview(ctx, "uncommitted", "", "");
      return;
    }
    if (trimmed === "custom") {
      dispatchReview(ctx, "custom", "", "");
      return;
    }
    if (/^[0-9a-f]{7,40}$/.test(trimmed)) {
      dispatchReview(ctx, "commit", trimmed, "");
      return;
    }
    // From drill-down picker, args may be a branch name. Verify with git
    // before assuming 鈥?single-word instructions like "login" or "config"
    // should not be misidentified as branches.
    if (/^[A-Za-z0-9_./-]+$/.test(trimmed) && !trimmed.includes(" ")) {
      const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
      const check = spawnSync("git", ["rev-parse", "--verify", "--quiet", trimmed], {
        timeout: 3000, stdio: "ignore",
      });
      if (check.status === 0) {
        dispatchReview(ctx, "base", trimmed, "");
        return;
      }
    }
    dispatchReview(ctx, "custom", "", trimmed);
    return;
  }

  if (!ctx.promptCommandPicker) {
    ctx.showMessage("Usage: /review [instructions]");
    return;
  }

  const picked = await ctx.promptCommandPicker(
    reviewOptions({ session: ctx.session, store: ctx.store }),
    { title: "Review", allowNote: true },
  );
  if (!picked) return;

  const note = picked.note ?? "";
  const value = picked.value;

  if (value === "custom") {
    dispatchReview(ctx, "custom", "", note);
    return;
  }

  if (value === "uncommitted") {
    dispatchReview(ctx, "uncommitted", "", note);
    return;
  }

  // For drill-down children (base branch or commit), the picker already
  // resolved to the leaf value (branch name or commit SHA).
  // Determine which kind by checking if it looks like a commit SHA.
  const isSha = /^[0-9a-f]{7,40}$/.test(value);
  if (isSha) {
    dispatchReview(ctx, "commit", value, note);
  } else {
    dispatchReview(ctx, "base", value, note);
  }
}

// ------------------------------------------------------------------
// Registry builder
// ------------------------------------------------------------------

/**
 * Build the default command registry with all built-in commands.
 */
export function buildDefaultRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register({ name: "/help", description: "Show commands and shortcuts", handler: cmdHelp });
  registry.register({ name: "/compact", description: "Manually compact the active context", handler: cmdCompact });
  registry.register({ name: "/new", description: "Start a new session", handler: cmdNew });
  registry.register({ name: "/session", description: "Resume a previous session", handler: cmdResume, options: resumeOptions, pickerTitle: "Sessions", aliases: ["/resume"] });
  registry.register({ name: "/summarize", description: "Manually summarize older context", handler: cmdSummarize });
  registry.register({ name: "/summarize_hint", description: "Configure two-tier summarize hints (on/off, trigger levels)", handler: cmdSummarizeHint });
  registry.register({ name: "/shells", description: "View and stop background shells", handler: cmdShells });
  registry.register({ name: "/model", description: "Switch model", handler: cmdModel, options: modelOptions });
  registry.register({ name: "/key", description: "Manage provider API keys", handler: cmdKey, options: keyOptions, pickerTitle: "Manage API key" });
  registry.register({ name: "/tier", description: "Configure sub-agent model tiers", handler: cmdTier, options: tierOptions });
  registry.register({ name: "/quit", description: "Exit the application", handler: cmdQuit, aliases: ["/exit"] });
  registry.register({ name: "/skills", description: "Manage installed skills", handler: cmdSkills, options: skillsOptions, checkboxMode: true });
  registry.register({ name: "/mcp", description: "Manage MCP servers", handler: cmdMcp, options: mcpOptions, pickerTitle: "MCP Servers" });
  registry.register({ name: "/rename", description: "Rename current session", handler: cmdRename });
  registry.register({ name: "/codex", description: "OpenAI ChatGPT login", handler: cmdCodex, options: codexOptions });
  registry.register({ name: "/copilot", description: "GitHub Copilot login", handler: cmdCopilot, options: copilotOptions });
  registry.register({ name: "/raw", description: "Toggle markdown raw/rendered mode", handler: cmdRaw, aliases: ["/md"] });
  registry.register({ name: "/agents", description: "Toggle agents panel", handler: cmdAgents });
  registry.register({ name: "/todos", description: "Toggle todo panel", handler: cmdTodos });
  registry.register({ name: "/permission", description: "Set permission mode", handler: cmdPermission });
  registry.register({ name: "/rewind", description: "Rewind to a previous turn", handler: cmdRewind, aliases: ["/undo"] });
  registry.register({ name: "/hooks", description: "Manage registered hooks", handler: cmdHooks, options: hooksOptions, pickerTitle: "Hooks" });
  registry.register({ name: "/copy", description: "Copy the agent's most recent text response", handler: cmdCopy });
  registry.register({ name: "/fork", description: "Fork the current session into a new branch", handler: cmdFork });
  registry.register({ name: "/theme", description: "Set theme mode (auto / light / dark)", handler: cmdTheme });
  registry.register({ name: "/diff", description: "Set write/edit diff display (compact / full)", handler: cmdDiff });
  registry.register({ name: "/usage", description: "Show session token usage", handler: cmdUsage, aliases: ["/context"] });
  registry.register({ name: "/stat", description: "Show all-time token statistics", handler: cmdStat });
  registry.register({ name: "/autoupdate", description: "Toggle automatic update checks", handler: cmdAutoUpdate });
  registry.register({ name: "/autocopy", description: "Toggle copy-on-select (auto-copy a text selection)", handler: cmdAutoCopy });
  registry.register({ name: "/review", description: "Review code changes", handler: cmdReview });
  return registry;
}

// ------------------------------------------------------------------
// /copy
// ------------------------------------------------------------------

async function cmdCopy(ctx: CommandContext): Promise<void> {
  const hint = ctx.showHint ?? ctx.showMessage;

  if (ctx.isProcessing?.()) {
    hint("Wait until the agent finishes.");
    return;
  }

  const log = ctx.session.log as ReadonlyArray<{ type: string; content?: unknown; discarded?: boolean }> | undefined;
  if (!Array.isArray(log)) {
    hint("No agent response to copy.");
    return;
  }

  let lastText: string | null = null;
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry?.discarded) continue;
    if (entry?.type === "assistant_text" && typeof entry.content === "string" && entry.content.length > 0) {
      lastText = entry.content;
      break;
    }
  }

  if (lastText === null) {
    hint("No agent response to copy.");
    return;
  }

  if (!ctx.copyToClipboard) {
    hint("Clipboard is not available in this environment.");
    return;
  }

  const ok = await ctx.copyToClipboard(lastText);
  hint(ok ? `Copied agent response (${lastText.length} chars).` : "Copy failed.");
}

// ------------------------------------------------------------------
// /fork
// ------------------------------------------------------------------

async function cmdFork(ctx: CommandContext): Promise<void> {
  const hint = ctx.showHint ?? ctx.showMessage;
  const session = ctx.session;
  const store = ctx.store;

  if (!store) {
    ctx.showMessage("Session persistence not available.");
    return;
  }

  if (session.currentTurnRunning) {
    hint("Cannot fork while a turn is running.");
    return;
  }

  const childSnapshots = (typeof session.getChildSessionSnapshots === "function"
    ? session.getChildSessionSnapshots()
    : []) as Array<{ lifecycle: string }>;
  const liveChildren = childSnapshots.filter(
    (s) => s.lifecycle === "running" || s.lifecycle === "blocked",
  );
  if (liveChildren.length > 0) {
    hint("Cannot fork while sub-agents are running.");
    return;
  }

  const sourceDir = store.sessionDir;
  if (!sourceDir) {
    ctx.showMessage("No active session to fork.");
    return;
  }

  // Save current state so we copy the latest log/meta to disk before cloning.
  ctx.autoSave();

  // Empty sessions have no log.json yet (saveLog skips when turnCount === 0).
  if (!existsSync(join(sourceDir, "log.json"))) {
    hint("Cannot fork an empty session.");
    return;
  }

  const origSessionId = basename(sourceDir);
  const newSessionId = randomSessionId();
  const newDir = join(store.projectDir, newSessionId);

  try {
    cpSync(sourceDir, newDir, { recursive: true });
  } catch (e) {
    try { rmSync(newDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    ctx.showMessage(`Fork failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  // Patch new meta.json + log.json: fresh ID, fresh timestamps, branch title.
  try {
    const nowIso = new Date().toISOString();
    const metaPath = join(newDir, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    const origTitleSrc = (typeof meta.title === "string" && meta.title.length > 0)
      ? meta.title
      : (typeof meta.summary === "string" ? meta.summary : "");
    const branchTitle = origTitleSrc.startsWith("(branch) ")
      ? origTitleSrc
      : `(branch) ${origTitleSrc}`.trim();
    meta.session_id = newSessionId;
    meta.created_at = nowIso;
    meta.last_active_at = nowIso;
    meta.title = branchTitle;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    const logPath = join(newDir, "log.json");
    const logData = JSON.parse(readFileSync(logPath, "utf-8"));
    logData.session_id = newSessionId;
    logData.created_at = nowIso;
    logData.updated_at = nowIso;
    logData.title = branchTitle;
    writeFileSync(logPath, JSON.stringify(logData, null, 2));
  } catch (e) {
    try { rmSync(newDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    ctx.showMessage(`Fork failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  ctx.resetUiState();

  const result = applySessionRestore(session, store, newDir);
  for (const w of result.warnings) ctx.showMessage(w);
  if (!result.ok && result.error) {
    ctx.showMessage(result.error);
    return;
  }

  // Ephemeral pointer back to the parent 鈥?visible in the conversation,
  // not persisted to log.json (saveLog filters meta.ephemeral entries).
  if (typeof session.appendStatusMessage === "function") {
    session.appendStatusMessage(
      `To continue the original session, enter /session ${origSessionId}`,
      "fork_origin",
      true,
    );
  }
}

// ------------------------------------------------------------------
// /mcp command
// ------------------------------------------------------------------

/**
 * Read the full MCP server list from settings (including disabled).
 * This is the picker's data source 鈥?separate from MCPClientManager
 * which only knows about active (non-disabled) servers.
 */
function getAllMcpServerNames(homeDir?: string): Map<string, { disabled: boolean }> {
  const settings = loadGlobalSettings(homeDir);
  const result = new Map<string, { disabled: boolean }>();
  if (settings.mcp_servers) {
    for (const [name, cfg] of Object.entries(settings.mcp_servers)) {
      if (!cfg || typeof cfg !== "object") continue;
      result.set(name, { disabled: cfg.disabled === true });
    }
  }
  return result;
}

function mcpOptions(ctx: CommandOptionsContext): CommandOption[] {
  const session = ctx.session;
  const mcpManager = session?.mcpManager;
  const allServers = getAllMcpServerNames();
  if (allServers.size === 0 && !mcpManager) return [];

  // Runtime statuses from MCPClientManager (active servers only)
  const statusMap = new Map<string, { state: string; toolCount: number; error?: string }>();
  if (mcpManager && typeof mcpManager.getServerStatuses === "function") {
    for (const s of mcpManager.getServerStatuses()) {
      statusMap.set(s.name, s);
    }
  }

  // Tools grouped by server
  const toolsByServer = new Map<string, string[]>();
  if (mcpManager) {
    for (const tool of mcpManager.getAllTools()) {
      const parts = tool.name.split("__");
      const server = parts.length >= 3 ? parts[1] : "unknown";
      if (!toolsByServer.has(server)) toolsByServer.set(server, []);
      toolsByServer.get(server)!.push(parts.length >= 3 ? parts.slice(2).join("__") : tool.name);
    }
  }

  const opts: CommandOption[] = [
    { label: "Reload config", value: "__reload__" },
  ];

  for (const [name, { disabled }] of allServers) {
    const status = statusMap.get(name);
    const children: CommandOption[] = [];

    if (disabled) {
      children.push({ label: "Enable", value: `${name}:enable` });
      opts.push({
        label: name,
        labelParts: [
          { text: name },
          { text: " 路 " },
          { text: "鉁?, color: "muted" },
          { text: " Disabled" },
        ],
        value: name,
        children,
      });
    } else {
      const connected = status?.state === "connected";
      const stateLabel = status?.state
        ? status.state.charAt(0).toUpperCase() + status.state.slice(1)
        : "Not connected";

      const parts: Array<{ text: string; color?: SemanticColor }> = [
        { text: name },
        { text: " 路 " },
        { text: connected ? "鉁? : "鉁?, color: connected ? "success" : "error" },
        { text: ` ${stateLabel}` },
      ];
      if (connected && status!.toolCount > 0) {
        parts.push({ text: ` 路 ${status!.toolCount} tools` });
      }
      if (!connected && status?.error) {
        parts.push({ text: ` 路 ${status.error}` });
      }

      children.push({ label: "Reconnect", value: `${name}:reconnect` });
      children.push({ label: "Disable", value: `${name}:disable` });
      const serverTools = toolsByServer.get(name) ?? [];
      if (serverTools.length > 0) {
        children.push({
          label: `View tools (${serverTools.length})`,
          value: `${name}:tools`,
          children: serverTools.map((t) => ({ label: t, value: "", disabled: true })),
        });
      }

      opts.push({
        label: name,
        labelParts: parts,
        value: name,
        children,
      });
    }
  }

  return opts;
}

function setMcpServerDisabled(serverName: string, disabled: boolean, homeDir?: string): boolean {
  const settings = loadGlobalSettings(homeDir);
  const servers = settings.mcp_servers;
  if (!servers || !servers[serverName]) return false;

  if (disabled) {
    servers[serverName].disabled = true;
  } else {
    delete servers[serverName].disabled;
  }
  persistSettingsPatch({ mcp_servers: servers }, homeDir);
  return true;
}

async function cmdMcp(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  const hint = ctx.showHint ?? ctx.showMessage;

  // Prefer the turn-lock-wrapped command variant so an MCP reload cannot
  // overlap a turn; fall back to the bare method for older session shapes.
  const reloadMcpLocked = (reason: string): Promise<string> =>
    typeof session.reloadMcpFromCommand === "function"
      ? session.reloadMcpFromCommand(reason)
      : session.reloadMcp({ reason });

  // Ensure MCP is ready (no-op if already connected). Use the turn-lock-wrapped
  // variant so a status warm-up that connects servers cannot overlap a turn.
  try {
    if (typeof session.ensureMcpReadyFromCommand === "function") {
      await session.ensureMcpReadyFromCommand();
    } else if (typeof session.ensureMcpReady === "function") {
      await session.ensureMcpReady();
    }
  } catch { /* proceed 鈥?statuses will show failures */ }

  const allServers = getAllMcpServerNames(ctx.swarmflowHomeDir);
  if (allServers.size === 0) {
    ctx.showMessage(
      "No MCP servers configured.\n" +
      "Add servers to settings.json under \"mcp_servers\".",
    );
    return;
  }

  let action = args.trim();

  if (!action && ctx.promptCommandPicker) {
    const picked = await ctx.promptCommandPicker(
      mcpOptions({ session, store: ctx.store }),
      { title: "MCP Servers" },
    );
    if (!picked) return;
    action = picked.value;
  }

  if (action === "__reload__") {
    try {
      hint("Reloading MCP servers鈥?);
      const report = await reloadMcpLocked("the user reloaded MCP configuration");
      hint(report);
    } catch (err) {
      hint(`Reload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  const colonIdx = action.indexOf(":");
  if (colonIdx > 0) {
    const serverName = action.slice(0, colonIdx);
    const op = action.slice(colonIdx + 1);
    const mcpManager = session.mcpManager;

    if (op === "reconnect") {
      hint(`Connecting MCP server '${serverName}'鈥);
      if (typeof session.reconnectMcpServerFromCommand === "function") {
        const ok = await session.reconnectMcpServerFromCommand(serverName);
        hint(ok ? `${serverName}: reconnected` : `${serverName}: reconnect failed`);
      } else if (typeof session.reconnectMcpServer === "function") {
        const ok = await session.reconnectMcpServer(serverName);
        hint(ok ? `${serverName}: reconnected` : `${serverName}: reconnect failed`);
      } else if (mcpManager && typeof mcpManager.reconnectServer === "function") {
        const ok = await mcpManager.reconnectServer(serverName);
        hint(ok ? `${serverName}: reconnected` : `${serverName}: reconnect failed`);
        if (session.onMcpStatus && typeof mcpManager.getServerStatuses === "function") {
          session.onMcpStatus(mcpManager.getServerStatuses());
        }
      }
      return;
    }

    if (op === "disable" || op === "enable") {
      const disabled = op === "disable";
      if (setMcpServerDisabled(serverName, disabled, ctx.swarmflowHomeDir)) {
        try {
          if (!disabled) hint(`Connecting MCP server '${serverName}'鈥);
          const report = await reloadMcpLocked(
            `the user ${disabled ? "disabled" : "enabled"} MCP server '${serverName}'`,
          );
          hint(`${serverName}: ${disabled ? "disabled" : "enabled"} (${report})`);
        } catch (err) {
          hint(`${serverName}: ${disabled ? "disabled" : "enabled"} (reload failed: ${err instanceof Error ? err.message : String(err)})`);
        }
      } else {
        hint(`Server "${serverName}" not found in settings.`);
      }
      return;
    }
  }

  // Fallback for non-interactive environments
  const enabledCount = [...allServers.values()].filter((s) => !s.disabled).length;
  hint(`MCP: ${allServers.size} server(s), ${enabledCount} enabled. Use picker for details.`);
}

// ------------------------------------------------------------------
// /skills command
// ------------------------------------------------------------------

function skillsOptions(ctx: CommandOptionsContext): CommandOption[] {
  const session = ctx.session;
  if (!session?.getAllSkillNames) return [];
  const allSkills = session.getAllSkillNames();
  if (allSkills.length === 0) return [];

  return allSkills.map((s: { name: string; description: string; enabled: boolean }) => ({
    label: `${s.name}  ${s.description.length > 50 ? s.description.slice(0, 47) + "..." : s.description}`,
    value: s.name,
    checked: s.enabled,
  }));
}

async function cmdSkills(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  if (!session?.getAllSkillNames) {
    ctx.showMessage("Skills system not available.");
    return;
  }

  const trimmed = args.trim();
  if (!trimmed) {
    // No args 鈥?show list
    const allSkills = session.getAllSkillNames();
    if (allSkills.length === 0) {
      ctx.showMessage("No skills installed.");
      return;
    }
    const lines = ["Installed skills:"];
    for (const s of allSkills) {
      lines.push(`  ${s.enabled ? "[x]" : "[ ]"} ${s.name} 鈥?${s.description}`);
    }
    ctx.showMessage(lines.join("\n"));
    return;
  }

  // Checkbox picker submits comma-separated enabled skill names
  // Parse: all items were submitted, enabled ones are in the args
  const enabledNames = new Set(trimmed.split(",").map((s: string) => s.trim()).filter(Boolean));
  const allSkills = session.getAllSkillNames();
  const oldSkills = session.skills;
  const enabledBefore = new Set(
    allSkills
      .filter((s: { enabled: boolean }) => s.enabled)
      .map((s: { name: string }) => s.name),
  );

  for (const s of allSkills) {
    session.setSkillEnabled(s.name, enabledNames.has(s.name));
  }
  session.reloadSkills();
  if (typeof session.notifySkillAvailabilityChanged === "function") {
    const enabled = allSkills
      .map((s: { name: string }) => s.name)
      .filter((name: string) => enabledNames.has(name) && !enabledBefore.has(name));
    const disabled = allSkills
      .map((s: { name: string }) => s.name)
      .filter((name: string) => !enabledNames.has(name) && enabledBefore.has(name));
    session.notifySkillAvailabilityChanged({ enabled, disabled });
  }

  // Re-register slash commands
  reRegisterSkillCommands(ctx.commandRegistry, oldSkills, session.skills);

  const enabledCount = enabledNames.size;
  const totalCount = allSkills.length;
  ctx.showMessage(`Skills updated: ${enabledCount}/${totalCount} enabled.`);
  // Persist disabled skills list to settings.json
  const disabledSkills = allSkills
    .filter((s: { name: string }) => !enabledNames.has(s.name))
    .map((s: { name: string }) => s.name);
  persistSettingsPatch(
    { disabled_skills: disabledSkills.length > 0 ? disabledSkills : undefined },
    ctx.swarmflowHomeDir,
  );
}

// ------------------------------------------------------------------
// Skill command registration
// ------------------------------------------------------------------

/**
 * Register slash commands for user-invocable skills.
 *
 * Each skill with `userInvocable === true` gets a `/skill-name` command.
 * When invoked, the skill content is injected and a turn is triggered.
 */
export function registerSkillCommands(
  registry: CommandRegistry,
  skills: ReadonlyMap<string, SkillMeta>,
): void {
  const sortedSkills = [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const skill of sortedSkills) {
    if (!skill.userInvocable) continue;

    // Skip skills whose name conflicts with built-in commands
    const cmdName = "/" + skill.name;
    if (registry.lookup(cmdName)) {
      console.warn(`Skill "${skill.name}" skipped: conflicts with built-in command ${cmdName}`);
      continue;
    }

    const captured = skill; // capture for closure
    registry.register({
      name: cmdName,
      description: captured.description,
      handler: async (ctx: CommandContext, args: string) => {
        const content = resolveSkillContent(captured, args);
        const tagged = `[SKILL: ${captured.name}]\n\n${content}`;
        const displayText = args.trim()
          ? `/${captured.name} ${args.trim()}`
          : `/${captured.name}`;
        if (ctx.onInjectedTurnRequested) {
          ctx.onInjectedTurnRequested(displayText, tagged);
        } else if (ctx.onTurnRequested) {
          ctx.onTurnRequested(tagged);
        }
      },
    });
  }
}

/**
 * Unregister old skill commands, then register new ones.
 * Used after reloadSkills() to keep slash commands in sync.
 */
export function reRegisterSkillCommands(
  registry: CommandRegistry,
  oldSkills: ReadonlyMap<string, SkillMeta>,
  newSkills: ReadonlyMap<string, SkillMeta>,
): void {
  for (const skill of oldSkills.values()) {
    registry.unregister("/" + skill.name);
  }
  registerSkillCommands(registry, newSkills);
}

// ------------------------------------------------------------------
// /raw command 鈥?toggle markdown raw/rendered mode
// ------------------------------------------------------------------

async function cmdRaw(ctx: CommandContext): Promise<void> {
  // The TUI intercepts this status message to toggle markdown mode.
  ctx.showMessage("__toggle_markdown_raw__");
}

// ------------------------------------------------------------------
// /agents command 鈥?toggle agents panel
// ------------------------------------------------------------------

async function cmdAgents(ctx: CommandContext): Promise<void> {
  ctx.showMessage("__open_agent_list__");
}

// ------------------------------------------------------------------
// /todos command 鈥?toggle todo panel
// ------------------------------------------------------------------

async function cmdTodos(ctx: CommandContext): Promise<void> {
  ctx.showMessage("__toggle_todo_panel__");
}

// ------------------------------------------------------------------
// /sidebar command 鈥?toggle sidebar mode (open/close/auto)
// ------------------------------------------------------------------

async function cmdSidebar(ctx: CommandContext, args: string): Promise<void> {
  const mode = args.trim().toLowerCase();
  if (mode === "open" || mode === "close" || mode === "auto") {
    ctx.showMessage(`__sidebar_mode__:${mode}`);
  } else {
    // Toggle: cycle auto 鈫?open 鈫?close 鈫?auto
    ctx.showMessage("__sidebar_toggle__");
  }
}

// ------------------------------------------------------------------
// /permission 鈥?set permission mode
// ------------------------------------------------------------------

const PERMISSION_MODES = ["read_only", "reversible", "yolo"] as const;
const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  read_only: "Only read tools auto-allowed. All writes require approval.",
  reversible: "Read + reversible writes (edit_file, write_file) auto-allowed. Bash and other mutations require approval.",
  yolo: "Everything auto-allowed except catastrophic commands.",
};

function permissionOptions(ctx: CommandOptionsContext): CommandOption[] {
  const session = ctx.session;
  const current = typeof session.permissionMode === "string" ? session.permissionMode : "reversible";
  return PERMISSION_MODES.map((mode) => ({
    label: `${mode}${mode === current ? " (current)" : ""} 鈥?${PERMISSION_DESCRIPTIONS[mode]}`,
    value: mode,
  }));
}

async function cmdPermission(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  let mode = args.trim().toLowerCase();

  if (!mode) {
    if (ctx.promptCommandPicker) {
      const picked = await ctx.promptCommandPicker(permissionOptions({ session, store: ctx.store }));
      if (!picked) return;
      mode = picked.value;
    } else {
      const current = session.permissionMode ?? "reversible";
      ctx.showMessage(
        `Current permission mode: ${current}\n\n` +
        `Usage: /permission <mode>\n` +
        PERMISSION_MODES.map((m) => `  ${m} 鈥?${PERMISSION_DESCRIPTIONS[m]}`).join("\n"),
      );
      return;
    }
  }

  if (!PERMISSION_MODES.includes(mode as any)) {
    ctx.showMessage(`Unknown mode "${mode}". Valid: ${PERMISSION_MODES.join(", ")}`);
    return;
  }

  session.permissionMode = mode;
  persistPermissionMode(ctx);
  ctx.showMessage(`Permission mode set to: ${mode}`);
}

function persistPermissionMode(ctx: CommandContext): void {
  try {
    const session = ctx.session;
    if (typeof session.permissionMode !== "string") return;
    persistSettingsPatch({ permission_mode: session.permissionMode }, ctx.swarmflowHomeDir);
  } catch {
    // Ignore persistence failures.
  }
}

// ------------------------------------------------------------------
// /rewind 鈥?rewind to a previous turn
// ------------------------------------------------------------------

function formatRewindDetail(target: {
  fileCount: number;
  additions: number;
  deletions: number;
  filesReverted: boolean;
}): string {
  if (target.filesReverted) return "Changes reverted";
  if (target.fileCount === 0) return "No code changes";
  const parts: string[] = [];
  if (target.additions > 0) parts.push(`+${target.additions}`);
  if (target.deletions > 0) parts.push(`-${target.deletions}`);
  const n = target.fileCount;
  parts.push(`${n} file${n > 1 ? "s" : ""}`);
  return parts.join(" ");
}

export function rewindOptions(ctx: CommandOptionsContext): CommandOption[] {
  const session = ctx.session;
  const targets: Array<{
    turnIndex: number;
    preview: string;
    fileCount: number;
    additions: number;
    deletions: number;
    filesReverted: boolean;
  }> = session.getRewindTargets?.() ?? [];
  const header: CommandOption = { label: "Message", value: "", detail: "Changes", disabled: true };
  const current: CommandOption = { label: "(Current)", value: "0:cancel", detail: "" };
  if (targets.length === 0) {
    return [
      header,
      current,
      { label: "No previous turns", value: "", detail: "", disabled: true },
    ];
  }

  const options: CommandOption[] = targets.map((t) => {
    const hasLiveMutations = t.fileCount > 0 && !t.filesReverted;
    const children: CommandOption[] = [];

    if (hasLiveMutations) {
      children.push(
        { label: "Restore code and conversation", value: `${t.turnIndex}:both` },
        { label: "Restore conversation", value: `${t.turnIndex}:conversation` },
        { label: "Restore code", value: `${t.turnIndex}:files` },
        { label: "Never mind", value: `${t.turnIndex}:cancel` },
      );
    } else {
      children.push(
        { label: "Restore conversation", value: `${t.turnIndex}:conversation` },
        { label: "Never mind", value: `${t.turnIndex}:cancel` },
      );
    }

    return {
      label: t.preview,
      detail: formatRewindDetail(t),
      value: String(t.turnIndex),
      children,
    };
  });

  return [header, current, ...options];
}

async function cmdRewind(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;

  if (!session.rewindConversation) {
    ctx.showMessage("Rewind is not supported in this session.");
    return;
  }

  // Resolve turnIndex and mode from either direct args or picker
  let turnIndex: number;
  let mode: "both" | "conversation" | "files" | "cancel";

  const raw = args.trim();
  if (raw) {
    // Direct args: "/rewind 3" (conversation-only) or "/rewind 3:files" (from picker)
    const colonIdx = raw.indexOf(":");
    if (colonIdx >= 0) {
      turnIndex = parseInt(raw.slice(0, colonIdx), 10);
      mode = raw.slice(colonIdx + 1) as "both" | "conversation" | "files" | "cancel";
    } else {
      turnIndex = parseInt(raw, 10);
      mode = "conversation";
    }
    if (isNaN(turnIndex)) {
      ctx.showMessage(`Invalid turn number: "${raw}"`);
      return;
    }
  } else if (ctx.promptCommandPicker) {
    const picked = await ctx.promptCommandPicker(rewindOptions({ session, store: ctx.store }));
    if (!picked) return;
    const colonIdx = picked.value.indexOf(":");
    if (colonIdx < 0) return;
    turnIndex = parseInt(picked.value.slice(0, colonIdx), 10);
    mode = picked.value.slice(colonIdx + 1) as "both" | "conversation" | "files" | "cancel";
    if (isNaN(turnIndex)) return;
  } else {
    ctx.showMessage("Usage: /rewind <turn_number>");
    return;
  }

  if (mode === "cancel") return;

  if (mode === "conversation") {
    const result = session.rewindConversation(turnIndex);
    if (result.error) {
      ctx.showMessage(`Rewind failed: ${result.error}`);
      return;
    }
    ctx.showMessage(`Rewound conversation to turn ${turnIndex}. Removed ${result.removed} log entries.`);
    ctx.autoSave();
    return;
  }

  // For "files" and "both" modes, we need to plan first
  if (!session.planRewind || !session.rewindFiles || !session.rewindBoth) {
    ctx.showMessage("File rewind is not supported in this session.");
    return;
  }

  const plan = await session.planRewind(turnIndex);
  const hasFiles = plan.applicable.length + plan.warnings.length > 0;
  const hasConflicts = plan.conflicts.length > 0;
  const hasBash = plan.bashEntries.length > 0;
  const hasBashConflicts = plan.bashEntries.some((e: { status: string }) => e.status === "conflict");

  if (!hasFiles && !hasConflicts && !hasBash) {
    if (mode === "both") {
      const result = session.rewindConversation(turnIndex);
      if (result.error) {
        ctx.showMessage(`Rewind failed: ${result.error}`);
        return;
      }
      ctx.showMessage(`Rewound conversation to turn ${turnIndex}. No file changes to revert.`);
    } else {
      ctx.showMessage("No file changes to revert.");
    }
    ctx.autoSave();
    return;
  }

  // Show file conflicts (plan-time, these won't change at execution time)
  if (hasConflicts) {
    const conflictList = plan.conflicts.map((c: { path: string; reason: string }) => `  ${c.path} (${c.reason})`).join("\n");
    ctx.showMessage(`Warning: ${plan.conflicts.length} file(s) cannot be auto-reverted:\n${conflictList}`);
  }
  // Note: bash conflicts are NOT shown here 鈥?they are re-evaluated at execution
  // time, so plan-time status may not reflect the final result.

  const formatBashResult = (result: { bashReverted?: string[]; bashSkipped?: string[] }): string => {
    const parts: string[] = [];
    if (result.bashReverted && result.bashReverted.length > 0) {
      parts.push(`Reverted ${result.bashReverted.length} shell operation(s):`);
      for (const desc of result.bashReverted) parts.push(`  鉁?${desc}`);
    }
    if (result.bashSkipped && result.bashSkipped.length > 0) {
      parts.push(`Skipped ${result.bashSkipped.length} shell operation(s):`);
      for (const desc of result.bashSkipped) parts.push(`  鉁?${desc}`);
    }
    return parts.join("\n");
  };

  if (mode === "files") {
    const result = await session.rewindFiles(plan);
    if (result.error) {
      ctx.showMessage(`File rewind failed: ${result.error}`);
      return;
    }
    const filePart = result.revertedPaths.length > 0
      ? `Reverted ${result.revertedPaths.length} file edit(s).`
      : "No file edits were reverted.";
    const bashPart = formatBashResult(result);
    ctx.showMessage([filePart, bashPart].filter(Boolean).join("\n"));
  } else {
    // mode === "both"
    const result = await session.rewindBoth(turnIndex, plan);
    if (result.error) {
      ctx.showMessage(`Rewind failed: ${result.error}`);
      return;
    }
    const filePart = result.revertedPaths.length > 0
      ? `Reverted ${result.revertedPaths.length} file edit(s).`
      : "";
    const convPart = `Removed ${result.removed} log entries.`;
    const bashPart = formatBashResult(result);
    const hasSkipped =
      plan.conflicts.length > 0 ||
      result.conflictPaths.length > 0 ||
      (result.bashSkipped?.length ?? 0) > 0;
    const warnPart = hasSkipped
      ? "Some disk changes could not be reverted. Inspect the working tree before continuing."
      : "";
    ctx.showMessage([`Rewound to turn ${turnIndex}. ${convPart} ${filePart}`.trim(), bashPart, warnPart].filter(Boolean).join("\n"));
  }

  ctx.autoSave();
}

// ------------------------------------------------------------------
// /hooks command
// ------------------------------------------------------------------

function loadAllHooksFromDisk(): Array<{ name: string; event: string; command: string; args?: string[]; disabled?: boolean; _sourcePath?: string; _scope?: string; matcher?: { toolNames?: string[]; agentIds?: string[] }; failClosed?: boolean }> {
  try {
    const { resolveAssetPaths } = require("./config/config.js") as typeof import("./config/config.js");
    const { loadHooksMulti } = require("./hooks/index.js") as typeof import("./hooks/index.js");
    const paths = resolveAssetPaths();
    // loadHooksMulti de-dupes by name (project overrides global)
    // We want ALL including disabled, so we load raw from disk
    const allHooks: any[] = [];
    for (const { dir, scope } of paths.hookRoots) {
      const { loadHooksFromDir } = require("./hooks/index.js") as typeof import("./hooks/index.js");
      for (const h of loadHooksFromDir(dir, scope as "project" | "global")) {
        allHooks.push(h);
      }
    }
    // De-dupe by name (later scopes override earlier)
    const byName = new Map<string, any>();
    for (const h of allHooks) byName.set(h.name, h);
    return [...byName.values()];
  } catch {
    return [];
  }
}

function setHookDisabled(sourcePath: string, disabled: boolean): boolean {
  if (!existsSync(sourcePath)) return false;
  try {
    const raw = JSON.parse(readFileSync(sourcePath, "utf-8"));
    if (disabled) {
      raw["disabled"] = true;
    } else {
      delete raw["disabled"];
    }
    writeFileSync(sourcePath, JSON.stringify(raw, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

function reloadHooksIntoRuntime(session: any): number {
  try {
    const { resolveAssetPaths } = require("./config/config.js") as typeof import("./config/config.js");
    const { loadHooksMulti } = require("./hooks/index.js") as typeof import("./hooks/index.js");
    const paths = resolveAssetPaths();
    const hooks = loadHooksMulti(paths.hookRoots);
    session.hookRuntime.setHooks(hooks);
    return hooks.length;
  } catch {
    return -1;
  }
}

function hooksOptions(_ctx: CommandOptionsContext): CommandOption[] {
  const allHooks = loadAllHooksFromDisk();
  const opts: CommandOption[] = [
    { label: "Reload hooks", value: "__reload__" },
  ];

  if (allHooks.length === 0) {
    opts.push({ label: "No hooks found", value: "", disabled: true });
    return opts;
  }

  for (const hook of allHooks) {
    const scope = hook._scope ?? "unknown";
    const matcherParts: string[] = [];
    if (hook.matcher?.toolNames?.length) matcherParts.push(hook.matcher.toolNames.join(","));
    if (hook.matcher?.agentIds?.length) matcherParts.push(hook.matcher.agentIds.join(","));
    const matcherSuffix = matcherParts.length ? ` [${matcherParts.join("; ")}]` : "";
    const disabledTag = hook.disabled ? " (disabled)" : "";

    const children: CommandOption[] = [];
    if (hook.disabled) {
      children.push({ label: "Enable", value: `${hook.name}:enable` });
    } else {
      children.push({ label: "Disable", value: `${hook.name}:disable` });
    }
    if (hook._sourcePath) {
      children.push({ label: "Show config path", value: `${hook.name}:path` });
    }

    opts.push({
      label: `${hook.name}${disabledTag}`,
      detail: `${scope} 路 ${hook.event}${matcherSuffix}`,
      value: hook.name,
      children,
    });
  }

  return opts;
}

async function cmdHooks(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  const hookRuntime = session.hookRuntime;
  const hint = ctx.showHint ?? ctx.showMessage;

  if (!hookRuntime) {
    ctx.showMessage("Hook system not available.");
    return;
  }

  let action = args.trim();

  if (!action && ctx.promptCommandPicker) {
    const picked = await ctx.promptCommandPicker(
      hooksOptions({ session, store: ctx.store }),
      { title: "Hooks" },
    );
    if (!picked) return;
    action = picked.value;
  }

  if (action === "__reload__") {
    const count = reloadHooksIntoRuntime(session);
    hint(count >= 0 ? `Hooks reloaded: ${count} active` : "Failed to reload hooks.");
    return;
  }

  const colonIdx = action.indexOf(":");
  if (colonIdx > 0) {
    const hookName = action.slice(0, colonIdx);
    const op = action.slice(colonIdx + 1);

    const allHooks = loadAllHooksFromDisk();
    const hook = allHooks.find((h) => h.name === hookName);
    if (!hook) {
      hint(`Hook "${hookName}" not found.`);
      return;
    }

    if (op === "enable" || op === "disable") {
      const disabled = op === "disable";
      if (hook._sourcePath && setHookDisabled(hook._sourcePath, disabled)) {
        reloadHooksIntoRuntime(session);
        hint(`${hookName}: ${disabled ? "disabled" : "enabled"}`);
      } else {
        hint(`Failed to ${op} "${hookName}" 鈥?check hook.json`);
      }
      return;
    }

    if (op === "path") {
      hint(hook._sourcePath ?? "Source path unknown.");
      return;
    }
  }

  // Fallback for non-interactive environments
  const allHooks = loadAllHooksFromDisk();
  const activeCount = allHooks.filter((h) => !h.disabled).length;
  hint(allHooks.length === 0
    ? "No hooks registered."
    : `${allHooks.length} hook(s), ${activeCount} active. Use picker for details.`);
}
