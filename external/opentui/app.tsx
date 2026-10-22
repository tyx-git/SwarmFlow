/** @jsxImportSource @opentui/react */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clipboard } from "../../src/platform/index.js";
import type {
  CommandRegistry,
  CommandContext,
  CommandOption,
  Session as TuiSession,
} from "../../src/ui/contracts.js";
import type { SessionStore } from "../../src/config/session-store.js";
import type { ChildSessionSnapshot } from "../../src/session/tree-types.js";
import { resolveInheritedThinkingLevel } from "../../src/session/role-model-resolver.js";
import { saveLog } from "../../src/config/log-serialization.js";
import { persistCurrentModelSelection } from "../../src/config/settings/io.js";
import { projectQueuedInputs } from "../../src/context/projection/tui.js";
import { enqueueDeferredCommand, takeReadyDeferredCommand, type DeferredCommand } from "../../src/ui/deferred-command.js";
import { ProgressReporter, type ProgressEvent } from "../../src/logging/progress.js";
import { getLocalizedCommandDescription } from "../../src/commands/registry.js";
import { scanCandidates } from "../../src/attachments/scanner.js";
import { classifyPastedText, TurnPasteCounter } from "../../src/ui/input/paste.js";
import { readClipboardImage } from "../../src/attachments/clipboard-image.js";
import { processImage, type ProcessedImage } from "../../src/attachments/image-compress.js";
import type { InlineImageInput } from "../../src/ui/contracts.js";
import type {
  PendingAskUi,
  AgentQuestionAnswer,
  AgentQuestionDecision,
  AgentQuestionItem,
} from "../../src/ask.js";
import type {
  PromptChoice,
  PromptSecretRequest,
  PromptSelectRequest,
} from "../../src/providers/credential-flow.js";
import type { CommandPickerPresentation } from "../../src/ui/picker.js";
import {
  acceptCommandPickerSelection,
  createCommandPicker,
  exitCommandPickerLevel,
  exitCommandPickerCustomInput,
  getCommandPickerLevel,
  isCommandPickerActive,
  isCommandPickerCustomInputOption,
  moveCommandPickerSelection,
  setCommandPickerSelection,
  setCommandPickerNote,
  toggleCommandPickerNoteEditing,
  type CommandPickerAcceptResult,
  type CommandPickerResult,
  type CommandPickerState,
} from "../../src/ui/command-picker.js";
import {
  type InputRenderable,
  type KeyBinding,
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { setShikiTheme } from "./forked/shiki-highlighter.js";
import { setSyntaxHighlightTheme } from "./components/syntax-highlighter.js";
import {
  isOpenTuiDiagEnabled,
  writeOpenTuiDiag,
} from "./forked/core/lib/diagnostic.js";
import { usePresentationEntries } from "./presentation/use-presentation.js";
import { useTurnTimer } from "./presentation/use-turn-timer.js";
import type { TabState } from "./sidebar/sidebar-tabs.js";
import { getCurrentModelDescriptor } from "../../src/models/presentation.js";
import {
  UsagePoller,
  type UsageSnapshot,
} from "../../src/providers/usage.js";
import { readOAuthAccessToken, hasOAuthTokens, saveOAuthTokens, type OAuthTokens } from "../../src/auth/openai/token-store.js";
import { isTokenExpiring } from "../../src/auth/openai/jwt.js";
import { browserLoginHeadless } from "../../src/auth/openai/pkce-flow.js";
import { deviceCodeLoginHeadless } from "../../src/auth/openai/device-code-flow.js";
import type { OAuthProgress } from "../../src/auth/openai/types.js";
import {
  deviceCodeLoginHeadless as copilotDeviceCodeLoginHeadless,
  saveGitHubTokens,
  hasGitHubTokens,
  type GitHubOAuthTokens,
} from "../../src/auth/github-copilot-oauth.js";
import {
  buildFileReferenceLabel,
  createComposerTokenVisuals,
  displayWidthWithNewlines,
  ensureComposerTokenType,
  findFileReferenceQuery,
  getComposerTokenSnapshots,
  getTextDiffRange,
  patchComposerExtmarksForDisplayWidth,
  replaceRangeWithComposerToken,
  serializeComposerText,
  type ComposerTokenVisuals,
} from "./composer-tokens.js";
import { createDisplayTheme, type DisplayTheme, type DisplayThemeTokens, type DeepPartial, type ThemeMode } from "./display/theme/index.js";
import { parseThemeModePref, normalizeThemeMode } from "../../src/config/theme.js";
import { ContextUsageCard, CodexUsageCard } from "./display/panels/usage-cards.js";
import type { SessionStatusData } from "./display/overlays/session-status-panel.js";
import {
  StatusPanel,
  dismissSettledAgentIds,
  isSettledAgentSnapshot,
  syncDismissedAgentIds,
} from "./display/panels/status-panel.js";
import { useTasks } from "./presentation/use-tasks.js";
import {
  type ActivityPhase,
  type AnyOAuthTokens,
  type CommandOverlayState,
  type OAuthOverlayState,
  type OAuthProviderId,
  type PromptSecretState,
  type PromptSelectState,
  type QuestionAnswerState,
  EMPTY_COMMAND_OVERLAY,
} from "./display/types.js";
import { clamp, computePickerMaxVisible, MAX_COMMAND_LIST_VISIBLE } from "./display/layout/metrics.js";
import { OpenTuiScreen } from "./display/layout/open-tui-screen.js";
import { resolveModelNameColor } from "./display/utils/model.js";
import { createUiText, getUiLanguage, normalizeUiLanguage, resolveCommandEchoDisplay, type UiLanguage, type UiText } from "../../src/ui/text.js";
import { getSwarmflowHomeDir } from "../../src/config/home-dir.js";
import { getDeleteToVisualLineStartAction } from "./input/delete-to-visual-line-start.js";
import { appendPromptHistory, getPromptHistoryNavigationDirection, navigatePromptHistory } from "./input/prompt-history.js";

export interface OpenTuiAppProps {
  session: TuiSession;
  commandRegistry: CommandRegistry;
  store: SessionStore | null;
  verbose?: boolean;
  onExit: (farewell?: string) => Promise<void> | void;
  onNewSession?: () => Promise<void>;
  /** Resolved theme mode. Required: there is no canonical default theme. */
  themeMode: ThemeMode;
  /** User's theme preference. "auto" means follow live terminal theme_mode events. */
  themeModePref: "auto" | ThemeMode;
  /** Global write/edit diff display preference. */
  diffDisplay: "compact" | "full";
  /**
   * Terminal's default foreground (OSC 10 query at startup). Used as body
   * text colour when the user is in auto mode so the TUI matches their
   * terminal theme exactly. Null on detection failure → fall back to the
   * token-table colour.
   */
  terminalDefaultFg?: string | null;
}
const CTRL_C_EXIT_WINDOW_MS = 2000;
const DOUBLE_ESC_WINDOW_MS = 500;
const CUSTOM_EMPTY_HINT =
  'Custom answer is empty. Please enter an answer first, or choose "Discuss further" instead.';
const GOODBYE_MESSAGES = [
  "Bye!",
  "Goodbye!",
  "See you later!",
  "Until next time!",
  "Take care!",
  "Happy coding!",
  "Catch you later!",
  "Peace out!",
  "So long!",
  "Off I go!",
  "Later, gator!",
] as const;
const DISABLED_TEXTAREA_ACTION = "__disabled__" as unknown as KeyBinding["action"];
const COMPOSER_KEY_BINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "linefeed", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "return", meta: true, action: "newline" },
  { name: "n", ctrl: true, action: "newline" },
  { name: "up", action: DISABLED_TEXTAREA_ACTION },
  { name: "down", action: DISABLED_TEXTAREA_ACTION },
  { name: "backspace", meta: true, action: DISABLED_TEXTAREA_ACTION },
  { name: "backspace", super: true, action: DISABLED_TEXTAREA_ACTION },
  { name: "x", ctrl: true, action: DISABLED_TEXTAREA_ACTION },
  { name: "k", ctrl: true, action: DISABLED_TEXTAREA_ACTION },
  { name: "u", ctrl: true, action: DISABLED_TEXTAREA_ACTION },
];

function isDeleteToVisualLineStartShortcut(
  event: {
    name: string;
    ctrl?: boolean;
    meta?: boolean;
    super?: boolean;
  },
): boolean {
  return Boolean(
    (event.name === "backspace" && (event.meta || event.super))
    || (event.name === "u" && event.ctrl && !event.meta && !event.super)
  );
}

function isCommandOverlayEligible(value: string): boolean {
  if (!value.startsWith("/")) return false;
  if (value.includes("\n")) return false;
  return !value.slice(1).includes(" ");
}

function isFileOverlayEligible(value: string, cursorOffset: number): boolean {
  return findFileReferenceQuery(value, cursorOffset) !== null;
}

async function copyToClipboard(text: string, rendererCopy: (text: string) => boolean): Promise<boolean> {
  // Try the platform-native tool first (pbcopy / wl-copy / xclip /
  // clip.exe). The platform layer also internally falls back to OSC
  // 52 written directly to stderr. As a last resort we call the
  // renderer's own OSC 52 path, which goes through the active
  // OpenTUI terminal handle and may succeed in some terminals where
  // the raw stderr write doesn't.
  const ok = await clipboard.writeText(text);
  if (ok) return true;
  return rendererCopy(text);
}

function sameChildSessionList(
  a: ChildSessionSnapshot[],
  b: ChildSessionSnapshot[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (
      left?.id !== right?.id ||
      left?.lifecycle !== right?.lifecycle ||
      left?.phase !== right?.phase ||
      left?.outcome !== right?.outcome ||
      left?.running !== right?.running ||
      left?.logRevision !== right?.logRevision ||
      left?.lifetimeToolCallCount !== right?.lifetimeToolCallCount ||
      left?.lastTotalTokens !== right?.lastTotalTokens ||
      left?.lastToolCallSummary !== right?.lastToolCallSummary ||
      left?.thinkingLevel !== right?.thinkingLevel ||
      left?.pendingInboxCount !== right?.pendingInboxCount
    ) {
      return false;
    }
  }
  return true;
}

/** UI snapshot of a tracked background shell (mirrors Session.getBackgroundShellSnapshots). */
interface ShellSnapshotUi {
  id: string;
  command: string;
  cwd: string;
  status: "running" | "exited" | "failed" | "killed";
  exitCode: number | null;
  elapsedSeconds: number;
  recentOutput: string[];
  logPath: string;
}

/** Snapshot + log tail for the shell detail tab. */
interface ShellDetailUi extends ShellSnapshotUi {
  logTail: string;
  logTruncated: boolean;
}

/**
 * Compare ignoring elapsedSeconds so the 250ms session poll doesn't re-render
 * the badge/sidebar four times a second while nothing visible changed.
 */
function sameShellSnapshotList(a: ShellSnapshotUi[], b: ShellSnapshotUi[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (
      left?.id !== right?.id ||
      left?.status !== right?.status ||
      (left?.recentOutput[left.recentOutput.length - 1] ?? "") !==
      (right?.recentOutput[right.recentOutput.length - 1] ?? "")
    ) {
      return false;
    }
  }
  return true;
}

function formatShellElapsed(seconds: number): string {
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
  return `${Math.round(seconds)}s`;
}

export function OpenTuiApp({
  session,
  commandRegistry,
  store,
  verbose = false,
  onExit,
  onNewSession,
  themeMode: initialThemeMode,
  themeModePref: initialThemeModePref,
  terminalDefaultFg: initialTerminalFg = null,
  diffDisplay: initialDiffDisplay,
}: OpenTuiAppProps): React.ReactNode {
  const renderer = useRenderer();
  // 界面文案表（language.json）。语言是状态：/language 一改，整棵组件树跟着刷新。
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>(
    () => normalizeUiLanguage(getUiLanguage(getSwarmflowHomeDir())),
  );
  const uiText: UiText = useMemo(() => createUiText(uiLanguage), [uiLanguage]);
  const t = uiText;
  const terminal = useTerminalDimensions();
  const [themeMode, setThemeMode] = useState<ThemeMode>(initialThemeMode);
  const [themeModePref, setThemeModePref] = useState<"auto" | ThemeMode>(initialThemeModePref);
  const [terminalFg, setTerminalFg] = useState<string | null>(initialTerminalFg);
  const [diffDisplayMode, setDiffDisplayMode] = useState<"compact" | "full">(initialDiffDisplay);
  const theme = useMemo<DisplayTheme>(() => {
    // Only apply the terminal-fg override in auto mode. When the user pins a
    // mode (THEME=dark|light or /theme), assume they want the canonical
    // palette — otherwise a dark-pinned UI on a light terminal would render
    // unreadable dark text on a dark bg.
    const override: DeepPartial<DisplayThemeTokens> | undefined =
      themeModePref === "auto" && terminalFg
        ? ({ colors: { text: terminalFg } } as DeepPartial<DisplayThemeTokens>)
        : undefined;
    return createDisplayTheme(themeMode, override);
  }, [themeMode, themeModePref, terminalFg]);
  // Live-follow terminal theme changes only when the user picked "auto".
  useEffect(() => {
    if (themeModePref !== "auto") return;
    const handler = (mode: ThemeMode | null) => {
      const next = parseThemeModePref(mode);
      if (next && next !== "auto") setThemeMode(next);
      // Re-query the terminal palette on every mode flip — the new theme
      // almost certainly changed foreground too. The renderer caches the
      // palette across calls (see Renderer.getPalette), so invalidate the
      // cache first or we get back the old terminal's foreground and the
      // body text stays the previous mode's colour.
      renderer.clearPaletteCache();
      renderer.getPalette({ timeout: 250 })
        .then((p) => setTerminalFg(p?.defaultForeground ?? null))
        .catch(() => { });
    };
    renderer.on("theme_mode", handler);
    return () => {
      renderer.off("theme_mode", handler);
    };
  }, [renderer, themeModePref]);
  const [processing, _setProcessing] = useState(false);
  const processingRef = useRef(false);
  const setProcessing = useCallback((v: boolean) => {
    processingRef.current = v;
    _setProcessing(v);
  }, []);
  const [phase, setPhase] = useState<ActivityPhase>("idle");
  // 重试状态只覆盖输入框中的活动文字，不改变 Working 阶段本身。
  const [retryStatus, setRetryStatus] = useState<string | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryTransitionRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryGenerationRef = useRef(0);
  const clearRetryStatus = useCallback(() => {
    retryGenerationRef.current += 1;
    if (retryTimerRef.current) {
      clearInterval(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (retryTransitionRef.current) {
      clearTimeout(retryTransitionRef.current);
      retryTransitionRef.current = null;
    }
    setRetryStatus(null);
  }, []);
  const showRetryStatus = useCallback((
    attempt: number,
    maxRetries: number,
    delaySec: number,
    kind: "network" | "incomplete" = "network",
  ) => {
    clearRetryStatus();
    const generation = retryGenerationRef.current;
    const seconds = Math.max(0, Number.isFinite(delaySec) ? Math.floor(delaySec) : 0);
    let remaining = seconds;
    const label = kind === "incomplete" ? "Response retry" : "Network retry";
    // 始终保留 attempt/max 与倒计时，避免退化成只有 "Waiting for network"。
    const retryText = (waitSeconds: number) =>
      `${label} ${attempt}/${maxRetries} waiting ${waitSeconds}s`;
    setRetryStatus(retryText(seconds));
    if (seconds === 0) return;
    retryTransitionRef.current = setTimeout(() => {
      retryTransitionRef.current = null;
      if (retryGenerationRef.current !== generation) return;
      setRetryStatus(retryText(remaining));
      retryTimerRef.current = setInterval(() => {
        if (retryGenerationRef.current !== generation) return;
        remaining -= 1;
        if (remaining <= 0) {
          if (retryTimerRef.current) {
            clearInterval(retryTimerRef.current);
            retryTimerRef.current = null;
          }
          setRetryStatus(null);
          return;
        }
        setRetryStatus(retryText(remaining));
      }, 1000);
    }, 250);
  }, [clearRetryStatus]);
  useEffect(() => {
    return () => {
      retryGenerationRef.current += 1;
      if (retryTimerRef.current) clearInterval(retryTimerRef.current);
      if (retryTransitionRef.current) clearTimeout(retryTransitionRef.current);
    };
  }, []);
  const [contextTokens, setContextTokens] = useState(0);
  const [cacheInputTokens, setCacheInputTokens] = useState(0);
  const [cacheReadTokens, setCacheReadTokens] = useState(0);
  const updateContextTokenState = useCallback((totalTokens: number | undefined, cacheTokens?: number, inputTokens?: number) => {
    if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens) || totalTokens <= 0) return;
    setContextTokens(totalTokens);
    setCacheInputTokens(
      typeof inputTokens === "number" && Number.isFinite(inputTokens) && inputTokens > 0
        ? inputTokens
        : totalTokens,
    );
    setCacheReadTokens(cacheTokens ?? 0);
  }, []);
  // Usage snapshot for Codex or Copilot — only one is active at a time, based
  // on the current model provider. Hidden for all other providers.
  const [usageSnapshot, setUsageSnapshot] = useState<UsageSnapshot | null>(null);
  const usagePollerRef = useRef<UsagePoller | null>(null);
  const usagePollerProviderRef = useRef<string | null>(null);
  const [childSessions, setChildSessions] = useState<ChildSessionSnapshot[]>([]);
  const childSessionsRef = useRef(childSessions);
  childSessionsRef.current = childSessions;
  const [dismissedAgentIds, setDismissedAgentIds] = useState<ReadonlySet<string>>(() => new Set());
  const dismissSettledAgents = useCallback(() => {
    setDismissedAgentIds((previous) => dismissSettledAgentIds(previous, childSessionsRef.current));
  }, []);
  const [shellSnapshots, setShellSnapshots] = useState<ShellSnapshotUi[]>([]);
  const [activeShellDetail, setActiveShellDetail] = useState<ShellDetailUi | null>(null);
  const [selectedChildId, setSelectedChildId] = useState<string | null>(null);
  const presentationEntries = usePresentationEntries({ session, selectedChildId, childSessions, processing });
  const turnTimer = useTurnTimer(phase);
  const turnElapsed = turnTimer.elapsed;
  const tasks = useTasks(session);
  const [rootLogRevision, setRootLogRevision] = useState(session.getLogRevision?.() ?? 0);
  const queuedInputs = useMemo(() => {
    if (selectedChildId !== null) return [];
    return projectQueuedInputs([...(session.log ?? [])]);
  }, [rootLogRevision, selectedChildId, session]);
  const queuedInputsRef = useRef(queuedInputs);
  useEffect(() => {
    queuedInputsRef.current = queuedInputs;
  }, [queuedInputs]);
  // Commands that must wait for the active turn to finish are kept outside
  // Session's user-message inbox so they are never projected to the model.
  const queuedCommandRef = useRef<DeferredCommand | null>(null);
  const [queuedCommand, setQueuedCommand] = useState<DeferredCommand | null>(null);

  // Work spans are persisted in the session log, so the stopped status also
  // survives restoring a historical session and does not depend on a React
  // phase transition happening during the current process.
  const lastWorkedStatus = useMemo(() => {
    const entries = session.log ?? [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const end = entries[index];
      if (!end || end.discarded || end.type !== "work_end") continue;
      const endMeta = end.meta as Record<string, unknown>;
      const workId = typeof endMeta.workId === "string" ? endMeta.workId : undefined;
      let elapsedMs = typeof endMeta.elapsedMs === "number" && Number.isFinite(endMeta.elapsedMs)
        ? endMeta.elapsedMs
        : undefined;
      let startedAt: number | undefined;
      if (workId) {
        for (let startIndex = index - 1; startIndex >= 0; startIndex -= 1) {
          const start = entries[startIndex];
          if (!start || start.discarded || start.type !== "work_start") continue;
          const startMeta = start.meta as Record<string, unknown>;
          if (startMeta.workId !== workId) continue;
          startedAt = start.timestamp;
          if (elapsedMs === undefined) elapsedMs = Math.max(0, end.timestamp - start.timestamp);
          break;
        }
      }
      // Use the latest terminal span even when its duration is incomplete, so
      // an older turn's elapsed time is never shown as the current result.
      if (elapsedMs === undefined) {
        return { elapsed: 0, startedAt: null };
      }
      const endedAt = Number.isFinite(end.timestamp) ? end.timestamp : Date.now();
      return {
        elapsed: Math.max(0, elapsedMs / 1000),
        startedAt: startedAt ?? Math.max(0, endedAt - elapsedMs),
      };
    }
    return null;
  }, [rootLogRevision, session]);
  // Tab state for sidebar
  const [tabs, setTabs] = useState<TabState[]>([
    { id: "main", label: "Main Session", icon: "●", closeable: false, kind: "main" },
  ]);
  const [activeTabId, setActiveTabId] = useState("main");
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [sidebarMode, setSidebarMode] = useState<"open" | "close" | "auto">("close");
  // Sync child session tabs — child tabs are now temporary (created on enter, removed on exit).
  // Keep the selected child tab until the user leaves it; released logs remain readable.
  useEffect(() => {
    setTabs((prev) => {
      const currentChildIds = new Set(childSessions.map((s) => s.id));
      return prev.filter((t) => {
        if (t.kind !== "child") return true;
        // Extract child id from tab id (format: "child:{agentId}")
        const childId = t.id.startsWith("child:") ? t.id.slice(6) : t.id;
        return currentChildIds.has(childId) || selectedChildId === childId;
      });
    });
  }, [childSessions, selectedChildId]);
  // Derive selectedChildId from active tab
  // Tab id format is "child:{agentId}" — strip prefix to get the raw session id
  useEffect(() => {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (activeTab?.kind === "child") {
      const childId = activeTab.id.startsWith("child:") ? activeTab.id.slice(6) : activeTab.id;
      setSelectedChildId(childId);
    } else {
      setSelectedChildId(null);
    }
  }, [activeTabId, tabs]);
  // Resolve which scrollbox keyboard handlers (PageUp/PageDown, scroll-to-bottom
  // on keystroke) should act on. Detail tabs have their own scrollbox; the main
  // conversation has its own. Read at call time so we always target the visible
  // surface.
  const getActiveScrollBox = useCallback((): ScrollBoxRenderable | null => {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    const isDetail = activeTab?.kind === "detail-shell";
    return (isDetail ? detailScrollRef.current : mainScrollRef.current) ?? null;
  }, [activeTabId, tabs]);
  const handleCloseTab = useCallback((tabId: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      if (idx === -1 || !prev[idx].closeable) return prev;
      const next = prev.filter((t) => t.id !== tabId);
      if (activeTabId === tabId) {
        setActiveTabId(next[Math.max(0, idx - 1)]?.id ?? "main");
      }
      // If closing a child tab, clear selectedChildId
      if (tabId.startsWith("child:")) {
        setSelectedChildId(null);
      }
      return next;
    });
  }, [activeTabId]);
  const openShellDetailTab = useCallback((shellId: string, commandLabel?: string) => {
    const tabId = `shell:${shellId}`;
    setTabs((prev) => {
      if (prev.some((t) => t.id === tabId)) return prev;
      const label = (commandLabel?.trim() || shellId).slice(0, 28);
      return [...prev, {
        id: tabId,
        label,
        icon: "❯",
        closeable: true,
        kind: "detail-shell" as const,
        shellId,
      }];
    });
    setActiveTabId(tabId);
  }, []);
  const [hint, setHint] = useState<string | null>(null);
  const [mcpFailures, setMcpFailures] = useState<import("./display/overlays/mcp-toast.js").McpFailure[] | null>(null);
  const [usagePanel, setUsagePanel] = useState(false);
  const [usageData, setUsageData] = useState<import("./display/overlays/usage-panel.js").UsageData | null>(null);
  const [usagePage, setUsagePage] = useState<"usage" | "stats">("usage");
  const [usageStatsData, setUsageStatsData] = useState<import("./display/overlays/usage-panel.js").UsageStatsData | null>(null);
  const [statusPanel, setStatusPanel] = useState(false);
  const [memoryPanel, setMemoryPanel] = useState(false);
  const [permissionModeState, setPermissionModeState] = useState<string>(session.permissionMode ?? "reversible");
  const [pendingAsk, setPendingAsk] = useState<PendingAskUi | null>(
    typeof session.getPendingAsk === "function" ? session.getPendingAsk() : null,
  );
  const [askError, setAskError] = useState<string | null>(null);
  const [askSelectionIndex, setAskSelectionIndex] = useState(0);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [questionAnswers, setQuestionAnswers] = useState<Map<number, QuestionAnswerState>>(new Map());
  const [customInputMode, setCustomInputMode] = useState(false);
  const [noteInputMode, setNoteInputMode] = useState(false);
  const [reviewMode, setReviewMode] = useState(false);
  const [askInputValue, setAskInputValue] = useState("");
  const [optionNotes, setOptionNotes] = useState<Map<string, string>>(new Map());
  const [draftValue, setDraftValue] = useState("");
  // inputVisibleLines removed — textarea self-drives height via Yoga measure
  const [commandOverlay, setCommandOverlay] = useState<CommandOverlayState>(EMPTY_COMMAND_OVERLAY);
  const [commandPicker, setCommandPicker] = useState<CommandPickerState | null>(null);
  const [modelUiRevision, setModelUiRevision] = useState(0);
  const [promptSelect, setPromptSelect] = useState<PromptSelectState | null>(null);
  const [helpPanel, setHelpPanel] = useState(false);
  const [promptSecret, setPromptSecret] = useState<PromptSecretState | null>(null);
  const [oauthOverlay, setOauthOverlay] = useState<OAuthOverlayState | null>(null);
  const oauthAbortRef = useRef<AbortController | null>(null);
  // Separate scroll refs so the main conversation's ScrollViewport can stay
  // mounted (and preserve its position) while a detail tab is active.
  // `activeScrollRef` is what keyboard handlers consult — it follows the
  // currently visible scrollbox.
  const mainScrollRef = useRef<ScrollBoxRenderable>(null);
  const detailScrollRef = useRef<ScrollBoxRenderable>(null);
  const inputRef = useRef<TextareaRenderable | null>(null);
  const promptSecretInputRef = useRef<InputRenderable | null>(null);
  const askInputRef = useRef<InputRenderable | null>(null);
  const lastInputValueRef = useRef("");
  const lastCtrlCRef = useRef(0);
  const lastEscRef = useRef(0);
  const closingRef = useRef(false);
  const closingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const suppressComposerSyncRef = useRef(false);
  // Prompt-history position and live-draft preservation live in
  // input/prompt-history.ts. The app-level key handler only decides whether an
  // ↑/↓ key is at the absolute composer boundary or should be normal cursor
  // movement within the current recalled/draft text.
  const pasteCounterRef = useRef(new TurnPasteCounter());
  const imageCounterRef = useRef(0);
  const draftImagesRef = useRef(new Map<string, ProcessedImage & { id: string; index: number }>());
  const maybeCollapseLargePasteRef = useRef<(previousValue: string, nextValue: string) => boolean>(() => false);
  const updateInputOverlayRef = useRef<(value: string, cursorOffset: number) => void>(() => { });
  const composerTokenVisualsRef = useRef<ComposerTokenVisuals | null>(null);
  const promptSelectResolverRef = useRef<((value: string | undefined) => void) | null>(null);
  const promptSecretResolverRef = useRef<((value: string | undefined) => void) | null>(null);
  const commandPickerResolverRef = useRef<((value: CommandPickerResult | undefined) => void) | null>(null);
  const pickerNoteInputRef = useRef<InputRenderable | null>(null);
  const [pickerNoteValue, setPickerNoteValue] = useState("");
  const colors = theme.colors;
  const composerTokenColorsRef = useRef(colors);
  if (!composerTokenVisualsRef.current || composerTokenColorsRef.current !== colors) {
    composerTokenColorsRef.current = colors;
    composerTokenVisualsRef.current = createComposerTokenVisuals(colors);
  }
  const composerTokenVisuals = composerTokenVisualsRef.current;
  useEffect(() => {
    setShikiTheme(theme.mode);
    setSyntaxHighlightTheme(theme.mode);
  }, [theme.mode]);
  // -- Usage poller lifecycle (Codex + Copilot) --
  // Start/stop based on current provider. The poller survives model switches
  // within the same session, but must be torn down and rebuilt when the user
  // switches between Codex and Copilot (different fetch fn + different token).
  useEffect(() => {
    const provider = session.primaryAgent?.modelConfig?.provider;
    const teardown = () => {
      if (usagePollerRef.current) {
        usagePollerRef.current.stop();
        usagePollerRef.current = null;
      }
      usagePollerProviderRef.current = null;
      setUsageSnapshot(null);
    };
    // Copilot moved to usage-based billing (AI Credits) with no per-account
    // quota endpoint, so there's no usage indicator for it — only Codex.
    if (provider !== "openai-codex") {
      teardown();
      return;
    }
    // If the provider changed (e.g. codex → copilot), tear down the old poller
    // because it has the wrong fetchFn baked in. If it's the same provider,
    // just refresh the token and reuse.
    if (
      usagePollerProviderRef.current !== null
      && usagePollerProviderRef.current !== provider
    ) {
      teardown();
    }
    if (provider === "openai-codex") {
      const token = readOAuthAccessToken();
      if (!token) {
        teardown();
        return;
      }
      if (usagePollerRef.current) {
        usagePollerRef.current.updateToken(token);
        return;
      }
      const poller = new UsagePoller(); // default fetchFn = fetchCodexUsage
      usagePollerRef.current = poller;
      usagePollerProviderRef.current = "openai-codex";
      poller.on("update", (snapshot: UsageSnapshot) => setUsageSnapshot(snapshot));
      poller.start(token);
      return () => {
        poller.stop();
        if (usagePollerRef.current === poller) {
          usagePollerRef.current = null;
          usagePollerProviderRef.current = null;
        }
      };
    }
  }, [session.primaryAgent?.modelConfig?.provider]);
  useEffect(() => {
    setAskError(null);
    setAskSelectionIndex(0);
    setCurrentQuestionIndex(0);
    setQuestionAnswers(new Map());
    setCustomInputMode(false);
    setNoteInputMode(false);
    setReviewMode(false);
    setAskInputValue("");
    setOptionNotes(new Map());
  }, [pendingAsk?.id]);
  const autoSave = useCallback(() => {
    if (typeof session.getGlobalPreferences === "function") {
      try {
        const prefs = session.getGlobalPreferences();
        if (prefs.modelProvider && prefs.modelId) {
          persistCurrentModelSelection({
            provider: prefs.modelProvider,
            model: prefs.modelId,
            configName: prefs.modelConfigName,
            thinkingDepth: prefs.thinkingLevel && prefs.thinkingLevel !== "none"
              ? prefs.thinkingLevel
              : undefined,
          }, getSwarmflowHomeDir());
        }
      } catch {
        // 选择状态保存失败不应阻断会话日志保存。
      }
    }
    if (!store || !store.sessionDir || typeof session.getLogForPersistence !== "function") return;
    try {
      const { meta, entries: persistedEntries } = session.getLogForPersistence();
      if (meta.turnCount === 0) return;
      saveLog(store.sessionDir, meta, persistedEntries as any[]);
    } catch {
      // ignore autosave failures in the prototype
    }
  }, [session, store]);
  useEffect(() => {
    session.onSaveRequest = autoSave;
    return () => {
      session.onSaveRequest = undefined;
    };
  }, [session, autoSave]);
  useEffect(() => {
    session.onMcpStatus = (statuses: any[]) => {
      const failed = statuses
        .filter((s: any) => s.state === "failed")
        .map((s: any) => ({ name: s.name, error: s.error }));
      // Reflect current state: show on failure, auto-clear once servers recover.
      setMcpFailures(failed.length > 0 ? failed : null);
      // Hot-update /mcp picker if open
      setCommandPicker((prev) => {
        if (!prev || prev.commandName !== "/mcp") return prev;
        if (prev.stack.length > 1) return prev; // don't refresh while drilled down
        const cmd = commandRegistry.lookup("/mcp");
        if (!cmd?.options) return prev;
        const newOptions = cmd.options({ session, store: store ?? undefined });
        if (newOptions.length === 0) return prev;
        const level = prev.stack[0];
        return {
          ...prev,
          stack: [{
            ...level,
            options: newOptions,
            selected: Math.min(level.selected, newOptions.length - 1),
          }],
        };
      });
    };
    return () => {
      session.onMcpStatus = undefined;
    };
  }, [session, commandRegistry, store]);
  const runPendingTurn = useCallback(async () => {
    if (typeof session.resumePendingTurn !== "function") {
      setAskError("Current session does not support resuming pending asks.");
      return;
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setProcessing(true);
    setPhase("Working");
    try {
      await session.resumePendingTurn({ signal: controller.signal });
      updateContextTokenState(session.lastTotalTokens, session.lastCacheReadTokens ?? 0, session.lastInputTokens);
      setPendingAsk(session.getPendingAsk?.() ?? null);
      autoSave();
    } catch (err) {
      if (!controller.signal.aborted) {
        // The error log entry is written by the runtime (Session); only UI
        // state is handled here.
        setAskError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      abortControllerRef.current = null;
      clearRetryStatus();
      const suspended = Boolean(session.getPendingAsk?.());
      if (suspended) {
        setPhase("Asking");
      } else {
        setProcessing(false);
        setPhase("idle");
      }
    }
  }, [autoSave, clearRetryStatus, session]);
  const getAskQuestions = useCallback((): AgentQuestionItem[] => {
    if (!pendingAsk || pendingAsk.kind !== "agent_question") return [];
    return (pendingAsk.payload["questions"] as AgentQuestionItem[]) ?? [];
  }, [pendingAsk]);
  const resolveAgentQuestion = useCallback((
    answersOverride?: Map<number, QuestionAnswerState>,
    notesOverride?: Map<string, string>,
  ) => {
    if (!pendingAsk || pendingAsk.kind !== "agent_question") return;
    const questions = (pendingAsk.payload["questions"] as AgentQuestionItem[]) ?? [];
    const effectiveAnswers = answersOverride ?? questionAnswers;
    const effectiveNotes = notesOverride ?? optionNotes;
    for (let index = 0; index < questions.length; index += 1) {
      if (!effectiveAnswers.has(index)) {
        setReviewMode(false);
        setCurrentQuestionIndex(index);
        setAskSelectionIndex(0);
        setAskError("Please answer all questions before continuing.");
        return;
      }
    }
    const answers: AgentQuestionAnswer[] = [];
    for (let index = 0; index < questions.length; index += 1) {
      const answer = effectiveAnswers.get(index)!;
      const selectedOption = questions[index].options[answer.optionIndex];
      if (!selectedOption) {
        setReviewMode(false);
        setCurrentQuestionIndex(index);
        setAskSelectionIndex(0);
        setAskError("Selected answer is out of range.");
        return;
      }
      answers.push({
        questionIndex: index,
        selectedOptionIndex: answer.optionIndex,
        answerText: selectedOption.kind === "custom_input" ? (answer.customText ?? "") : selectedOption.label,
        note: effectiveNotes.get(`${index}-${answer.optionIndex}`) || undefined,
      });
    }
    const decision: AgentQuestionDecision = { answers };
    try {
      session.resolveAgentQuestionAsk?.(pendingAsk.id, decision);
      setPendingAsk(session.getPendingAsk?.() ?? null);
      setAskError(null);
      autoSave();
      if (session.hasPendingTurnToResume?.()) {
        void runPendingTurn();
      }
    } catch (err) {
      setAskError(err instanceof Error ? err.message : String(err));
    }
  }, [autoSave, optionNotes, pendingAsk, questionAnswers, runPendingTurn, session]);
  const resolveApproval = useCallback((choiceIndex: number) => {
    if (!pendingAsk || pendingAsk.kind !== "approval") return;
    try {
      session.resolveApprovalAsk?.(pendingAsk.id, choiceIndex);
      setPendingAsk(session.getPendingAsk?.() ?? null);
      setAskError(null);
      autoSave();
      if (session.hasPendingTurnToResume?.()) {
        void runPendingTurn();
      }
    } catch (err) {
      setAskError(err instanceof Error ? err.message : String(err));
    }
  }, [autoSave, pendingAsk, runPendingTurn, session]);
  const confirmCurrentQuestion = useCallback((selectedIndex: number, extra?: { customText?: string }) => {
    const next = new Map(questionAnswers);
    next.set(currentQuestionIndex, { optionIndex: selectedIndex, ...extra });
    setQuestionAnswers(next);
    return next;
  }, [currentQuestionIndex, questionAnswers]);
  const submitOrReview = useCallback((updated: Map<number, QuestionAnswerState>) => {
    const questions = getAskQuestions();
    const firstMissing = questions.findIndex((_, index) => !updated.has(index));
    if (firstMissing !== -1) {
      setReviewMode(false);
      setCurrentQuestionIndex(firstMissing);
      setAskSelectionIndex(0);
      setAskError("Please answer all questions before reviewing.");
      return;
    }
    if (questions.length > 1) {
      setAskError(null);
      setReviewMode(true);
      return;
    }
    resolveAgentQuestion(updated, optionNotes);
  }, [getAskQuestions, optionNotes, resolveAgentQuestion]);
  const beginAskCustomInput = useCallback((selectedIndex: number) => {
    const existing = questionAnswers.get(currentQuestionIndex);
    const initialValue = existing?.optionIndex === selectedIndex ? (existing.customText ?? "") : "";
    setAskInputValue(initialValue);
    setCustomInputMode(true);
  }, [currentQuestionIndex, questionAnswers]);
  const beginAskNoteInput = useCallback((selectedIndex: number) => {
    const noteKey = `${currentQuestionIndex}-${selectedIndex}`;
    setAskInputValue(optionNotes.get(noteKey) ?? "");
    setNoteInputMode(true);
  }, [currentQuestionIndex, optionNotes]);
  const cancelAskInlineInput = useCallback(() => {
    setCustomInputMode(false);
    setNoteInputMode(false);
    setAskInputValue("");
  }, []);
  const resolveSelectedPendingAsk = useCallback(() => {
    if (!pendingAsk || pendingAsk.kind !== "agent_question") return;
    const questions = (pendingAsk.payload["questions"] as AgentQuestionItem[]) ?? [];
    const question = questions[currentQuestionIndex];
    if (!question) return;
    const selectedOption = question.options[askSelectionIndex];
    if (!selectedOption) return;
    if (selectedOption.kind === "custom_input") {
      beginAskCustomInput(askSelectionIndex);
      return;
    }
    const updated = confirmCurrentQuestion(askSelectionIndex);
    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex((current) => current + 1);
      setAskSelectionIndex(0);
      setAskError(null);
      return;
    }
    submitOrReview(updated);
  }, [
    askSelectionIndex,
    beginAskCustomInput,
    confirmCurrentQuestion,
    currentQuestionIndex,
    pendingAsk,
    submitOrReview,
  ]);
  useEffect(() => {
    const syncFromLog = () => {
      const nextChildSessions = session.getChildSessionSnapshots?.() ?? [];
      setDismissedAgentIds((previous) => syncDismissedAgentIds(previous, nextChildSessions));
      setChildSessions((previous) => sameChildSessionList(previous, nextChildSessions) ? previous : nextChildSessions);
      const nextShells = (session.getBackgroundShellSnapshots?.() ?? []) as ShellSnapshotUi[];
      setShellSnapshots((previous) => sameShellSnapshotList(previous, nextShells) ? previous : nextShells);
      // Child snapshots include released sessions when their logs remain available.
      setPendingAsk(session.getPendingAsk?.() ?? null);
      setPermissionModeState(session.permissionMode ?? "reversible");
      setRootLogRevision(session.getLogRevision?.() ?? 0);
      updateContextTokenState(session.lastTotalTokens, session.lastCacheReadTokens ?? 0, session.lastInputTokens);
    };
    syncFromLog();
    const unsubscribe = typeof session.subscribeLog === "function"
      ? session.subscribeLog(syncFromLog)
      : undefined;
    const poller = setInterval(syncFromLog, 250);
    return () => {
      if (unsubscribe) unsubscribe();
      clearInterval(poller);
    };
  }, [selectedChildId, session, updateContextTokenState]);
  useEffect(() => {
    if (!isOpenTuiDiagEnabled()) return;
    const assistantPEs = presentationEntries.filter((pe) => pe.kind === "assistant");
    const lastAssistant = assistantPEs.length > 0 ? assistantPEs[assistantPEs.length - 1] : null;
    writeOpenTuiDiag("app.entries", {
      totalEntries: presentationEntries.length,
      assistantEntries: assistantPEs.length,
      lastAssistantLength: lastAssistant?.assistantText?.length ?? 0,
      processing,
      activeAgents: childSessions.length,
    });
  }, [childSessions.length, presentationEntries, processing]);
  const handleProgressRef = useRef<(event: ProgressEvent) => void>(() => { });
  handleProgressRef.current = (event) => {
    if (closingRef.current) return;
    switch (event.action) {
      case "retry_attempt": {
        const attempt = Number(event.extra["attempt"]);
        const maxRetries = Number(event.extra["maxRetries"]);
        const delaySec = Number(event.extra["delaySec"]);
        const retryKind = event.extra["retryKind"] === "incomplete" ? "incomplete" : "network";
        showRetryStatus(
          Number.isFinite(attempt) ? attempt : 0,
          Number.isFinite(maxRetries) ? maxRetries : 0,
          Number.isFinite(delaySec) ? delaySec : 0,
          retryKind,
        );
        break;
      }
      case "retry_success":
      case "retry_exhausted":
        clearRetryStatus();
        if (event.action === "retry_success") setPhase("Working");
        break;
      case "reasoning_chunk":
      case "text_chunk":
      case "tool_call":
      case "tool_result":
        setPhase("Working");
        break;
      case "agent_no_reply":
        session.appendStatusMessage?.("[No reply] The model chose not to reply.", "no_reply");
        break;
      case "agent_end":
        updateContextTokenState(session.lastTotalTokens, session.lastCacheReadTokens ?? 0, session.lastInputTokens);
        break;
      case "ask_requested":
        setPendingAsk(session.getPendingAsk?.() ?? null);
        setAskError(null);
        setPhase("Asking");
        break;
      case "ask_resolved":
        setPendingAsk(session.getPendingAsk?.() ?? null);
        setAskError(null);
        break;
      case "token_update":
        // Source-side guard in `onTokenUpdate` already drops zero/missing
        // usage, so a token_update event always carries a real input_tokens.
        updateContextTokenState(
          (event.extra["total_tokens"] as number | undefined) ?? (event.extra["input_tokens"] as number | undefined),
          event.extra["cache_read_tokens"] as number | undefined,
          event.extra["input_tokens"] as number | undefined,
        );
        break;
    }
  };
  useEffect(() => {
    const reporter = new ProgressReporter({
      level: verbose ? "verbose" : "normal",
      callback: (event) => {
        handleProgressRef.current(event);
      },
    });
    session.setProgressReporter?.(reporter);
    return () => {
      session.clearProgressReporter?.(reporter);
    };
  }, [session, verbose]);
  // Stable ref for the textarea's expected character width — used by syncComposerState
  // when getComputedWidth() returns 0 (layout not yet computed inside scrollbox).
  const syncComposerState = useCallback(() => {
    const composer = inputRef.current;
    if (!composer || composer.isDestroyed) return;
    const previousValue = lastInputValueRef.current;
    const nextValue = composer.plainText;
    if (previousValue !== nextValue) {
      maybeCollapseLargePasteRef.current(previousValue, nextValue);
      // Prune draft images whose composer token was deleted
      if (draftImagesRef.current.size > 0) {
        const tokens = getComposerTokenSnapshots(composer, ensureComposerTokenType(composer));
        const liveImageIds = new Set(tokens.filter((t) => t.kind === "image" && t.imageId).map((t) => t.imageId));
        for (const id of draftImagesRef.current.keys()) {
          if (!liveImageIds.has(id)) draftImagesRef.current.delete(id);
        }
      }
    }
    const visibleValue = composer.plainText;
    const cursorOffset = composer.cursorOffset;
    lastInputValueRef.current = visibleValue;
    setDraftValue(visibleValue);
    updateInputOverlayRef.current(visibleValue, cursorOffset);
  }, []);
  const setComposerText = useCallback((value: string, cursorToEnd = true) => {
    const composer = inputRef.current;
    if (!composer) return;
    composer.setText(value);
    if (cursorToEnd) {
      composer.cursorOffset = displayWidthWithNewlines(value);
    }
    syncComposerState();
  }, [syncComposerState]);
  const clearInput = useCallback(() => {
    pasteCounterRef.current.reset();
    lastInputValueRef.current = "";
    setDraftValue("");
    setCommandOverlay(EMPTY_COMMAND_OVERLAY);
    setCommandPicker(null);
    if (inputRef.current) {
      inputRef.current.extmarks.clear();
      inputRef.current.setText("");
    }
  }, []);
  const focusComposerSoon = useCallback(() => {
    queueMicrotask(() => {
      inputRef.current?.focus();
    });
  }, []);
  const resolvePromptSelect = useCallback((value: string | undefined) => {
    const resolve = promptSelectResolverRef.current;
    promptSelectResolverRef.current = null;
    setPromptSelect(null);
    if (resolve) resolve(value);
    focusComposerSoon();
  }, [focusComposerSoon]);
  const resolvePromptSecret = useCallback((value: string | undefined) => {
    const resolve = promptSecretResolverRef.current;
    promptSecretResolverRef.current = null;
    setPromptSecret(null);
    if (promptSecretInputRef.current) {
      promptSecretInputRef.current.value = "";
    }
    if (resolve) resolve(value);
    focusComposerSoon();
  }, [focusComposerSoon]);
  const cancelOAuthOverlay = useCallback(() => {
    if (oauthAbortRef.current) {
      oauthAbortRef.current.abort();
      oauthAbortRef.current = null;
    }
    setOauthOverlay((prev) => {
      if (prev) prev.resolve(null);
      return null;
    });
    focusComposerSoon();
  }, [focusComposerSoon]);
  const startOAuthFlow = useCallback((
    provider: OAuthProviderId,
    method: "browser" | "device",
  ) => {
    const controller = new AbortController();
    oauthAbortRef.current = controller;
    const onProgress = (event: OAuthProgress) => {
      switch (event.phase) {
        case "browser_waiting":
          setOauthOverlay((s) => s ? { ...s, phase: { step: "browser_waiting", url: event.url } } : s);
          break;
        case "device_code":
          setOauthOverlay((s) => s ? { ...s, phase: { step: "device_code", url: event.url, userCode: event.userCode } } : s);
          break;
        case "polling":
          setOauthOverlay((s) => s ? { ...s, phase: { step: "polling" } } : s);
          break;
        case "exchanging":
          setOauthOverlay((s) => s ? { ...s, phase: { step: "exchanging" } } : s);
          break;
        case "done":
          setOauthOverlay((s) => s ? { ...s, phase: { step: "done" } } : s);
          break;
        case "error":
          setOauthOverlay((s) => s ? { ...s, phase: { step: "error", message: event.message } } : s);
          break;
      }
    };
    // Route to the correct headless login function.
    // - codex:   browser PKCE or device code (user chose in "choose" step)
    // - copilot: device flow only (no browser option)
    const loginFn: (
      opts: { onProgress: (e: OAuthProgress) => void; signal: AbortSignal },
    ) => Promise<AnyOAuthTokens> =
      provider === "codex"
        ? (method === "browser" ? browserLoginHeadless : deviceCodeLoginHeadless)
        : copilotDeviceCodeLoginHeadless;
    loginFn({ onProgress, signal: controller.signal })
      .then(async (tokens) => {
        if (provider === "codex") {
          saveOAuthTokens(tokens as OAuthTokens);
          session.config?.invalidateModelsByProvider?.("openai-codex");
          if (session.primaryAgent?.modelConfig?.provider === "openai-codex") {
            session.reloadCurrentModelConfig?.();
          }
          const token = readOAuthAccessToken();
          if (token) usagePollerRef.current?.updateToken(token);
        } else {
          saveGitHubTokens(tokens as GitHubOAuthTokens);
          // Prime the Copilot models cache so picker visibility is accurate
          // on first open. Best-effort — failures just leave the picker
          // optimistic until the next refresh cycle.
          try {
            const { refreshCopilotModelsCache } = await import(
              "../../src/providers/copilot-models-cache.js"
            );
            await refreshCopilotModelsCache();
          } catch {
            // ignore
          }
        }
        oauthAbortRef.current = null;
        // Show "Login successful!" briefly before closing
        await new Promise((r) => setTimeout(r, 800));
        setOauthOverlay((prev) => {
          if (prev) prev.resolve(tokens);
          return null;
        });
        focusComposerSoon();
      })
      .catch((err) => {
        if (err instanceof Error && err.message === "Cancelled") return;
        setOauthOverlay((s) => s
          ? { ...s, phase: { step: "error", message: err instanceof Error ? err.message : String(err) } }
          : s);
        oauthAbortRef.current = null;
      });
  }, [focusComposerSoon, session]);
  const acceptOAuthChoice = useCallback(() => {
    setOauthOverlay((s) => {
      if (!s || s.phase.step !== "choose") return s;
      // Schedule flow start outside updater to avoid side effects
      const provider = s.provider;
      const method = s.selected === 0 ? "browser" : "device";
      queueMicrotask(() => startOAuthFlow(provider, method));
      return s;
    });
  }, [startOAuthFlow]);
  /**
   * Show the OAuth overlay and return a promise that resolves
   * with tokens on success, or null on cancel/error.
   *
   * For `codex`: opens the "choose" step first (browser vs device code).
   * For `copilot`: skips the choose step and kicks off device flow
   * immediately (Copilot only supports device flow).
   */
  const requestOAuthLogin = useCallback((
    provider: OAuthProviderId,
  ): Promise<AnyOAuthTokens | null> => {
    return new Promise<AnyOAuthTokens | null>((resolve) => {
      if (provider === "codex") {
        setOauthOverlay({
          provider,
          phase: { step: "choose" },
          selected: 0,
          resolve,
        });
      } else {
        // copilot: jump straight into the device flow.
        setOauthOverlay({
          provider,
          phase: { step: "polling" },
          selected: 0,
          resolve,
        });
        queueMicrotask(() => startOAuthFlow("copilot", "device"));
      }
    });
  }, [startOAuthFlow]);
  // -- Startup OAuth check: prompt login if default model's token is missing/expired --
  const startupOAuthCheckedRef = useRef(false);
  useEffect(() => {
    if (startupOAuthCheckedRef.current) return;
    const provider = session.primaryAgent?.modelConfig?.provider;
    if (provider === "openai-codex") {
      const token = readOAuthAccessToken();
      const needsLogin = !hasOAuthTokens() || (token && isTokenExpiring(token));
      if (!needsLogin) return;
      startupOAuthCheckedRef.current = true;
      queueMicrotask(() => { requestOAuthLogin("codex"); });
    } else if (provider === "copilot") {
      // GitHub App user token is non-expiring — only check presence.
      if (hasGitHubTokens()) return;
      startupOAuthCheckedRef.current = true;
      queueMicrotask(() => { requestOAuthLogin("copilot"); });
    }
  }, [session.primaryAgent?.modelConfig?.provider, requestOAuthLogin]);
  const showHint = useCallback((message: string, durationMs = 2500) => {
    setHint(message);
    setTimeout(() => {
      setHint((current) => (current === message ? null : current));
    }, durationMs);
  }, []);
  // ── Background shells: stop action + picker ─────────────────────────
  const stopShellFromUi = useCallback((shellId: string) => {
    void (async () => {
      const message = await session.stopBackgroundShell?.(shellId);
      if (message) showHint(message, 4000);
    })();
  }, [session, showHint]);
  const buildShellPickerOptions = useCallback((): PromptChoice[] => {
    const snapshots = (session.getBackgroundShellSnapshots?.() ?? []) as ShellSnapshotUi[];
    return snapshots.map((snapshot) => {
      const dot = snapshot.status === "running" ? "●" : "○";
      const tail = snapshot.recentOutput[snapshot.recentOutput.length - 1] ?? "";
      const statusBits = [snapshot.status, formatShellElapsed(snapshot.elapsedSeconds)];
      if (snapshot.exitCode !== null) statusBits.push(`exit ${snapshot.exitCode}`);
      return {
        label: `${dot} [${snapshot.id}] ${snapshot.command.slice(0, 56)}`,
        value: snapshot.id,
        description: tail ? `${statusBits.join(" · ")} · ${tail}` : statusBits.join(" · "),
      };
    });
  }, [session]);
  const openShellsPicker = useCallback(() => {
    const options = buildShellPickerOptions();
    if (options.length === 0) {
      showHint(t.get(["Error", "noShells"]));
      return;
    }
    resolvePromptSelect(undefined);
    resolvePromptSecret(undefined);
    promptSelectResolverRef.current = (shellId) => {
      if (!shellId) return;
      const snapshot = ((session.getBackgroundShellSnapshots?.() ?? []) as ShellSnapshotUi[])
        .find((s) => s.id === shellId);
      openShellDetailTab(shellId, snapshot?.command);
    };
    setCommandOverlay(EMPTY_COMMAND_OVERLAY);
    setCommandPicker(null);
    setPromptSelect({
      message: "Background shells",
      options,
      selected: 0,
      inputArea: true,
      footerHint: "x stop · enter open · esc close",
      actionKeys: {
        x: (option) => {
          void (async () => {
            const message = await session.stopBackgroundShell?.(option.value);
            if (message) showHint(message, 4000);
            // Refresh rows in place; the picker stays open.
            setPromptSelect((current) => {
              if (!current) return current;
              const refreshed = buildShellPickerOptions();
              if (refreshed.length === 0) return current;
              return {
                ...current,
                options: refreshed,
                selected: Math.min(current.selected, refreshed.length - 1),
              };
            });
          })();
        },
      },
    });
  }, [buildShellPickerOptions, openShellDetailTab, resolvePromptSecret, resolvePromptSelect, session, showHint]);
  // Live data for the active detail-shell tab (faster than the global 250ms
  // sync — log tails grow continuously while a shell runs).
  useEffect(() => {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (activeTab?.kind !== "detail-shell" || !activeTab.shellId) {
      setActiveShellDetail(null);
      return;
    }
    const shellId = activeTab.shellId;
    const refresh = () => {
      setActiveShellDetail((session.getBackgroundShellDetail?.(shellId, { maxChars: 32_000 }) ?? null) as ShellDetailUi | null);
    };
    refresh();
    const timer = setInterval(refresh, 500);
    return () => clearInterval(timer);
  }, [activeTabId, tabs, session]);
  // Show one-time hint when running a non-bash shell on Windows.
  useEffect(() => {
    try {
      // Dynamic import so the TUI module doesn't hard-depend on
      // platform internals (opentui-src is outside the src/ TS scope).
      const { shell } = require("../../src/platform/index.js") as {
        shell: { kind: string };
      };
      if (shell.kind === "pwsh") {
        showHint(t.get(["Views", "shell", "pwsh7"]), 8000);
      } else if (shell.kind === "powershell") {
        showHint(t.get(["Views", "shell", "ps51"]), 8000);
      }
    } catch { /* not on Windows or import unavailable */ }
  }, [showHint]);
  const performExit = useCallback(async () => {
    autoSave();
    const msg = GOODBYE_MESSAGES[Math.floor(Math.random() * GOODBYE_MESSAGES.length)]!;
    await onExit(msg);
  }, [autoSave, onExit]);
  const beginClosing = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    queuedCommandRef.current = null;
    setQueuedCommand(null);
    clearRetryStatus();
    setProcessing(false);
    setPhase("closing");
    setHint(null);
    setCommandOverlay(EMPTY_COMMAND_OVERLAY);
    setCommandPicker(null);
    if (closingTimerRef.current) {
      clearTimeout(closingTimerRef.current);
    }
    void performExit();
  }, [clearRetryStatus, performExit]);
  const buildCommandOptions = useCallback((cmdName: string) => {
    const command = commandRegistry.lookup(cmdName);
    if (!command?.options) return [];
    return command.options({
      session,
      store: store ?? undefined,
      swarmflowHomeDir: getSwarmflowHomeDir(),
    });
  }, [commandRegistry, session, store]);
  const pickerMaxVisible = computePickerMaxVisible(terminal.height, theme.layout);
  const commandListMaxVisible = Math.min(pickerMaxVisible, MAX_COMMAND_LIST_VISIBLE);
  const startCommandPicker = useCallback((cmdName: string): boolean => {
    const command = commandRegistry.lookup(cmdName);
    if (command?.pickerFlow === "handler") return false;
    const options = buildCommandOptions(cmdName);
    if (options.length === 0) return false;
    const canonicalCommandName = command?.name ?? cmdName;
    setCommandOverlay(EMPTY_COMMAND_OVERLAY);
    const pickerPresentation = command?.picker;
    setCommandPicker(
      createCommandPicker(
        canonicalCommandName,
        options,
        commandListMaxVisible,
        pickerPresentation?.title,
        pickerPresentation?.allowNote ?? false,
        pickerPresentation?.inputArea ?? false,
        pickerPresentation?.mode === "toggle" ? "toggle" : "single",
      ),
    );
    return true;
  }, [buildCommandOptions, commandRegistry, commandListMaxVisible]);
  const updateInputOverlay = useCallback((value: string, cursorOffset: number) => {
    if (commandPicker || promptSelect || promptSecret) return;
    const livePrefix = inputRef.current ? inputRef.current.getTextRange(0, cursorOffset) : value;
    if (isCommandOverlayEligible(livePrefix)) {
      const prefix = livePrefix.slice(1);
      const matches = commandRegistry.getAll().filter((command) =>
        command.name.slice(1).startsWith(prefix),
      );
      if (matches.length > 0) {
        setCommandOverlay((current) => ({
          mode: "command",
          visible: true,
          items: matches.map((command) => `${command.name.padEnd(20)}${getLocalizedCommandDescription(command, uiLanguage)}`),
          values: matches.map((command) => command.name),
          selected: current.mode === "command"
            ? clamp(current.selected, 0, Math.max(0, matches.length - 1))
            : 0,
        }));
        return;
      }
    }
    const fileQuery = isFileOverlayEligible(value, cursorOffset)
      ? findFileReferenceQuery(value, cursorOffset)
      : null;
    if (fileQuery) {
      const candidates = scanCandidates(fileQuery.prefix);
      if (candidates.length > 0) {
        setCommandOverlay((current) => ({
          mode: "file",
          visible: true,
          items: candidates,
          values: candidates,
          selected: current.mode === "file"
            ? clamp(current.selected, 0, Math.max(0, candidates.length - 1))
            : 0,
        }));
        return;
      }
    }
    setCommandOverlay(EMPTY_COMMAND_OVERLAY);
  }, [commandPicker, commandRegistry, promptSecret, promptSelect, uiLanguage]);
  updateInputOverlayRef.current = updateInputOverlay;
  const resetTurnPasteState = useCallback(() => {
    pasteCounterRef.current.reset();
    imageCounterRef.current = 0;
    draftImagesRef.current.clear();
  }, []);
  const maybeCollapseLargePaste = useCallback((previousValue: string, nextValue: string): boolean => {
    const composer = inputRef.current;
    if (!composer || suppressComposerSyncRef.current) return false;
    const diff = getTextDiffRange(previousValue, nextValue);
    if (!diff || !diff.insertedText) return false;
    const decision = classifyPastedText(diff.insertedText, pasteCounterRef.current);
    if (!decision.replacedWithPlaceholder || decision.index === undefined) return false;
    suppressComposerSyncRef.current = true;
    try {
      replaceRangeWithComposerToken(composer, {
        rangeStart: diff.startOffset,
        rangeEnd: diff.endAfterOffset,
        label: decision.text,
        metadata: {
          kind: "paste",
          label: decision.text,
          submitText: diff.insertedText,
          index: decision.index,
          lineCount: decision.lineCount,
        },
        styleId: composerTokenVisuals.pasteStyleId,
      });
    } finally {
      suppressComposerSyncRef.current = false;
    }
    return true;
  }, [composerTokenVisuals.pasteStyleId]);
  maybeCollapseLargePasteRef.current = maybeCollapseLargePaste;
  useEffect(() => {
    const composer = inputRef.current;
    if (!composer) return;
    patchComposerExtmarksForDisplayWidth(composer);
    const pendingTimers: ReturnType<typeof setTimeout>[] = [];
    const sync = () => {
      syncComposerState();
    };
    const scheduleSync = () => {
      // Clear any previous pending timers to avoid stale callbacks
      for (const id of pendingTimers) clearTimeout(id);
      pendingTimers.length = 0;
      // Sync immediately, then at several deferred points to catch
      // native text buffer layout updates (word-wrap, line count).
      sync();
      queueMicrotask(sync);
      pendingTimers.push(setTimeout(sync, 0));
      pendingTimers.push(setTimeout(sync, 16));
      pendingTimers.push(setTimeout(sync, 50));
    };
    composer.onContentChange = scheduleSync;
    composer.onCursorChange = scheduleSync;
    scheduleSync();
    return () => {
      for (const id of pendingTimers) clearTimeout(id);
      pendingTimers.length = 0;
      if (inputRef.current === composer) {
        composer.onContentChange = undefined;
        composer.onCursorChange = undefined;
      }
    };
  }, [syncComposerState]);
  useEffect(() => {
    if (promptSecret) {
      queueMicrotask(() => {
        promptSecretInputRef.current?.focus();
      });
      return;
    }
    if (phase === "closing") {
      return;
    }
    if (pendingAsk?.kind === "agent_question" && (customInputMode || noteInputMode)) {
      queueMicrotask(() => {
        askInputRef.current?.focus();
      });
      return;
    }
    if (!pendingAsk && !commandPicker && !promptSelect) {
      focusComposerSoon();
    }
  }, [
    commandPicker,
    customInputMode,
    focusComposerSoon,
    noteInputMode,
    pendingAsk,
    phase,
    promptSecret,
    promptSelect,
  ]);
  useEffect(() => {
    return () => {
      promptSelectResolverRef.current?.(undefined);
      promptSecretResolverRef.current?.(undefined);
      promptSelectResolverRef.current = null;
      promptSecretResolverRef.current = null;
      if (closingTimerRef.current) {
        clearTimeout(closingTimerRef.current);
        closingTimerRef.current = null;
      }
    };
  }, []);
  const buildCommandContext = useCallback((): CommandContext => {
    return {
      session,
      store: store ?? undefined,
      swarmflowHomeDir: getSwarmflowHomeDir(),
      commandRegistry,
      autoSave,
      showMessage: (message: string) => {
        // Intercept magic messages from UI-only commands
        if (message === "__toggle_todo_panel__") {
          return;
        }
        if (message.startsWith("__sidebar_mode__:")) {
          const mode = message.slice(17) as "open" | "close" | "auto";
          setSidebarMode(mode);
          showHint(t.get(["Views", "sidebar", "switched"], { mode }));
          return;
        }
        if (message.startsWith("__ui_language__:")) {
          const raw = message.slice("__ui_language__:".length);
          // 只支持 zh / en；未知值回落默认语言。
          const next = normalizeUiLanguage(raw);
          setUiLanguage(next);
          showHint(createUiText(next).get(["Commands", "/language", "hint"], {
            language: createUiText(next).get(["Common", next === "en" ? "languageNameEn" : "languageNameZh"]),
          }));
          return;
        }
        if (message.startsWith("__theme_mode__:")) {
          const raw = message.slice("__theme_mode__:".length);
          // 只受支持三种主题；历史遗留值/未知值归一化为默认主题 Brief。
          const next = normalizeThemeMode(raw);
          setThemeModePref(next);
          setThemeMode(next);
          return;
        }
        if (message.startsWith("__diff_display__:")) {
          const value = message.slice("__diff_display__:".length);
          setDiffDisplayMode(value === "full" ? "full" : "compact");
          return;
        }
        if (message === "__help_panel__") {
          setHelpPanel((current) => !current);
          return;
        }
        if (message === "__usage_panel__") {
          setUsagePage("usage");
          setUsagePanel((current) => !current);
          setStatusPanel(false);
          setMemoryPanel(false);
          return;
        }
        if (message === "__status_panel__") {
          setStatusPanel((current) => !current);
          setUsagePanel(false);
          setMemoryPanel(false);
          return;
        }
        if (message === "__memory_panel__") {
          setMemoryPanel(true);
          setUsagePanel(false);
          setStatusPanel(false);
          return;
        }
        if (message === "__sidebar_toggle__") {
          setSidebarMode((current) => {
            const next = current === "auto" ? "open" : current === "open" ? "close" : "auto";
            showHint(t.get(["Views", "sidebar", "switched"], { mode: next }));
            return next;
          });
          return;
        }
        session.appendStatusMessage?.(message);
      },
      appendSwitchCommandEcho: (command: string, args: string) => {
        const input = args.trim() ? `${command} ${args.trim()}` : command;
        const echo = resolveCommandEchoDisplay(input, uiText.language);
        if (!echo) return;
        if (session.appendCommandEcho) session.appendCommandEcho(echo, "switch");
        else session.appendUserInputDisplay?.(echo);
      },
      resetUiState: () => {
        clearRetryStatus();
        setProcessing(false);
        setPhase("idle");
        updateContextTokenState(session.lastTotalTokens, session.lastCacheReadTokens ?? 0, session.lastInputTokens);
        setPendingAsk(null);
        setAskError(null);
      },
      requestFullRepaint: () => {
        renderer?.requestFullRepaint?.();
      },
      restartRuntimeForNewSession: onNewSession,
      onTurnRequested: (content: string) => {
        void handleSubmit(content);
      },
      onInjectedTurnRequested: (displayText: string, content: string) => {
        void runInjectedCommand(displayText, content);
      },
      onManualCompactRequested: (instruction: string) => {
        void runManualCompact(instruction);
      },
      onShellsRequested: () => {
        openShellsPicker();
      },
      showHint,
      isProcessing: () => processingRef.current,
      promptSecret: async (request: PromptSecretRequest) => {
        resolvePromptSecret(undefined);
        resolvePromptSelect(undefined);
        return await new Promise<string | undefined>((resolve) => {
          promptSecretResolverRef.current = resolve;
          setCommandOverlay(EMPTY_COMMAND_OVERLAY);
          setCommandPicker(null);
          setPromptSecret({
            message: request.message,
            allowEmpty: request.allowEmpty ?? false,
            inputArea: request.inputArea ?? true,
          });
          queueMicrotask(() => {
            promptSecretInputRef.current?.focus();
          });
        });
      },
      promptSelect: async (request: PromptSelectRequest) => {
        resolvePromptSelect(undefined);
        resolvePromptSecret(undefined);
        return await new Promise<string | undefined>((resolve) => {
          promptSelectResolverRef.current = resolve;
          setCommandOverlay(EMPTY_COMMAND_OVERLAY);
          setCommandPicker(null);
          setPromptSelect({
            message: request.message,
            options: request.options,
            selected: 0,
            inputArea: request.inputArea ?? true,
          });
        });
      },
      promptCommandPicker: async (options: CommandOption[], config?: CommandPickerPresentation) => {
        resolvePromptSelect(undefined);
        resolvePromptSecret(undefined);
        return await new Promise<CommandPickerResult | undefined>((resolve) => {
          commandPickerResolverRef.current = resolve;
          setCommandOverlay(EMPTY_COMMAND_OVERLAY);
          setPromptSelect(null);
          setPickerNoteValue("");
          setCommandPicker(
            createCommandPicker(
              "",
              options,
              pickerMaxVisible,
              config?.title,
              config?.allowNote,
              config?.inputArea ?? true,
              config?.mode === "toggle" ? "toggle" : "single",
            ),
          );
        });
      },
      requestOAuthLogin,
    };
  }, [clearRetryStatus, session, store, commandRegistry, autoSave, onNewSession, resolvePromptSecret, resolvePromptSelect, requestOAuthLogin, pickerMaxVisible, updateContextTokenState, uiText]);
  const runTurn = useCallback(async (input: string, inlineImages?: InlineImageInput[]) => {
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setProcessing(true);
    setPhase("Working");
    try {
      await session.turn(input, { signal: controller.signal, inlineImages });
      updateContextTokenState(session.lastTotalTokens, session.lastCacheReadTokens ?? 0, session.lastInputTokens);
      setPendingAsk(session.getPendingAsk?.() ?? null);
      autoSave();
    } catch {
      // The error log entry is written by the runtime (Session.turn); nothing
      // to add at the UI layer.
    } finally {
      abortControllerRef.current = null;
      clearRetryStatus();
      const suspended = Boolean(session.getPendingAsk?.());
      if (suspended) {
        setPhase("Asking");
      } else {
        setProcessing(false);
        setPhase("idle");
      }
    }
  }, [clearRetryStatus, session, autoSave, updateContextTokenState]);
  const runManualCompact = useCallback(async (instruction: string) => {
    if (typeof session.runManualCompact !== "function") {
      session.appendStatusMessage?.("/compact is not available in this session.");
      return;
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setProcessing(true);
    setPhase("Compacting");
    try {
      await session.runManualCompact(instruction, {
        signal: controller.signal,
        completionDisplay: `• ${uiText.get(["Commands", "/compact", "compacted"])}`,
      });
      autoSave();
    } catch {
      // Error log entry written by the runtime (runManualCompact).
    } finally {
      abortControllerRef.current = null;
      clearRetryStatus();
      setProcessing(false);
      setPhase("idle");
    }
  }, [clearRetryStatus, session, autoSave, uiText]);
  const getSerializedComposerInput = useCallback((): string => {
    const composer = inputRef.current;
    if (!composer) return draftValue;
    return serializeComposerText(composer, ensureComposerTokenType(composer));
  }, [draftValue]);
  const handleSubmit = useCallback(async (submittedValue: string) => {
    const input = submittedValue.trim();
    if (!input) return;
    const cmdToken = input.startsWith("/") ? input.split(/\s/)[0] : "";
    const slashCommand = cmdToken ? commandRegistry.lookup(cmdToken) : undefined;
    // 命令注册信息决定能否在工作中执行；不能把斜杠命令当普通消息送入队列。
    if (slashCommand?.executionMode === "always"
      || (processingRef.current && slashCommand?.executionMode === "whenBusy")) {
      if (cmdToken === "/new") {
        queuedCommandRef.current = null;
        setQueuedCommand(null);
      }
      appendPromptHistory(input);
      clearInput();
      const args = input.slice(cmdToken.length).trim();
      try {
        await slashCommand.handler(buildCommandContext(), args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        session.appendErrorMessage?.(t.get(["Error", "commandFailed"], { command: cmdToken, message }), "command");
      }
      setModelUiRevision((revision) => revision + 1);
      return;
    }
    // 等待中的 /plan 已先于后续输入提交；不能在轮次结束与定时分派
    // 之间让新消息插队，也不能让另一条 /plan 覆盖它。
    if (queuedCommandRef.current && !processingRef.current) {
      showHint(t.get(["Error", "alreadyQueued"]));
      return;
    }
    if (processingRef.current && slashCommand?.executionMode === "queued") {
      const item = enqueueDeferredCommand(
        commandRegistry, session, input, queuedCommandRef.current, queuedInputsRef.current.length > 0,
      );
      if (!item) {
        showHint(t.get(["Error", "alreadyQueued"]));
        return;
      }
      queuedCommandRef.current = item;
      setQueuedCommand(item);
      appendPromptHistory(input);
      clearInput();
      showHint(t.get(["Views", "queue", "queued"]));
      return;
    }
    if (pendingAsk) {
      if (pendingAsk.kind === "approval") {
        resolveApproval(askSelectionIndex);
      } else {
        showHint(t.get(["Error", "askNotImplemented"]));
      }
      return;
    }
    if (!processingRef.current && input.startsWith("/") && !/\s/.test(input)) {
      const command = commandRegistry.lookup(input);
      if (command?.options && startCommandPicker(input)) {
        appendPromptHistory(input);
        if (inputRef.current) {
          inputRef.current.extmarks.clear();
          inputRef.current.setText("");
        }
        resetTurnPasteState();
        lastInputValueRef.current = "";
        setDraftValue("");
        return;
      }
    }
    // Use ref to avoid stale closure — OpenTUI's custom renderer may not
    // re-create useCallback closures on every state change.
    const isProcessing = processingRef.current;
    if (isProcessing) {
      if (cmdToken) {
        if (!slashCommand) {
          session.appendErrorMessage?.(t.get(["Error", "unknownCommand"], { command: cmdToken }), "command");
        } else {
          showHint(t.get(["Error", "waitForFinish"]));
        }
        return;
      }
      if (queuedInputsRef.current.length > 0 || queuedCommandRef.current) {
        showHint(t.get(["Error", "alreadyQueued"]));
        return;
      }
      if (typeof session.deliverMessage === "function") {
        const decision = session.deliverMessage("user", input);
        queuedInputsRef.current = projectQueuedInputs([...(session.log ?? [])]);
        if (decision && decision.accepted === false) {
          showHint(decision.reason === "compact_in_progress"
            ? t.get(["Error", "compacting"])
            : t.get(["Error", "alreadyQueued"]));
          return;
        }
        if (!selectedChildId) dismissSettledAgents();
        appendPromptHistory(input);
        clearInput();
        showHint(t.get(["Views", "queue", "queued"]));
      } else {
        showHint(t.get(["Error", "assistantBusy"]));
      }
      return;
    }
    appendPromptHistory(input);
    // Capture image tokens before clearInput destroys composer state
    let inlineImages: InlineImageInput[] | undefined;
    if (draftImagesRef.current.size > 0) {
      const images: InlineImageInput[] = [];
      for (const [imageId, img] of draftImagesRef.current) {
        // Only include images whose placeholder is still in the text
        if (input.includes(`[Image #${img.index}]`)) {
          images.push({ id: imageId, base64: img.base64, mediaType: img.mediaType });
        }
      }
      if (images.length > 0) inlineImages = images;
    }
    clearInput();
    if (input.startsWith("/")) {
      const [cmdName] = input.split(/\s+/, 1);
      const args = input.slice(cmdName.length).trim();
      const command = commandRegistry.lookup(cmdName);
      if (!command) {
        session.appendErrorMessage?.(t.get(["Error", "unknownCommand"], { command: cmdName }), "command");
        return;
      }
      // Provider 是多步配置流程；在流程入口回显
      // "供应商切换为 protocol:..." 会把中间参数误认为最终结果。
      // 成功/失败信息由 provider 命令流程自己显示。
      // /permission 要等选择结果落定后再回显本地化模式名，不能先按原始参数回显。
      const deferredEcho = cmdName === "/rename" || cmdName === "/compact" || cmdName === "/provider" || cmdName === "/permission";
      if (!deferredEcho) {
        const echo = resolveCommandEchoDisplay(input, uiText.language);
        if (session.appendCommandEcho) {
          session.appendCommandEcho(echo ?? input, echo ? "switch" : "injected");
        } else {
          session.appendUserInputDisplay?.(echo ?? input);
        }
      }
      try {
        await command.handler(buildCommandContext(), args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        session.appendErrorMessage?.(t.get(["Error", "commandFailed"], { command: cmdName, message }), "command");
      }
      setModelUiRevision((revision) => revision + 1);
      return;
    }
    if (!selectedChildId) dismissSettledAgents();
    await runTurn(input, inlineImages);
  }, [
    askSelectionIndex,
    clearInput,
    pendingAsk,
    processing,
    selectedChildId,
    resolveApproval,
    session,
    commandRegistry,
    startCommandPicker,
    buildCommandContext,
    runTurn,
    dismissSettledAgents,
    showHint,
  ]);
  // 普通消息可在同一轮末尾自动续跑；等待 Session 及其消息队列完全空闲。
  useEffect(() => {
    if (!queuedCommand) return;
    const drain = () => {
      if (closingRef.current || processingRef.current) return;
      const item = queuedCommandRef.current;
      const command = takeReadyDeferredCommand(item, session, session.canRunDeferredCommand?.() === true);
      if (!command) return;
      if (selectedChildId) return;
      queuedCommandRef.current = null;
      setQueuedCommand(null);
      const cmdToken = command.split(/\s/, 1)[0] ?? "";
      const handler = commandRegistry.lookup(cmdToken)?.handler;
      if (!handler) return;
      const args = command.slice(cmdToken.length).trim();
      const echo = resolveCommandEchoDisplay(command, uiText.language);
      if (session.appendCommandEcho) session.appendCommandEcho(echo ?? command, echo ? "switch" : "injected");
      else session.appendUserInputDisplay?.(echo ?? command);
      void Promise.resolve()
        .then(() => handler(buildCommandContext(), args))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          session.appendErrorMessage?.(uiText.get(["Error", "commandFailed"], { command: cmdToken, message }), "command");
        });
    };
    const timer = setInterval(drain, 100);
    drain();
    return () => clearInterval(timer);
  }, [buildCommandContext, commandRegistry, queuedCommand, selectedChildId, session, uiText]);
  useEffect(() => {
    queuedCommandRef.current = null;
    setQueuedCommand(null);
  }, [session]);
  const runInjectedCommand = useCallback(async (displayText: string, content: string) => {
    const s = session as any;
    if (typeof s.runInjectedCommand !== "function") {
      void handleSubmit(content);
      return;
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setProcessing(true);
    setPhase("Working");
    try {
      await s.runInjectedCommand(displayText, content, { signal: controller.signal });
      updateContextTokenState(session.lastTotalTokens, session.lastCacheReadTokens ?? 0, session.lastInputTokens);
      setPendingAsk(session.getPendingAsk?.() ?? null);
      autoSave();
    } catch {
      // Error log entry written by the runtime (runInjectedCommand).
    } finally {
      abortControllerRef.current = null;
      clearRetryStatus();
      const suspended = Boolean(session.getPendingAsk?.());
      if (suspended) {
        setPhase("Asking");
      } else {
        setProcessing(false);
        setPhase("idle");
      }
    }
  }, [clearRetryStatus, session, autoSave, handleSubmit, updateContextTokenState]);
  const acceptInputOverlaySelection = useCallback(() => {
    const selectedValue = commandOverlay.values[commandOverlay.selected];
    if (!selectedValue) {
      setCommandOverlay(EMPTY_COMMAND_OVERLAY);
      return;
    }
    if (commandOverlay.mode === "file") {
      const composer = inputRef.current;
      if (!composer) {
        setCommandOverlay(EMPTY_COMMAND_OVERLAY);
        return;
      }
      const query = findFileReferenceQuery(composer.plainText, composer.cursorOffset);
      if (!query) {
        setCommandOverlay(EMPTY_COMMAND_OVERLAY);
        return;
      }
      const label = buildFileReferenceLabel(selectedValue);
      suppressComposerSyncRef.current = true;
      try {
        replaceRangeWithComposerToken(composer, {
          rangeStart: query.startOffset,
          rangeEnd: query.endOffset,
          label,
          metadata: {
            kind: "file",
            label,
            submitText: label,
            path: selectedValue,
          },
          styleId: composerTokenVisuals.fileStyleId,
          trailingText: " ",
        });
      } finally {
        suppressComposerSyncRef.current = false;
      }
      setCommandOverlay(EMPTY_COMMAND_OVERLAY);
      syncComposerState();
      return;
    }
    const command = commandRegistry.lookup(selectedValue);
    setCommandOverlay(EMPTY_COMMAND_OVERLAY);
    if (command?.options && startCommandPicker(selectedValue)) {
      if (inputRef.current) {
        inputRef.current.setText("");
        inputRef.current.extmarks.clear();
      }
      resetTurnPasteState();
      lastInputValueRef.current = "";
      setDraftValue("");
      return;
    }
    void handleSubmit(selectedValue);
  }, [
    commandOverlay,
    commandRegistry,
    composerTokenVisuals.fileStyleId,
    handleSubmit,
    resetTurnPasteState,
    startCommandPicker,
    syncComposerState,
  ]);
  const completeInputOverlaySelection = useCallback(() => {
    const selectedValue = commandOverlay.values[commandOverlay.selected];
    if (!selectedValue) {
      setCommandOverlay(EMPTY_COMMAND_OVERLAY);
      return;
    }
    if (commandOverlay.mode === "file") {
      acceptInputOverlaySelection();
      return;
    }
    setComposerText(`${selectedValue} `);
    setCommandOverlay(EMPTY_COMMAND_OVERLAY);
  }, [acceptInputOverlaySelection, commandOverlay, setComposerText]);
  const applyCommandPickerResult = useCallback((
    result: CommandPickerAcceptResult | null,
    sourcePicker: CommandPickerState,
  ): void => {
    if (!result) {
      setCommandPicker(null);
      return;
    }
    if (result.kind === "drill_down") {
      setCommandPicker(result.picker);
      return;
    }
    if (result.kind === "custom_input") {
      setPickerNoteValue("");
      setCommandPicker(result.picker);
      return;
    }
    if (result.kind === "toggle") {
      const commandName = sourcePicker.commandName;
      setCommandPicker(null);
      setPickerNoteValue("");
      const pickerResolver = commandPickerResolverRef.current;
      if (pickerResolver) {
        commandPickerResolverRef.current = null;
        pickerResolver({ value: result.value });
      } else {
        void handleSubmit(result.command).finally(() => {
          startCommandPicker(commandName);
        });
      }
      return;
    }
    setCommandPicker(null);
    setPickerNoteValue("");
    const pickerResolver = commandPickerResolverRef.current;
    if (pickerResolver) {
      commandPickerResolverRef.current = null;
      const spaceIdx = result.command.indexOf(" ");
      const value = spaceIdx >= 0 ? result.command.slice(spaceIdx + 1) : result.command;
      pickerResolver({ value, note: result.note });
      return;
    }
    void handleSubmit(result.command);
  }, [handleSubmit, startCommandPicker]);
  const acceptCommandPickerSelectionLocal = useCallback(() => {
    if (!commandPicker) return;
    const result = acceptCommandPickerSelection(commandPicker);
    applyCommandPickerResult(result, commandPicker);
  }, [applyCommandPickerResult, commandPicker]);
  const clickCommandPickerItem = useCallback((index: number) => {
    if (!commandPicker) return;
    const withSelection = setCommandPickerSelection(commandPicker, index);
    const result = acceptCommandPickerSelection(withSelection);
    applyCommandPickerResult(result, withSelection);
  }, [applyCommandPickerResult, commandPicker]);
  const clickOverlayItem = useCallback((index: number) => {
    const selectedValue = commandOverlay.values[index];
    if (!selectedValue) {
      setCommandOverlay(EMPTY_COMMAND_OVERLAY);
      return;
    }
    if (commandOverlay.mode === "file") {
      // Set selection and let the standard accept handle file references
      setCommandOverlay((current) => ({ ...current, selected: index }));
      acceptInputOverlaySelection();
      return;
    }
    const command = commandRegistry.lookup(selectedValue);
    setCommandOverlay(EMPTY_COMMAND_OVERLAY);
    if (command?.options && startCommandPicker(selectedValue)) {
      if (inputRef.current) {
        inputRef.current.setText("");
        inputRef.current.extmarks.clear();
      }
      resetTurnPasteState();
      lastInputValueRef.current = "";
      setDraftValue("");
      return;
    }
    void handleSubmit(selectedValue);
  }, [commandOverlay, commandRegistry, startCommandPicker, handleSubmit, acceptInputOverlaySelection, resetTurnPasteState]);
  const clickPromptSelectItem = useCallback((index: number) => {
    if (!promptSelect) return;
    const option = promptSelect.options[clamp(index, 0, promptSelect.options.length - 1)];
    resolvePromptSelect(option?.value);
  }, [promptSelect, resolvePromptSelect]);
  const deleteToVisualLineStart = useCallback(() => {
    const composer = inputRef.current;
    if (!composer) return;
    if (composer.hasSelection()) {
      composer.deleteCharBackward();
      syncComposerState();
      return;
    }
    const cursor = composer.editorView.getCursor();
    const visualStart = composer.editorView.getVisualSOL();
    const action = getDeleteToVisualLineStartAction(cursor, visualStart);
    if (action === "noop") {
      return;
    }
    if (action === "delete-to-line-start") {
      composer.deleteToLineStart();
      syncComposerState();
      return;
    }
    composer.gotoVisualLineHome({ select: true });
    if (composer.hasSelection()) {
      composer.deleteCharBackward();
    }
    syncComposerState();
  }, [syncComposerState]);
  const isAtFirstVisualLine = useCallback((): boolean => {
    const composer = inputRef.current;
    if (!composer) return false;
    const visualStart = composer.editorView.getVisualSOL();
    return visualStart.logicalRow === 0 && visualStart.logicalCol === 0;
  }, []);
  const isAtLastVisualLine = useCallback((): boolean => {
    const composer = inputRef.current;
    if (!composer) return false;
    const lineCount = composer.lineCount || composer.editBuffer.getLineCount();
    const visualEnd = composer.editorView.getVisualEOL();
    const logicalEnd = composer.editBuffer.getEOL();
    return (
      visualEnd.logicalRow === Math.max(0, lineCount - 1) &&
      visualEnd.logicalCol === logicalEnd.col
    );
  }, []);
  const moveComposerVertically = useCallback((direction: "up" | "down") => {
    const composer = inputRef.current;
    if (!composer) return;
    if (direction === "up") {
      composer.moveCursorUp();
    } else {
      composer.moveCursorDown();
    }
    syncComposerState();
  }, [syncComposerState]);
  const acceptPromptSelect = useCallback(() => {
    if (!promptSelect) return;
    const option = promptSelect.options[clamp(promptSelect.selected, 0, promptSelect.options.length - 1)];
    resolvePromptSelect(option?.value);
  }, [promptSelect, resolvePromptSelect]);
  const submitPromptSecret = useCallback((value: string) => {
    if (!promptSecret) return;
    if (!promptSecret.allowEmpty && value.trim() === "") {
      showHint(t.get(["Error", "valueRequired"]));
      return;
    }
    resolvePromptSecret(value);
  }, [promptSecret, resolvePromptSecret, showHint]);
  const submitAskInlineInput = useCallback((value: string) => {
    if (!pendingAsk || pendingAsk.kind !== "agent_question") return;
    const questions = (pendingAsk.payload["questions"] as AgentQuestionItem[]) ?? [];
    if (noteInputMode) {
      const noteText = value.trim();
      const noteKey = `${currentQuestionIndex}-${askSelectionIndex}`;
      setOptionNotes((current) => {
        const next = new Map(current);
        if (noteText) {
          next.set(noteKey, noteText);
        } else {
          next.delete(noteKey);
        }
        return next;
      });
      confirmCurrentQuestion(askSelectionIndex);
      cancelAskInlineInput();
      return;
    }
    if (!customInputMode) return;
    const customText = value.trim();
    if (!customText) {
      setAskError(CUSTOM_EMPTY_HINT);
      return;
    }
    const updated = confirmCurrentQuestion(askSelectionIndex, { customText });
    cancelAskInlineInput();
    setAskError(null);
    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex((current) => current + 1);
      setAskSelectionIndex(0);
      return;
    }
    submitOrReview(updated);
  }, [
    askSelectionIndex,
    cancelAskInlineInput,
    confirmCurrentQuestion,
    currentQuestionIndex,
    customInputMode,
    noteInputMode,
    pendingAsk,
    submitOrReview,
  ]);
  useKeyboard((event) => {
    const selectionText = renderer.getSelection()?.getSelectedText() ?? "";
    const hasSelection = selectionText.length > 0;
    const isCopyCombo = event.name === "c" && (event.meta || event.super || event.ctrl);
    const composer = inputRef.current;
    if (phase === "closing") {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (hasSelection && isCopyCombo) {
      // copyToClipboard is async because the native tool runs in a
      // child process; we eagerly clear selection and only surface a
      // hint when the copy ultimately fails.
      void copyToClipboard(selectionText, (text) => renderer.copyToClipboardOSC52(text))
        .then((copied) => {
          if (!copied) showHint(t.get(["Error", "copyFailed"]));
        });
      renderer.clearSelection();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (helpPanel) {
      if (event.name === "escape" || (event.name === "c" && event.ctrl)) {
        setHelpPanel(false);
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (usagePanel) {
      if (event.name === "escape" || (event.name === "c" && event.ctrl)) {
        setUsagePanel(false);
        event.preventDefault();
        event.stopPropagation();
      } else if (event.name === "left" || event.name === "right") {
        setUsagePage(event.name === "left" ? "usage" : "stats");
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (statusPanel || memoryPanel) {
      if (event.name === "escape" || (event.name === "c" && event.ctrl)) {
        setStatusPanel(false);
        setMemoryPanel(false);
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (hasSelection && event.name === "escape") {
      renderer.clearSelection();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (promptSecret) {
      if (event.name === "escape" || (event.name === "c" && event.ctrl)) {
        resolvePromptSecret(undefined);
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (promptSelect) {
      if (event.name === "up" || (event.name === "tab" && event.shift)) {
        setPromptSelect((current) => current
          ? { ...current, selected: (current.selected - 1 + current.options.length) % current.options.length }
          : current);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "down" || event.name === "tab") {
        setPromptSelect((current) => current
          ? { ...current, selected: (current.selected + 1) % current.options.length }
          : current);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "return") {
        acceptPromptSelect();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "escape" || (event.name === "c" && event.ctrl)) {
        resolvePromptSelect(undefined);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // Per-option action keys (e.g. x → stop shell in the shells picker).
      const actionHandler = !event.ctrl && !event.meta
        ? promptSelect.actionKeys?.[event.name]
        : undefined;
      if (actionHandler) {
        const option = promptSelect.options[clamp(promptSelect.selected, 0, promptSelect.options.length - 1)];
        if (option) actionHandler(option);
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (oauthOverlay) {
      if (oauthOverlay.phase.step === "choose") {
        if (event.name === "up" || (event.name === "tab" && event.shift)) {
          setOauthOverlay((s) => s ? { ...s, selected: s.selected === 0 ? 1 : 0 } : s);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.name === "down" || event.name === "tab") {
          setOauthOverlay((s) => s ? { ...s, selected: s.selected === 0 ? 1 : 0 } : s);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.name === "return") {
          acceptOAuthChoice();
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
      if (event.name === "escape" || (event.name === "c" && event.ctrl)) {
        cancelOAuthOverlay();
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (pendingAsk?.kind === "approval") {
      // Esc / Ctrl+C: pass through to performInterrupt below (deny + abort)
      if (event.name === "escape" || (event.name === "c" && event.ctrl)) {
        // fall through
      } else {
        const totalOptions = pendingAsk.options.length;
        if (event.name === "up") {
          setAskSelectionIndex((prev) => Math.max(0, prev - 1));
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.name === "down") {
          setAskSelectionIndex((prev) => Math.min(totalOptions - 1, prev + 1));
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.name === "return") {
          resolveApproval(askSelectionIndex);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        // Number keys for quick selection
        if (/^[1-9]$/.test(event.name)) {
          const idx = Number(event.name) - 1;
          if (idx < totalOptions) {
            resolveApproval(idx);
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        }
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    if (pendingAsk?.kind === "agent_question") {
      // Esc / Ctrl+C pass through to performInterrupt (deny + abort) ONLY when
      // not in a sub-mode. Sub-modes handle Esc as "exit sub-mode" (not deny).
      const inSubMode = reviewMode || customInputMode || noteInputMode;
      if (inSubMode || !(event.name === "escape" || (event.name === "c" && event.ctrl))) {
        const questions = (pendingAsk.payload["questions"] as AgentQuestionItem[]) ?? [];
        const question = questions[currentQuestionIndex];
        const totalOptions = question?.options.length ?? 0;
        const agentOptionCount = question?.options.filter((option) => !option.systemAdded).length ?? 0;
        if (reviewMode) {
          if (event.name === "return") {
            resolveAgentQuestion(questionAnswers, optionNotes);
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (event.name === "escape") {
            setReviewMode(false);
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (/^[1-9]$/.test(event.name)) {
            const nextQuestionIndex = Number(event.name) - 1;
            if (nextQuestionIndex < questions.length) {
              setReviewMode(false);
              setCurrentQuestionIndex(nextQuestionIndex);
              setAskSelectionIndex(questionAnswers.get(nextQuestionIndex)?.optionIndex ?? 0);
            }
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          return;
        }
        if (customInputMode || noteInputMode) {
          if (event.name === "escape") {
            cancelAskInlineInput();
            event.preventDefault();
            event.stopPropagation();
          }
          return;
        }
        if (!question) return;
        if (event.name === "tab" && askSelectionIndex < agentOptionCount) {
          beginAskNoteInput(askSelectionIndex);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.name === "up" && totalOptions > 0) {
          setAskSelectionIndex((current) => (current - 1 + totalOptions) % totalOptions);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.name === "down" && totalOptions > 0) {
          setAskSelectionIndex((current) => (current + 1) % totalOptions);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.name === "left" && questions.length > 1) {
          setCurrentQuestionIndex((current) => Math.max(0, current - 1));
          setAskSelectionIndex(questionAnswers.get(Math.max(0, currentQuestionIndex - 1))?.optionIndex ?? 0);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.name === "right" && questions.length > 1) {
          if (question.options[askSelectionIndex]?.kind !== "custom_input") {
            confirmCurrentQuestion(askSelectionIndex);
          }
          const nextQuestionIndex = Math.min(questions.length - 1, currentQuestionIndex + 1);
          setCurrentQuestionIndex(nextQuestionIndex);
          setAskSelectionIndex(questionAnswers.get(nextQuestionIndex)?.optionIndex ?? 0);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.name === "return") {
          resolveSelectedPendingAsk();
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
    }
    if (isCommandPickerActive(commandPicker)) {
      if (commandPicker.noteEditing) {
        if (event.name === "return") {
          event.preventDefault();
          event.stopPropagation();
          const level = getCommandPickerLevel(commandPicker);
          const option = level.options[level.selected];
          const typed = pickerNoteValue.trim();
          setCommandPicker(null);
          setPickerNoteValue("");
          if (option) {
            const pickerResolver = commandPickerResolverRef.current;
            if (pickerResolver) {
              commandPickerResolverRef.current = null;
              pickerResolver({ value: option.value, note: typed || undefined });
            } else {
              void handleSubmit(`${commandPicker.commandName} ${option.value}`.trim());
            }
          }
          return;
        }
        if (event.name === "escape") {
          event.preventDefault();
          event.stopPropagation();
          setPickerNoteValue("");
          setCommandPicker((current) => current ? { ...toggleCommandPickerNoteEditing(current), note: "" } : current);
          return;
        }
        // All other keys go to the note input — don't intercept
        return;
      }
      if (commandPicker.customInputMode) {
        if (event.name === "return") {
          event.preventDefault();
          event.stopPropagation();
          // Submit directly from the live closure. Broken since the feature
          // shipped (v0.3.7): the old "exit mode, then re-accept in a
          // microtask" round trip invoked the PREVIOUS render's accept
          // callback, whose closure still saw customInputMode=true and an
          // empty note — accept hit the customInput option again, re-entered
          // input mode, and cleared the field. Enter appeared to do nothing.
          const level = getCommandPickerLevel(commandPicker);
          const option = level.options[level.selected];
          const typed = pickerNoteValue.trim();
          setCommandPicker(null);
          setPickerNoteValue("");
          if (option) {
            const pickerResolver = commandPickerResolverRef.current;
            if (pickerResolver) {
              commandPickerResolverRef.current = null;
              pickerResolver({ value: option.value, note: typed || undefined });
            } else {
              void handleSubmit(`${commandPicker.commandName} ${option.value}`.trim());
            }
          }
          return;
        }
        if (event.name === "escape") {
          event.preventDefault();
          event.stopPropagation();
          setPickerNoteValue("");
          setCommandPicker((current) => current ? exitCommandPickerCustomInput(current) : current);
          return;
        }
        // All other keys go to the custom input — don't intercept
        return;
      }
      if (event.name === "up") {
        setCommandPicker((current) => current ? moveCommandPickerSelection(current, -1) : current);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "down") {
        setCommandPicker((current) => current ? moveCommandPickerSelection(current, 1) : current);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "tab" && !event.shift) {
        if (commandPicker.allowNote && !isCommandPickerCustomInputOption(commandPicker)) {
          event.preventDefault();
          event.stopPropagation();
          setCommandPicker((current) => current ? toggleCommandPickerNoteEditing(current) : current);
          return;
        }
      }
      if (event.name === "return") {
        event.preventDefault();
        event.stopPropagation();
        acceptCommandPickerSelectionLocal();
        return;
      }
      if (event.name === "escape") {
        setCommandPicker((current) => {
          if (!current) return null;
          const exited = exitCommandPickerLevel(current);
          if (!exited && commandPickerResolverRef.current) {
            const resolver = commandPickerResolverRef.current;
            commandPickerResolverRef.current = null;
            resolver(undefined);
          }
          return exited;
        });
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    const liveComposerValue = composer?.plainText ?? draftValue;
    const liveCursorOffset = composer?.cursorOffset ?? liveComposerValue.length;
    const shouldHandleInputOverlay = commandOverlay.visible && (
      commandOverlay.mode === "command"
        ? isCommandOverlayEligible(composer ? composer.getTextRange(0, liveCursorOffset) : liveComposerValue)
        : isFileOverlayEligible(liveComposerValue, liveCursorOffset)
    );
    if (commandOverlay.visible && !shouldHandleInputOverlay) {
      setCommandOverlay(EMPTY_COMMAND_OVERLAY);
    }
    if (shouldHandleInputOverlay) {
      if (event.name === "up" || (event.name === "tab" && event.shift)) {
        setCommandOverlay((current) => ({
          ...current,
          selected: (current.selected - 1 + current.items.length) % current.items.length,
        }));
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "down") {
        setCommandOverlay((current) => ({
          ...current,
          selected: (current.selected + 1) % current.items.length,
        }));
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "tab") {
        completeInputOverlaySelection();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "return") {
        acceptInputOverlaySelection();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "escape") {
        setCommandOverlay(EMPTY_COMMAND_OVERLAY);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    if (event.name === "pageup") {
      const sb = getActiveScrollBox();
      sb?.scrollBy(-(sb.height / 2));
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // Ctrl+L: dismiss transient update and MCP failure toasts.
    if (event.name === "l" && event.ctrl) {
      setMcpFailures(null);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.name === "pagedown") {
      const sb = getActiveScrollBox();
      sb?.scrollBy(sb.height / 2);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // Ctrl+V: paste image from system clipboard. Ctrl+Y is an alternate
    // because Windows Terminal (the default Win11 terminal) binds Ctrl+V
    // to its own text-paste and consumes the keypress before it reaches
    // the app, leaving image paste otherwise unreachable there; Ctrl+Y
    // is not a Windows Terminal default binding and is unused elsewhere
    // in , so it reaches this handler on every platform.
    if ((event.name === "v" || event.name === "y") && event.ctrl && !event.meta && !event.option && !event.super) {
      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        try {
          const clipResult = await readClipboardImage();
          if (!clipResult) {
            showHint(t.get(["Error", "noClipboardImage"]));
            return;
          }
          const processed = await processImage(clipResult.buffer, clipResult.mediaType);
          const idx = ++imageCounterRef.current;
          const imageId = `img-${idx}`;
          draftImagesRef.current.set(imageId, { ...processed, id: imageId, index: idx });
          const label = `[Image #${idx}]`;
          const cmp = inputRef.current;
          if (cmp) {
            suppressComposerSyncRef.current = true;
            try {
              replaceRangeWithComposerToken(cmp, {
                rangeStart: cmp.cursorOffset,
                rangeEnd: cmp.cursorOffset,
                label,
                metadata: {
                  kind: "image",
                  label,
                  submitText: label,
                  imageId,
                  index: idx,
                },
                styleId: composerTokenVisuals.imageStyleId,
                trailingText: " ",
              });
            } finally {
              suppressComposerSyncRef.current = false;
            }
            syncComposerState();
          }
          const sizeMB = (processed.sizeBytes / (1024 * 1024)).toFixed(1);
          showHint(t.get(["Views", "image", "pasted"], { width: processed.width, height: processed.height, size: sizeMB }));
        } catch (err) {
          showHint(t.get(["Error", "imagePasteFailed"], { message: err instanceof Error ? err.message : String(err) }));
        }
      })();
      return;
    }
    // Option+Left / Option+Right: switch to adjacent tab
    // Ghostty sends Esc+b / Esc+f (word movement) for Option+Left/Right
    const isOptLeft = (event.meta && event.name === "left") || (event.meta && event.name === "b");
    const isOptRight = (event.meta && event.name === "right") || (event.meta && event.name === "f");
    if (isOptLeft || isOptRight) {
      const currentIdx = tabs.findIndex((t) => t.id === activeTabId);
      if (currentIdx !== -1) {
        const nextIdx = isOptLeft
          ? (currentIdx - 1 + tabs.length) % tabs.length
          : (currentIdx + 1) % tabs.length;
        if (nextIdx !== currentIdx) {
          setActiveTabId(tabs[nextIdx].id);
        }
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // Option+Up: go to Main Session
    if (event.meta && event.name === "up") {
      setActiveTabId("main");
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // Esc / Ctrl+C on sub-pages: interrupt running agent OR close tab
    if ((event.name === "escape" || (event.name === "c" && event.ctrl)) && activeTabId !== "main") {
      // If viewing a running child agent, interrupt it first
      if (selectedChildId) {
        const snapshot = childSessions.find((s) => s.id === selectedChildId);
        if (snapshot?.lifecycle === "running" || snapshot?.lifecycle === "blocked") {
          const decision = session.interruptChildSession?.(selectedChildId) ?? { accepted: false, reason: "unsupported" };
          if (decision.accepted) {
            showHint(t.get(["Views", "interrupt", "child"], { agentId: selectedChildId }));
          }
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
      // Not a running agent (or not a child tab at all) — close tab, jump to adjacent
      const currentIdx = tabs.findIndex((t) => t.id === activeTabId);
      const currentTab = tabs[currentIdx];
      if (currentTab?.closeable) {
        const remaining = tabs.filter((t) => t.id !== activeTabId);
        const jumpIdx = Math.min(currentIdx, remaining.length - 1);
        const jumpTab = remaining[Math.max(0, jumpIdx)];
        setTabs(remaining);
        setActiveTabId(jumpTab?.id ?? "main");
        if (activeTabId.startsWith("child:")) {
          setSelectedChildId(null);
        }
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // Unified interrupt helper: deny pending ask (if any) + abort main turn.
    const performInterrupt = (): boolean => {
      if (pendingAsk) {
        const decision = session.denyAndInterruptPendingAsk?.();
        if (decision && !decision.accepted) {
          showHint(t.get(["Error", "interruptFailed"], { reason: decision.reason ?? t.get(["Common", "unknown"]) }));
          return false;
        }
        if (decision?.accepted) {
          setPendingAsk(null);
          if (decision.turnFinished) {
            // Root turn was ended by the session; go idle immediately.
            abortControllerRef.current?.abort();
            setProcessing(false);
            setPhase("idle");
          } else {
            // Only a child was killed; root turn resumes — stay in working state.
            setPhase("Working");
          }
          return true;
        }
        // Fallback: session doesn't support the combined method; deny the ask
        // and fall through so the processing interrupt path handles the abort.
        session.denyPendingAsk?.();
        setPendingAsk(null);
      }
      if (!processingRef.current && !pendingAsk) return false;
      if (session.requestTurnInterrupt) {
        session.requestTurnInterrupt();
      } else {
        session.cancelCurrentTurn?.();
      }
      abortControllerRef.current?.abort();
      return true;
    };
    // Esc / Ctrl+C on main page: close overlays → deny+abort → idle double-tap
    if ((event.name === "escape" || (event.name === "c" && event.ctrl)) && activeTabId === "main") {
      event.preventDefault();
      event.stopPropagation();
      // 1. Close overlays first
      if (commandPicker) {
        setCommandPicker(null);
        setCommandOverlay(EMPTY_COMMAND_OVERLAY);
        return;
      }
      if (commandOverlay.visible) {
        setCommandOverlay(EMPTY_COMMAND_OVERLAY);
        return;
      }
      // 2. Processing or pending ask → interrupt
      if (processingRef.current || pendingAsk) {
        if (event.name === "c" && event.ctrl) {
          const now = Date.now();
          if (now - lastCtrlCRef.current < CTRL_C_EXIT_WINDOW_MS) {
            lastCtrlCRef.current = 0;
            beginClosing();
            return;
          }
          lastCtrlCRef.current = now;
          if (performInterrupt()) {
            showHint(t.get(["Views", "exit", "pressAgain"]));
          }
          return;
        }
        performInterrupt();
        return;
      }
      // 3. Idle double-tap: Esc → /rewind, Ctrl+C → exit
      if (event.name === "escape") {
        const now = Date.now();
        if (now - lastEscRef.current < DOUBLE_ESC_WINDOW_MS) {
          lastEscRef.current = 0;
          void handleSubmit("/rewind");
          return;
        }
        lastEscRef.current = now;
        return;
      }
      // Ctrl+C idle path
      const now = Date.now();
      if (now - lastCtrlCRef.current < CTRL_C_EXIT_WINDOW_MS) {
        beginClosing();
        return;
      }
      lastCtrlCRef.current = now;
      if (lastInputValueRef.current.trim()) {
        clearInput();
        return;
      }
      showHint(t.get(["Views", "exit", "pressAgain"]));
      return;
    }
    // Tab switching: Ctrl+Left/Right to cycle, Ctrl+Up to return to Main Session
    if (event.name === "left" && event.ctrl && tabs.length > 1) {
      const idx = tabs.findIndex((t) => t.id === activeTabId);
      const prev = (idx - 1 + tabs.length) % tabs.length;
      setActiveTabId(tabs[prev].id);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.name === "right" && event.ctrl && tabs.length > 1) {
      const idx = tabs.findIndex((t) => t.id === activeTabId);
      const next = (idx + 1) % tabs.length;
      setActiveTabId(tabs[next].id);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.name === "up" && event.ctrl) {
      const mainTab = tabs.find((t) => t.kind === "main");
      if (mainTab && activeTabId !== mainTab.id) {
        setActiveTabId(mainTab.id);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    if (!composer || pendingAsk) return;
    if (isDeleteToVisualLineStartShortcut(event)) {
      deleteToVisualLineStart();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // Prompt history: ↑ at the very start, ↓ at the very end. Multi-line cursor
    // movement still wins via the gotoVisualLineHome/End branches below — they
    // run when cursor isn't yet at the absolute boundary.
    if (
      event.name === "up" &&
      composer.cursorOffset === 0 &&
      composer.plainText.length === 0 &&
      !selectedChildId &&
      queuedInputsRef.current.length > 0
    ) {
      const restored = session.restoreQueuedUserInput?.() ?? null;
      queuedInputsRef.current = projectQueuedInputs([...(session.log ?? [])]);
      if (restored !== null) {
        composer.extmarks.clear();
        composer.setText(restored);
        composer.cursorOffset = displayWidthWithNewlines(restored);
        syncComposerState();
        showHint(t.get(["Views", "queue", "restored"]));
      } else {
        showHint(t.get(["Views", "queue", "sending"]));
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // Prompt history navigation is a boundary fallback: normal visual-line
    // movement wins until the cursor is at the absolute start/end. The
    // navigator itself still preserves index/liveDraft, so edits to recalled
    // entries keep the current history position but are dropped on the next
    // history navigation.
    const applyRecall = (recalled: string, cursor: number): void => {
      composer.extmarks.clear();
      composer.setText(recalled);
      composer.cursorOffset = cursor;
      syncComposerState();
    };
    const promptHistoryDirection = event.name === "up" || event.name === "down"
      ? getPromptHistoryNavigationDirection({
        keyName: event.name,
        selectedChildId,
        cursorOffset: composer.cursorOffset,
        textDisplayWidth: event.name === "down" ? displayWidthWithNewlines(composer.plainText) : 0,
      })
      : undefined;
    if (promptHistoryDirection !== undefined) {
      const recalled = navigatePromptHistory(promptHistoryDirection, composer.plainText);
      if (recalled !== undefined) {
        const cursor = promptHistoryDirection === -1 ? 0 : displayWidthWithNewlines(recalled);
        applyRecall(recalled, cursor);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    if (event.name === "up" && isAtFirstVisualLine()) {
      composer.gotoVisualLineHome();
      syncComposerState();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.name === "up") {
      moveComposerVertically("up");
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.name === "down" && isAtLastVisualLine()) {
      composer.gotoVisualLineEnd();
      syncComposerState();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.name === "down") {
      moveComposerVertically("down");
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // The composer now lives in a fixed footer outside the scrollbox, so the
    // user can always see what they're typing. We no longer force-scroll the
    // transcript to bottom on every keystroke — that would yank them away
    // from whatever history they were reading.
    // Force composer state sync after the key is processed by the textarea.
    // onContentChange may not fire reliably for all edits (paste, delete),
    // so we explicitly re-measure at several deferred points.
    queueMicrotask(syncComposerState);
    setTimeout(syncComposerState, 0);
    setTimeout(syncComposerState, 16);
    setTimeout(syncComposerState, 50);
    setTimeout(syncComposerState, 100);
  });
  const modelDescriptor = useMemo(
    () => getCurrentModelDescriptor(session),
    [session, modelUiRevision],
  );
  const modelName = modelDescriptor?.compactScopedLabel ?? "unknown";
  const modelNameColor = resolveModelNameColor(modelDescriptor, theme);
  const childSnapshot = selectedChildId
    ? (childSessions.find((s) => s.id === selectedChildId) ?? null)
    : null;
  // 输入框右上角："供应商/模型 思考深度"。
  // 深度档位统一来自 src/config/thinking.ts（low/medium/high/xhigh/max，不提供 ultra）；
  // 非思考模型不显示深度，off 原样显示。
  // Keep the selected depth visible exactly as chosen. Capability validation
  // belongs to the provider response, not to the local model registry.
  const thinkingLevel = childSnapshot?.thinkingLevel ?? resolveInheritedThinkingLevel(session);
  const thinkingSuffix = (() => {
    if (!thinkingLevel || thinkingLevel === "none") return ""; // 非思考模型
    if (thinkingLevel === "off") return "off";                 // 显式关闭
    return thinkingLevel;                                      // low/medium/high/xhigh/max
  })();
  const enterChildSession = useCallback((agentId: string) => {
    setSelectedChildId(agentId);
    // Create temporary child tab
    const tabId = `child:${agentId}`;
    setTabs((prev) => {
      if (prev.some((t) => t.id === tabId)) return prev;
      return [...prev, { id: tabId, label: agentId, icon: "◎", closeable: true, kind: "child" as const }];
    });
    setActiveTabId(tabId);
  }, []);
  // Data source switching: use child snapshot when viewing a child page
  const effectivePhase: ActivityPhase = childSnapshot
    ? (childSnapshot.running ? "Working" : "idle")
    : phase;
  const effectiveElapsed = childSnapshot ? childSnapshot.turnElapsed : turnElapsed;
  const effectiveModelName = childSnapshot ? (childSnapshot.modelDisplayLabel || childSnapshot.modelConfigName || modelName) : modelName;
  const effectiveModelColor = childSnapshot
    ? (theme.presentation.modelProviderColors[childSnapshot.modelProvider] ?? modelNameColor)
    : modelNameColor;
  const effectiveContextTokens = childSnapshot ? childSnapshot.inputTokens : contextTokens;
  const effectiveContextLimit = childSnapshot ? childSnapshot.contextBudget : session.contextBudget;
  const statusData = useMemo<SessionStatusData>(() => {
    const taskState = session.getTaskState?.() ?? [];
    const mcpStatuses = (session as any).mcpManager?.getServerStatuses?.() ?? [];
    const skills = session.getAllSkillNames?.() ?? [];
    return {
      model: modelName,
      provider: session.primaryAgent?.modelConfig?.provider ?? "unknown",
      permission: session.permissionMode ?? "reversible",
      openTasks: taskState.filter((task: { status: string }) => task.status !== "completed").length,
      totalTasks: taskState.length,
      mcpServers: mcpStatuses.length,
      failedMcpServers: mcpStatuses.filter((status: { state?: string }) => status.state === "failed").length,
      enabledSkills: skills.filter((skill: { enabled: boolean }) => skill.enabled).length,
      totalSkills: skills.length,
      lastTokens: session.lastTotalTokens ?? 0,
      cacheReadTokens: session.lastCacheReadTokens ?? 0,
    };
  }, [modelName, session, rootLogRevision, permissionModeState]);
  const memoryLines = useMemo(() => {
    const log = Array.isArray(session.log) ? session.log : [];
    const active = log.filter((entry: { discarded?: boolean }) => !entry.discarded);
    const lines = [
      "Current-session memory/context",
      `Active log entries: ${active.length}`,
      "",
    ];
    for (const entry of active.slice(-24)) {
      const display = typeof entry.display === "string" ? entry.display.trim() : "";
      if (!display) continue;
      const firstLine = display.split("\n", 1)[0]?.trim();
      if (firstLine) lines.push(firstLine);
    }
    if (lines.length === 3) lines.push("No visible memory entries.");
    return lines;
  }, [session, rootLogRevision]);
  // Usage panel data is computed off a deferred tick so the "Calculating…"
  // frame paints before the (potentially long) log scan runs — otherwise a big
  // conversation would freeze the panel's first render.
  useEffect(() => {
    if (!usagePanel) {
      setUsageData(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      if (cancelled) return;
      const ctx = effectiveContextTokens;
      const bd = session.contextBreakdown;
      const messages = Math.max(0, ctx - session.systemPromptTokens);
      setUsageData({
        cumulativeInput: session.cumulativeInputTokens,
        cumulativeCacheRead: session.cumulativeCacheReadTokens,
        cumulativeUncached: session.cumulativeUncachedTokens,
        cumulativeOutput: session.cumulativeOutputTokens,
        contextUsed: ctx,
        contextLimit: effectiveContextLimit ?? 0,
        breakdown: { ...bd, messages },
      });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [usagePanel, session, effectiveContextTokens, effectiveContextLimit]);
  useEffect(() => {
    if (!usagePanel || usagePage !== "stats") {
      setUsageStatsData(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      if (cancelled) return;
      const stats = session.computeGlobalTokenStats?.();
      if (stats) {
        setUsageStatsData({
          cumulativeInput: stats.cumulativeInput,
          cumulativeCacheRead: stats.cumulativeCacheRead,
          cumulativeUncached: stats.cumulativeUncached,
          cumulativeOutput: stats.cumulativeOutput,
          sessionCount: stats.sessionCount,
        });
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [usagePanel, usagePage, session]);
  const effectiveCacheReadTokens = childSnapshot ? childSnapshot.cacheReadTokens : cacheReadTokens;
  const effectiveCacheSupported = childSnapshot ? false : Boolean(session.cacheSupported);
  const sessionName = (typeof session.getDisplayName === "function" ? session.getDisplayName() : "").trim()
    || uiText.get(["Views", "statusBar", "untitled"]);
  const effectiveProcessing = childSnapshot ? childSnapshot.running : processing;
  const effectiveEntries = presentationEntries;
  // One-line usage indicator shown in the input area's bottom row (left of
  // context). null when not logged in / unsupported provider / fetch pending.
  return (
    <OpenTuiScreen
      theme={theme}
      terminal={terminal}
      tabs={tabs}
      activeTabId={activeTabId}
      onSelectTab={setActiveTabId}
      onCloseTab={handleCloseTab}
      sidebarExpanded={sidebarExpanded}
      onToggleSidebar={() => setSidebarExpanded((value) => !value)}
      contextTokens={effectiveContextTokens}
      contextLimit={effectiveContextLimit}
      cacheInputTokens={selectedChildId ? (childSnapshot?.inputTokens ?? effectiveContextTokens) : cacheInputTokens}
      cacheReadTokens={effectiveCacheReadTokens}
      cacheSupported={effectiveCacheSupported}
      sessionName={sessionName}
      permissionMode={permissionModeState}
      presentationEntries={effectiveEntries}
      processing={effectiveProcessing}
      diffDisplayMode={diffDisplayMode}
      mainScrollRef={mainScrollRef}
      detailScrollRef={detailScrollRef}
      selectedChildId={selectedChildId}
      hasQueuedUserInput={queuedInputs.length > 0}
      retryStatus={selectedChildId ? null : retryStatus}
      onAgentClick={enterChildSession}
      pendingAsk={pendingAsk}
      askError={askError}
      askSelectionIndex={askSelectionIndex}
      currentQuestionIndex={currentQuestionIndex}
      questionAnswers={questionAnswers}
      customInputMode={customInputMode}
      noteInputMode={noteInputMode}
      reviewMode={reviewMode}
      askInputValue={askInputValue}
      optionNotes={optionNotes}
      askInputRef={askInputRef}
      onAskInput={setAskInputValue}
      onAskSubmit={submitAskInlineInput}
      getAskQuestions={getAskQuestions}
      commandOverlay={commandOverlay}
      commandPicker={commandPicker}
      pickerNoteInputRef={pickerNoteInputRef}
      pickerNoteValue={pickerNoteValue}
      onPickerNoteInput={(value: string) => {
        setPickerNoteValue(value);
        setCommandPicker((current) => current ? setCommandPickerNote(current, value) : current);
      }}
      promptSelect={promptSelect}
      promptSecret={promptSecret}
      promptSecretInputRef={promptSecretInputRef}
      oauthOverlay={oauthOverlay}
      helpPanel={helpPanel}
      onOverlayItemClick={clickOverlayItem}
      onCommandPickerItemClick={clickCommandPickerItem}
      onPromptSelectItemClick={clickPromptSelectItem}
      onPromptSecretSubmit={submitPromptSecret}
      inputRef={inputRef}
      phase={effectivePhase}
      modelName={effectiveModelName}
      thinkingSuffix={thinkingSuffix}
      uiText={uiText}
      modelColor={effectiveModelColor}
      turnElapsed={effectiveElapsed}
      lastWorkedElapsed={childSnapshot
        ? childSnapshot.turnElapsed
        : lastWorkedStatus
          ? lastWorkedStatus.elapsed
          : turnTimer.lastElapsed}
      lastWorkedStartedAt={childSnapshot
        ? null
        : lastWorkedStatus
          ? lastWorkedStatus.startedAt
          : turnTimer.lastStartedAt}
      hint={hint}
      composerTokenVisuals={composerTokenVisuals}
      keyBindings={COMPOSER_KEY_BINDINGS}
      onSubmit={() => {
        if (selectedChildId) {
          showHint(t.get(["Error", "backToPrimary"]));
          return;
        }
        void handleSubmit(getSerializedComposerInput());
      }}
      onModelClick={() => {
        if (selectedChildId) {
          showHint(t.get(["Error", "subAgentModelFixed"]));
          return;
        }
        void handleSubmit("/model");
      }}
      sidebarMode={sidebarMode}
      statusPanel={(() => {
        const visibleAgents = childSessions.filter((agent) =>
          !dismissedAgentIds.has(agent.id) || !isSettledAgentSnapshot(agent));
        const showAgents = visibleAgents.length > 0;
        const showTasks = tasks.length > 0;
        if (!showAgents && !showTasks) return undefined;
        return (
          <StatusPanel
            agents={visibleAgents}
            showAgents={showAgents}
            tasks={tasks}
            showTasks={showTasks}
            taskPersistence={session.getTaskPersistence?.() ?? "file"}
            colors={theme.colors}
            terminalHeight={terminal.height}
            onAgentClick={enterChildSession}
          />
        );
      })()}
      pendingMessages={queuedInputs.length > 0 || queuedCommand ? (
        <box flexDirection="column" gap={0}>
          {queuedInputs.map((queued) => (
            <box key={queued.id} flexDirection="row">
              <box width={1} backgroundColor={theme.colors.accent} />
              <box paddingLeft={1} paddingRight={1} flexGrow={1} backgroundColor={theme.colors.userWash}>
                <text fg={theme.colors.dim} content={queued.text} wrapMode="word" width="100%" />
              </box>
            </box>
          ))}
          {queuedCommand ? (
            <box flexDirection="row">
              <box width={1} backgroundColor={theme.colors.accent} />
              <box paddingLeft={1} paddingRight={1} flexGrow={1} backgroundColor={theme.colors.userWash}>
                <text fg={theme.colors.dim} content={queuedCommand.text} wrapMode="word" width="100%" />
              </box>
            </box>
          ) : null}
        </box>
      ) : undefined}
      shellRunningCount={shellSnapshots.filter((s) => s.status === "running").length}
      onShellsClick={openShellsPicker}
      activeShells={shellSnapshots.map(({ id, command, status }) => ({ id, command, status }))}
      activeShellDetail={activeShellDetail}
      onStopShell={stopShellFromUi}
      sidebarPlanSection={undefined}
      sidebarContextSection={
        <ContextUsageCard
          contextTokens={effectiveContextTokens}
          contextLimit={effectiveContextLimit}
          cacheReadTokens={cacheReadTokens}
          theme={theme}
        />
      }
      sidebarCodexSection={usageSnapshot ? <CodexUsageCard snapshot={usageSnapshot} theme={theme} /> : undefined}
      mcpFailures={mcpFailures}
      usagePanel={usagePanel}
      usageData={usageData}
      onUsageDismiss={() => setUsagePanel(false)}
      usagePage={usagePage}
      usageStatsData={usageStatsData}
      statusPanelOverlay={statusPanel}
      statusData={statusData}
      onStatusDismiss={() => setStatusPanel(false)}
      memoryPanel={memoryPanel}
      memoryLines={memoryLines}
      onMemoryDismiss={() => setMemoryPanel(false)}
      onBackgroundMouseDown={() => {
        if (commandOverlay.visible) setCommandOverlay(EMPTY_COMMAND_OVERLAY);
        if (commandPicker) setCommandPicker(null);
      }}
    />
  );
}
