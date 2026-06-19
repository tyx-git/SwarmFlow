/** @jsxImportSource @opentui/react */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { clipboard } from "../../src/platform/index.js";

import type {
  CommandRegistry,
  CommandContext,
  CommandOption,
  Session as TuiSession,
} from "../../src/ui/contracts.js";
import type { SessionStore } from "../../src/config/persistence.js";
import type { ChildSessionSnapshot } from "../../src/session-tree-types.js";
import { saveGlobalSettingsPatch, saveLog } from "../../src/config/persistence.js";
import { projectQueuedInputs } from "../../src/context/log-projection.js";
import { isCommandExitSignal } from "../../src/commands/commands.js";
import { ProgressReporter, type ProgressEvent } from "../../src/lib/progress.js";
import { scanCandidates } from "../../src/lib/file-attach.js";
import { classifyPastedText, TurnPasteCounter } from "../../src/ui/input/paste.js";
import { readClipboardImage } from "../../src/lib/clipboard-image.js";
import { processImage, type ProcessedImage } from "../../src/lib/image-compress.js";
import { getUpdateState, triggerRelaunch } from "../../src/lifecycle/update-check.js";
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
  type CommandPickerResult,
  type CommandPickerState,
} from "../../src/ui/command-picker.js";
import {
  createCheckboxPicker,
  isCheckboxPickerActive,
  moveCheckboxSelection,
  setCheckboxPickerSelection,
  submitCheckboxPicker,
  toggleCheckboxItem,
  type CheckboxPickerState,
} from "../../src/ui/checkbox-picker.js";
import {
  type InputRenderable,
  type KeyBinding,
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import "./forked/patch-opentui-markdown.js";
import { applyMarkdownTheme } from "./forked/patch-opentui-markdown.js";
import {
  getFermiAssistantRenderer,
  isFermiMarkdownPatchDisabled,
  isFermiOpenTuiDiagEnabled,
  writeFermiOpenTuiDiag,
} from "./forked/core/lib/diagnostic.js";
import { usePresentationEntries } from "./presentation/use-presentation.js";
import { useTurnTimer } from "./presentation/use-turn-timer.js";
import type { TabState } from "./sidebar/sidebar-tabs.js";
import { getCurrentModelDescriptor } from "../../src/models/presentation.js";
import {
  UsagePoller,
  formatUsageLine,
  type UsageSnapshot,
} from "../../src/providers/usage.js";
import {
  readOAuthAccessToken,
  hasOAuthTokens,
  isTokenExpiring,
  saveOAuthTokens,
  browserLoginHeadless,
  deviceCodeLoginHeadless,
  type OAuthProgress,
  type OAuthTokens,
} from "../../src/auth/openai-oauth.js";
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
import { ContextUsageCard, CodexUsageCard } from "./display/panels/usage-cards.js";
import { StatusPanel } from "./display/panels/status-panel.js";
import { usePlan } from "./presentation/use-plan.js";
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
import { clamp, computePickerMaxVisible } from "./display/layout/metrics.js";
import { OpenTuiScreen } from "./display/layout/open-tui-screen.js";
import { resolveModelNameColor } from "./display/utils/model.js";
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
  /** Whether copy-on-select (auto-copy a drag selection) is enabled. Default: true. */
  copyOnSelect: boolean;
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

const ASSISTANT_RENDERER_MODE = getFermiAssistantRenderer();

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
  copyOnSelect: initialCopyOnSelect,
}: OpenTuiAppProps): React.ReactNode {
  const renderer = useRenderer();
  const terminal = useTerminalDimensions();
  const [themeMode, setThemeMode] = useState<ThemeMode>(initialThemeMode);
  const [themeModePref, setThemeModePref] = useState<"auto" | ThemeMode>(initialThemeModePref);
  const [terminalFg, setTerminalFg] = useState<string | null>(initialTerminalFg);
  const [diffDisplayMode, setDiffDisplayMode] = useState<"compact" | "full">(initialDiffDisplay);
  const [copyOnSelect, setCopyOnSelect] = useState<boolean>(initialCopyOnSelect);
  const theme = useMemo<DisplayTheme>(() => {
    // Only apply the terminal-fg override in auto mode. When the user pins a
    // mode (FERMI_THEME=dark|light or /theme), assume they want the canonical
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
      if (mode === "light" || mode === "dark") setThemeMode(mode);
      // Re-query the terminal palette on every mode flip — the new theme
      // almost certainly changed foreground too. The renderer caches the
      // palette across calls (see Renderer.getPalette), so invalidate the
      // cache first or we get back the old terminal's foreground and the
      // body text stays the previous mode's colour.
      renderer.clearPaletteCache();
      renderer.getPalette({ timeout: 250 })
        .then((p) => setTerminalFg(p?.defaultForeground ?? null))
        .catch(() => {});
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
  const [contextTokens, setContextTokens] = useState(0);
  const [cacheReadTokens, setCacheReadTokens] = useState(0);
  const updateContextTokenState = useCallback((inputTokens: number | undefined, cacheTokens?: number) => {
    if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens) || inputTokens <= 0) return;
    setContextTokens(inputTokens);
    setCacheReadTokens(cacheTokens ?? 0);
  }, []);
  // Usage snapshot for Codex or Copilot — only one is active at a time, based
  // on the current model provider. Hidden for all other providers.
  const [usageSnapshot, setUsageSnapshot] = useState<UsageSnapshot | null>(null);
  const usagePollerRef = useRef<UsagePoller | null>(null);
  const usagePollerProviderRef = useRef<string | null>(null);
  const [childSessions, setChildSessions] = useState<ChildSessionSnapshot[]>([]);
  const [shellSnapshots, setShellSnapshots] = useState<ShellSnapshotUi[]>([]);
  const [activeShellDetail, setActiveShellDetail] = useState<ShellDetailUi | null>(null);
  const [selectedChildId, setSelectedChildId] = useState<string | null>(null);
  const presentationEntries = usePresentationEntries({ session, selectedChildId, childSessions, processing });
  const turnElapsed = useTurnTimer(phase);
  const planCheckpoints = usePlan(session);
  const [agentsPanelOpen, setAgentsPanelOpen] = useState(false);
  const [todoPanelOpen, setTodoPanelOpen] = useState(false);
  const [rootLogRevision, setRootLogRevision] = useState(session.getLogRevision?.() ?? 0);
  const queuedInputs = useMemo(() => {
    if (selectedChildId !== null) return [];
    return projectQueuedInputs([...(session.log ?? [])]);
  }, [rootLogRevision, selectedChildId, session]);
  const queuedInputsRef = useRef(queuedInputs);
  useEffect(() => {
    queuedInputsRef.current = queuedInputs;
  }, [queuedInputs]);

  // Auto-open panels on first appearance (once per session)
  const hasAutoOpenedAgents = useRef(false);
  const hasAutoOpenedTodos = useRef(false);
  useEffect(() => {
    if (childSessions.length > 0 && !hasAutoOpenedAgents.current) {
      hasAutoOpenedAgents.current = true;
      setAgentsPanelOpen(true);
    }
  }, [childSessions.length]);
  useEffect(() => {
    if (planCheckpoints.length > 0 && !hasAutoOpenedTodos.current) {
      hasAutoOpenedTodos.current = true;
      setTodoPanelOpen(true);
    }
  }, [planCheckpoints.length]);

  // Frozen child view — protects display when viewed child becomes archived
  const [frozenChildView, setFrozenChildView] = useState<{
    snapshot: ChildSessionSnapshot;
    entries: readonly import("./presentation/types.js").PresentationEntry[];
  } | null>(null);

  // Tab state for sidebar
  const [tabs, setTabs] = useState<TabState[]>([
    { id: "main", label: "Main Session", icon: "●", closeable: false, kind: "main" },
  ]);
  const [activeTabId, setActiveTabId] = useState("main");
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [sidebarMode, setSidebarMode] = useState<"open" | "close" | "auto">("close");

  // Sync child session tabs — child tabs are now temporary (created on enter, removed on exit).
  // Only clean up tabs for children that no longer exist and aren't frozen.
  useEffect(() => {
    setTabs((prev) => {
      const currentChildIds = new Set(childSessions.map((s) => s.id));
      return prev.filter((t) => {
        if (t.kind !== "child") return true;
        // Extract child id from tab id (format: "child:{agentId}")
        const childId = t.id.startsWith("child:") ? t.id.slice(6) : t.id;
        // Keep if child still active, or if user is viewing it (frozen view handles archived)
        return currentChildIds.has(childId) || (selectedChildId === childId) || (frozenChildView !== null && selectedChildId === childId);
      });
    });
  }, [childSessions, selectedChildId, frozenChildView]);

  // Derive selectedChildId from active tab
  // Tab id format is "child:{agentId}" — strip prefix to get the raw session id
  useEffect(() => {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (activeTab?.kind === "child") {
      const childId = activeTab.id.startsWith("child:") ? activeTab.id.slice(6) : activeTab.id;
      setSelectedChildId(childId);
    } else if (activeTab?.kind === "detail-tool") {
      const src = activeTab.sourceSessionKey;
      setSelectedChildId(src?.startsWith("child:") ? src.slice(6) : null);
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
    const isDetail = activeTab?.kind === "detail-tool" || activeTab?.kind === "detail-shell";
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

  const openDetailTab = useCallback((entry: import("./presentation/types.js").PresentationEntry) => {
    // Thinking entries expand/collapse inline — no detail tab needed.
    if (entry.kind === "thinking") return;

    // bash_background / timed-out bash entries route to the live shell tab
    // when the shell is still tracked by the MAIN session (child sessions
    // have their own shell managers — ids would collide).
    if (!selectedChildId) {
      const resultText = entry.toolResultFullText ?? "";
      const match = resultText.match(/background shell '([^']+)'/);
      if (match && session.getBackgroundShellDetail?.(match[1], { maxChars: 500 })) {
        const snapshot = (session.getBackgroundShellSnapshots?.() ?? []).find((s: ShellSnapshotUi) => s.id === match[1]);
        openShellDetailTab(match[1], snapshot?.command);
        return;
      }
    }
    const tabId = `detail:${entry.id}`;
    const sourceKey = selectedChildId ? `child:${selectedChildId}` : "main";
    setTabs((prev) => {
      if (prev.some((t) => t.id === tabId)) return prev;
      const kind = "detail-tool" as const;
      const label = `${entry.toolDisplayName ?? "Tool"} ${entry.toolText ?? ""}`.trim();
      return [...prev, {
        id: tabId,
        label,
        icon: "◇",
        closeable: true,
        kind,
        sourceSessionKey: sourceKey,
        detailEntryId: entry.id,
      }];
    });
    setActiveTabId(tabId);
  }, [selectedChildId, session, openShellDetailTab]);

  const [hint, setHint] = useState<string | null>(null);
  const [updateToast, setUpdateToast] = useState<{ phase: import("./display/overlays/update-toast.js").UpdateToastPhase; version?: string; error?: string } | null>(null);
  const [mcpFailures, setMcpFailures] = useState<import("./display/overlays/mcp-toast.js").McpFailure[] | null>(null);
  // Transient copy-on-select toast: a body string while visible, null when hidden.
  const [copyToast, setCopyToast] = useState<string | null>(null);
  const copyToastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [usagePanel, setUsagePanel] = useState(false);
  const [usageData, setUsageData] = useState<import("./display/overlays/usage-panel.js").UsageData | null>(null);
  const [statPanel, setStatPanel] = useState(false);
  const [statData, setStatData] = useState<import("./display/overlays/stat-panel.js").StatData | null>(null);
  const [markdownMode, setMarkdownMode] = useState<"rendered" | "raw">("rendered");
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
  const [checkboxPicker, setCheckboxPicker] = useState<CheckboxPickerState | null>(null);
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
  const markdownStyle = theme.markdownStyle;
  if (!composerTokenVisualsRef.current || composerTokenColorsRef.current !== colors) {
    composerTokenColorsRef.current = colors;
    composerTokenVisualsRef.current = createComposerTokenVisuals(colors);
  }
  const composerTokenVisuals = composerTokenVisualsRef.current;

  // Bind markdown render colors (codeBorder/codeFg/HLJS) to the live theme so
  // mode switches reflect immediately on the next markdown render.
  useEffect(() => {
    applyMarkdownTheme(theme);
  }, [theme]);

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
      updateContextTokenState(session.lastTotalTokens, session.lastCacheReadTokens ?? 0);
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
      const suspended = Boolean(session.getPendingAsk?.());
      if (suspended) {
        setPhase("Asking");
      } else {
        setProcessing(false);
        setPhase("idle");
      }
    }
  }, [autoSave, session]);

  const cyclePermissionMode = useCallback(() => {
    const modes = ["read_only", "reversible", "yolo"] as const;
    const current = session.permissionMode ?? "reversible";
    const idx = modes.indexOf(current as any);
    const next = modes[(idx + 1) % modes.length];
    session.permissionMode = next;
    setPermissionModeState(next);
    try {
      saveGlobalSettingsPatch({ permission_mode: next });
    } catch { /* ignore */ }
    autoSave();
  }, [autoSave, session]);

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
      setChildSessions((previous) => sameChildSessionList(previous, nextChildSessions) ? previous : nextChildSessions);
      const nextShells = (session.getBackgroundShellSnapshots?.() ?? []) as ShellSnapshotUi[];
      setShellSnapshots((previous) => sameShellSnapshotList(previous, nextShells) ? previous : nextShells);
      // Archived children stay in _childSessions (Session instance alive), so they always
      // appear in snapshots. No need for frozenChildView protection here.
      setPendingAsk(session.getPendingAsk?.() ?? null);
      setPermissionModeState(session.permissionMode ?? "reversible");
      setRootLogRevision(session.getLogRevision?.() ?? 0);
      updateContextTokenState(session.lastTotalTokens, session.lastCacheReadTokens ?? 0);
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
    if (!isFermiOpenTuiDiagEnabled()) return;
    const assistantPEs = presentationEntries.filter((pe) => pe.kind === "assistant");
    const lastAssistant = assistantPEs.length > 0 ? assistantPEs[assistantPEs.length - 1] : null;
    writeFermiOpenTuiDiag("app.entries", {
      totalEntries: presentationEntries.length,
      assistantEntries: assistantPEs.length,
      lastAssistantLength: lastAssistant?.assistantText?.length ?? 0,
      processing,
      markdownMode,
      assistantRenderer: ASSISTANT_RENDERER_MODE,
      markdownPatchDisabled: isFermiMarkdownPatchDisabled(),
      activeAgents: childSessions.length,
    });
  }, [childSessions.length, presentationEntries, markdownMode, processing]);

  const handleProgressRef = useRef<(event: ProgressEvent) => void>(() => { });
  handleProgressRef.current = (event) => {
    if (closingRef.current) return;
    switch (event.action) {
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
        updateContextTokenState(session.lastTotalTokens, session.lastCacheReadTokens ?? 0);
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
    setCheckboxPicker(null);
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

  // Show the copy-on-select toast and auto-dismiss it after ~2s. A fresh flash
  // resets the timer (clearTimeout) so only the latest one survives.
  const flashCopyToast = useCallback((message = "Copied to clipboard") => {
    setCopyToast(message);
    if (copyToastTimerRef.current) clearTimeout(copyToastTimerRef.current);
    copyToastTimerRef.current = setTimeout(() => {
      setCopyToast(null);
      copyToastTimerRef.current = undefined;
    }, 2000);
  }, []);

  useEffect(
    () => () => {
      if (copyToastTimerRef.current) clearTimeout(copyToastTimerRef.current);
    },
    [],
  );

  // Copy-on-select: when a drag selection finishes (renderer "selection" event),
  // auto-copy the text and flash a toast. The highlight is intentionally NOT
  // cleared so the user keeps their visual selection. Toggled via /autocopy.
  useEffect(() => {
    if (!copyOnSelect) return;
    const onSelection = (selection: { getSelectedText?: () => string } | null) => {
      const text = selection?.getSelectedText?.() ?? "";
      if (!text) return;
      void copyToClipboard(text, (t) => renderer.copyToClipboardOSC52(t)).then((ok) => {
        if (ok) flashCopyToast();
        else showHint("Copy failed.");
      });
    };
    renderer.on("selection", onSelection);
    return () => {
      renderer.off("selection", onSelection);
    };
  }, [copyOnSelect, renderer, flashCopyToast, showHint]);

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
      showHint("No background shells tracked.");
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
    setCheckboxPicker(null);
    setPromptSelect({
      message: "Background shells",
      options,
      selected: 0,
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
        showHint("Shell: PowerShell 7+ (install Git for Windows for better compatibility)", 8000);
      } else if (shell.kind === "powershell") {
        showHint("Shell: Windows PowerShell 5.1 (install Git for Windows for better compatibility)", 8000);
      }
    } catch { /* not on Windows or import unavailable */ }
  }, [showHint]);

  // Poll for background update state and show toast when actionable.
  useEffect(() => {
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      const state = getUpdateState();
      switch (state.phase) {
        case "downloading":
          setUpdateToast({ phase: "downloading", version: state.latestVersion! });
          break;
        case "staged":
          setUpdateToast({ phase: "staged", version: state.latestVersion! });
          stopped = true;
          clearInterval(poll);
          break;
        case "available":
          setUpdateToast({ phase: "available", version: state.latestVersion! });
          stopped = true;
          clearInterval(poll);
          break;
        case "failed":
          // Surface the failure instead of leaving a stale "Downloading..."
          // toast frozen on screen (the bug that masked a hung download).
          setUpdateToast({ phase: "failed", version: state.latestVersion, error: state.error });
          stopped = true;
          clearInterval(poll);
          break;
        case "disabled":
          setUpdateToast(null);
          stopped = true;
          clearInterval(poll);
          break;
      }
    };
    const poll = setInterval(tick, 2000);
    return () => { stopped = true; clearInterval(poll); };
  }, []);

  const performExit = useCallback(async () => {
    autoSave();
    const msg = GOODBYE_MESSAGES[Math.floor(Math.random() * GOODBYE_MESSAGES.length)]!;
    await onExit(msg);
  }, [autoSave, onExit]);

  const beginClosing = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setProcessing(false);
    setPhase("closing");
    setHint(null);
    setCommandOverlay(EMPTY_COMMAND_OVERLAY);
    setCommandPicker(null);
    setCheckboxPicker(null);
    if (closingTimerRef.current) {
      clearTimeout(closingTimerRef.current);
    }
    void performExit();
  }, [performExit]);

  const buildCommandOptions = useCallback((cmdName: string) => {
    const command = commandRegistry.lookup(cmdName);
    if (!command?.options) return [];
    return command.options({
      session,
      store: store ?? undefined,
    });
  }, [commandRegistry, session, store]);

  const pickerMaxVisible = computePickerMaxVisible(terminal.height, theme.layout);

  const startCommandPicker = useCallback((cmdName: string): boolean => {
    const command = commandRegistry.lookup(cmdName);
    const options = buildCommandOptions(cmdName);
    if (options.length === 0) return false;
    const canonicalCommandName = command?.name ?? cmdName;

    setCommandOverlay(EMPTY_COMMAND_OVERLAY);

    if (command?.checkboxMode) {
      setCheckboxPicker(
        createCheckboxPicker(
          canonicalCommandName,
          options.map((option) => ({
            label: option.label,
            value: option.value,
            checked: option.checked !== false,
          })),
          Math.min(pickerMaxVisible, options.length),
        ),
      );
      return true;
    }

    setCommandPicker(
      createCommandPicker(
        canonicalCommandName,
        options,
        pickerMaxVisible,
        command?.pickerTitle,
      ),
    );
    return true;
  }, [buildCommandOptions, commandRegistry, pickerMaxVisible]);

  const updateInputOverlay = useCallback((value: string, cursorOffset: number) => {
    if (commandPicker || checkboxPicker || promptSelect || promptSecret) return;

    const livePrefix = inputRef.current ? inputRef.current.getTextRange(0, cursorOffset) : value;

    if (isCommandOverlayEligible(livePrefix)) {
      const prefix = livePrefix.slice(1);
      const matches = commandRegistry.getAll().filter((command) =>
        command.name.slice(1).startsWith(prefix)
        || command.aliases?.some((alias) => alias.slice(1).startsWith(prefix)),
      );

      if (matches.length > 0) {
        setCommandOverlay((current) => ({
          mode: "command",
          visible: true,
          items: matches.map((command) => {
            const matchedAlias = !command.name.slice(1).startsWith(prefix)
              ? command.aliases?.find((a) => a.slice(1).startsWith(prefix))
              : null;
            const aliasHint = matchedAlias ? ` (${matchedAlias})` : "";
            return `${command.name.padEnd(20)}${command.description}${aliasHint}`;
          }),
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
  }, [checkboxPicker, commandPicker, commandRegistry, promptSecret, promptSelect]);
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

    if (!pendingAsk && !commandPicker && !checkboxPicker && !promptSelect) {
      focusComposerSoon();
    }
  }, [
    checkboxPicker,
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
      commandRegistry,
      autoSave,
      showMessage: (message: string) => {
        // Intercept magic messages from /raw and /agents commands
        if (message === "__toggle_markdown_raw__") {
          setMarkdownMode((current) => {
            const next = current === "rendered" ? "raw" : "rendered";
            showHint(next === "raw" ? "Markdown raw: ON" : "Markdown raw: OFF");
            return next;
          });
          return;
        }
        if (message === "__open_agent_list__") {
          setAgentsPanelOpen((p) => !p);
          return;
        }
        if (message === "__toggle_todo_panel__") {
          setTodoPanelOpen((p) => !p);
          return;
        }
        if (message.startsWith("__sidebar_mode__:")) {
          const mode = message.slice(17) as "open" | "close" | "auto";
          setSidebarMode(mode);
          showHint(`Sidebar: ${mode}`);
          return;
        }
        if (message.startsWith("__theme_mode__:")) {
          const value = message.slice("__theme_mode__:".length) as "auto" | ThemeMode;
          setThemeModePref(value);
          if (value === "light" || value === "dark") {
            setThemeMode(value);
          } else if (value === "auto") {
            // Snap to whatever the renderer already knows; the live-follow
            // effect below will pick up future changes.
            const oscMode = renderer.themeMode;
            if (oscMode === "light" || oscMode === "dark") setThemeMode(oscMode);
          }
          return;
        }
        if (message.startsWith("__diff_display__:")) {
          const value = message.slice("__diff_display__:".length);
          setDiffDisplayMode(value === "full" ? "full" : "compact");
          return;
        }
        if (message.startsWith("__copy_on_select__:")) {
          const value = message.slice("__copy_on_select__:".length);
          setCopyOnSelect(value === "on");
          return;
        }
        if (message === "__help_panel__") {
          setHelpPanel((current) => !current);
          return;
        }
        if (message === "__usage_panel__") {
          setUsagePanel((current) => !current);
          return;
        }
        if (message === "__stat_panel__") {
          setStatPanel((current) => !current);
          return;
        }
        if (message === "__sidebar_toggle__") {
          setSidebarMode((current) => {
            const next = current === "auto" ? "open" : current === "open" ? "close" : "auto";
            showHint(`Sidebar: ${next}`);
            return next;
          });
          return;
        }
        session.appendStatusMessage?.(message);
      },
      resetUiState: () => {
        setProcessing(false);
        setPhase("idle");
        updateContextTokenState(session.lastTotalTokens, session.lastCacheReadTokens ?? 0);
        setPendingAsk(null);
        setAskError(null);
      },
      requestFullRepaint: () => {
        renderer?.requestFullRepaint?.();
      },
      restartRuntimeForNewSession: onNewSession,
      exit: performExit,
      onTurnRequested: (content: string) => {
        void handleSubmit(content);
      },
      onInjectedTurnRequested: (displayText: string, content: string) => {
        void runInjectedCommand(displayText, content);
      },
      onManualSummarizeRequested: (opts: { targetContextIds?: string[]; focusPrompt?: string }) => {
        void runManualSummarize(opts);
      },
      onManualCompactRequested: (instruction: string) => {
        void runManualCompact(instruction);
      },
      onShellsRequested: () => {
        openShellsPicker();
      },
      showHint,
      copyToClipboard: (text: string) => copyToClipboard(text, (t) => renderer.copyToClipboardOSC52(t)),
      isProcessing: () => processingRef.current,
      promptSecret: async (request: PromptSecretRequest) => {
        resolvePromptSecret(undefined);
        resolvePromptSelect(undefined);
        return await new Promise<string | undefined>((resolve) => {
          promptSecretResolverRef.current = resolve;
          setCommandOverlay(EMPTY_COMMAND_OVERLAY);
          setCommandPicker(null);
          setCheckboxPicker(null);
          setPromptSecret({
            message: request.message,
            allowEmpty: request.allowEmpty ?? false,
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
          setCheckboxPicker(null);
          setPromptSelect({
            message: request.message,
            options: request.options,
            selected: 0,
          });
        });
      },
      promptCommandPicker: async (options: CommandOption[], config?: { title?: string; allowNote?: boolean }) => {
        resolvePromptSelect(undefined);
        resolvePromptSecret(undefined);
        return await new Promise<CommandPickerResult | undefined>((resolve) => {
          commandPickerResolverRef.current = resolve;
          setCommandOverlay(EMPTY_COMMAND_OVERLAY);
          setPromptSelect(null);
          setCheckboxPicker(null);
          setPickerNoteValue("");
          setCommandPicker(
            createCommandPicker("", options, pickerMaxVisible, config?.title, config?.allowNote),
          );
        });
      },
      requestOAuthLogin,
    };
  }, [session, store, commandRegistry, autoSave, performExit, onNewSession, resolvePromptSecret, resolvePromptSelect, requestOAuthLogin, pickerMaxVisible, updateContextTokenState]);

  const runTurn = useCallback(async (input: string, inlineImages?: InlineImageInput[]) => {
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setProcessing(true);
    setPhase("Working");
    try {
      await session.turn(input, { signal: controller.signal, inlineImages });
      updateContextTokenState(session.lastTotalTokens, session.lastCacheReadTokens ?? 0);
      setPendingAsk(session.getPendingAsk?.() ?? null);
      autoSave();
    } catch {
      // The error log entry is written by the runtime (Session.turn); nothing
      // to add at the UI layer.
    } finally {
      abortControllerRef.current = null;
      const suspended = Boolean(session.getPendingAsk?.());
      if (suspended) {
        setPhase("Asking");
      } else {
        setProcessing(false);
        setPhase("idle");
      }
    }
  }, [session, autoSave, updateContextTokenState]);

  const runManualSummarize = useCallback(async (opts: { targetContextIds?: string[]; focusPrompt?: string }) => {
    if (typeof session.runManualSummarize !== "function") {
      session.appendStatusMessage?.("/summarize is not available in this session.");
      return;
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setProcessing(true);
    setPhase("Working");
    try {
      await session.runManualSummarize({
        signal: controller.signal,
        targetContextIds: opts.targetContextIds,
        focusPrompt: opts.focusPrompt,
      });
      autoSave();
    } catch {
      // Error log entry written by the runtime (runManualSummarize).
    } finally {
      abortControllerRef.current = null;
      setProcessing(false);
      setPhase("idle");
    }
  }, [session, autoSave]);

  const runManualCompact = useCallback(async (instruction: string) => {
    if (typeof session.runManualCompact !== "function") {
      session.appendStatusMessage?.("/compact is not available in this session.");
      return;
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setProcessing(true);
    setPhase("Working");
    try {
      await session.runManualCompact(instruction, { signal: controller.signal });
      autoSave();
    } catch {
      // Error log entry written by the runtime (runManualCompact).
    } finally {
      abortControllerRef.current = null;
      setProcessing(false);
      setPhase("idle");
    }
  }, [session, autoSave]);

  const getSerializedComposerInput = useCallback((): string => {
    const composer = inputRef.current;
    if (!composer) return draftValue;
    return serializeComposerText(composer, ensureComposerTokenType(composer));
  }, [draftValue]);

  // Commands that run regardless of streaming state. /copy is here so its
  // "wait until the agent finishes" hint actually fires (otherwise the
  // default path would queue "/copy" as a user message to the LLM).
  const UI_ONLY_COMMANDS = new Set(["/agents", "/raw", "/sidebar", "/copy", "/new"]);
  // Commands that mutate session runtime config (skills / MCP). They run as
  // ordinary commands when idle — the Session serializes the actual reload
  // against turns via its turn lock, so they need no UI "Working" state. While
  // a turn is processing we only intercept them with a hint so they are not
  // queued to the LLM as a user message.
  const SESSION_CONFIG_COMMANDS = new Set(["/mcp", "/skills"]);

  const handleSubmit = useCallback(async (submittedValue: string) => {
    const input = submittedValue.trim();
    if (!input) return;

    const cmdToken = input.startsWith("/") ? input.split(/\s/)[0] : "";
    const isUiOnlyCommand = Boolean(cmdToken && UI_ONLY_COMMANDS.has(cmdToken));
    const isSessionConfigCommand = Boolean(cmdToken && SESSION_CONFIG_COMMANDS.has(cmdToken));

    // UI-only commands: always intercept, even when processing
    if (isUiOnlyCommand) {
      appendPromptHistory(input);
      clearInput();
      const command = commandRegistry.lookup(cmdToken);
      if (command) {
        const args = input.slice(cmdToken.length).trim();
        try {
          await command.handler(buildCommandContext(), args);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          session.appendErrorMessage?.(`Command failed (${cmdToken}): ${message}`, "command");
        }
      }
      return;
    }

    if (pendingAsk) {
      if (pendingAsk.kind === "approval") {
        resolveApproval(askSelectionIndex);
      } else {
        showHint("Ask resolution is not implemented in this prototype yet.");
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
      if (isSessionConfigCommand) {
        showHint("Wait until the assistant finishes.");
        return;
      }
      if (queuedInputsRef.current.length > 0) {
        showHint("A message is already queued");
        return;
      }
      if (typeof session.deliverMessage === "function") {
        const decision = session.deliverMessage("user", input);
        queuedInputsRef.current = projectQueuedInputs([...(session.log ?? [])]);
        if (decision && decision.accepted === false) {
          showHint(decision.reason === "compact_in_progress"
            ? "Compacting context — try again in a moment"
            : "A message is already queued");
          return;
        }
        appendPromptHistory(input);
        clearInput();
        showHint("Message queued");
      } else {
        showHint("The assistant is busy and this prototype cannot queue input here.");
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
        session.appendErrorMessage?.(`Unknown command: ${cmdName}`, "command");
        return;
      }
      try {
        await command.handler(buildCommandContext(), args);
      } catch (err) {
        if (isCommandExitSignal(err)) {
          await performExit();
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        session.appendErrorMessage?.(`Command failed (${cmdName}): ${message}`, "command");
      }
      return;
    }

    await runTurn(input, inlineImages);
  }, [
    askSelectionIndex,
    clearInput,
    pendingAsk,
    processing,
    resolveApproval,
    session,
    commandRegistry,
    startCommandPicker,
    buildCommandContext,
    performExit,
    runTurn,
    showHint,
  ]);

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
      updateContextTokenState(session.lastTotalTokens, session.lastCacheReadTokens ?? 0);
      setPendingAsk(session.getPendingAsk?.() ?? null);
      autoSave();
    } catch {
      // Error log entry written by the runtime (runInjectedCommand).
    } finally {
      abortControllerRef.current = null;
      const suspended = Boolean(session.getPendingAsk?.());
      if (suspended) {
        setPhase("Asking");
      } else {
        setProcessing(false);
        setPhase("idle");
      }
    }
  }, [session, autoSave, handleSubmit, updateContextTokenState]);

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

  const acceptCommandPickerSelectionLocal = useCallback(() => {
    if (!commandPicker) return;
    const result = acceptCommandPickerSelection(commandPicker);
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
  }, [commandPicker, handleSubmit]);

  const clickCommandPickerItem = useCallback((index: number) => {
    if (!commandPicker) return;
    const withSelection = setCommandPickerSelection(commandPicker, index);
    const result = acceptCommandPickerSelection(withSelection);
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
  }, [commandPicker, handleSubmit]);

  const clickCheckboxPickerItem = useCallback((index: number) => {
    setCheckboxPicker((current) => {
      if (!current) return current;
      const withSelection = setCheckboxPickerSelection(current, index);
      return toggleCheckboxItem(withSelection);
    });
  }, []);

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

  const submitCheckboxPickerSelection = useCallback(async () => {
    if (!checkboxPicker) return;
    const result = submitCheckboxPicker(checkboxPicker);
    if (result.kind !== "submit") return;

    const enabled = result.items.filter((item) => item.checked).map((item) => item.value);
    const args = enabled.length > 0 ? enabled.join(",") : ",";
    setCheckboxPicker(null);
    await handleSubmit(`/skills ${args}`);
  }, [checkboxPicker, handleSubmit]);

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
      showHint("A value is required.");
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
          if (!copied) showHint("Copy failed.");
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
      }
      return;
    }

    if (statPanel) {
      if (event.name === "escape" || (event.name === "c" && event.ctrl)) {
        setStatPanel(false);
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

    if (isCheckboxPickerActive(checkboxPicker)) {
      if (event.name === "up" || (event.name === "tab" && event.shift)) {
        setCheckboxPicker((current) => current ? moveCheckboxSelection(current, -1) : current);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "down" || event.name === "tab") {
        setCheckboxPicker((current) => current ? moveCheckboxSelection(current, 1) : current);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "space") {
        setCheckboxPicker((current) => current ? toggleCheckboxItem(current) : current);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "return") {
        event.preventDefault();
        event.stopPropagation();
        void submitCheckboxPickerSelection();
        return;
      }
      if (event.name === "escape") {
        setCheckboxPicker(null);
        event.preventDefault();
        event.stopPropagation();
        return;
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

    // Ctrl+Q: cycle permission mode (when no overlay is active)
    if (event.name === "q" && event.ctrl && !shouldHandleInputOverlay) {
      cyclePermissionMode();
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Ctrl+L: dismiss transient toasts (update + MCP failure + copy)
    if (event.name === "l" && event.ctrl) {
      setUpdateToast(null);
      setMcpFailures(null);
      setCopyToast(null);
      if (copyToastTimerRef.current) clearTimeout(copyToastTimerRef.current);
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
    // in Fermi, so it reaches this handler on every platform.
    if ((event.name === "v" || event.name === "y") && event.ctrl && !event.meta && !event.option && !event.super) {
      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        try {
          const clipResult = await readClipboardImage();
          if (!clipResult) {
            showHint("No image in clipboard.");
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
          showHint(`Image pasted (${processed.width}×${processed.height}, ${sizeMB} MB)`);
        } catch (err) {
          showHint(`Image paste failed: ${err instanceof Error ? err.message : String(err)}`);
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
            showHint(`Interrupted ${selectedChildId}`);
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
          showHint(`Interrupt failed: ${decision.reason ?? "unknown"}`);
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
      setPhase("Working");
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
      if (checkboxPicker) {
        setCheckboxPicker(null);
        setCommandOverlay(EMPTY_COMMAND_OVERLAY);
        return;
      }
      if (commandOverlay.visible) {
        setCommandOverlay(EMPTY_COMMAND_OVERLAY);
        return;
      }

      // 2. Processing or pending ask → interrupt
      if (processingRef.current || pendingAsk) {
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
      showHint("Press Ctrl+C again to exit");
      return;
    }

    // Ctrl+X: kill all sub-agents (any state)
    if (event.name === "x" && event.ctrl) {
      event.preventDefault();
      event.stopPropagation();
      session.interruptAllChildAgents?.();
      showHint("All sub-agents interrupted");
      return;
    }

    // Ctrl+K: kill all background shells (any state)
    if (event.name === "k" && event.ctrl) {
      event.preventDefault();
      event.stopPropagation();
      session.killAllShells?.();
      showHint("All background shells killed");
      return;
    }

    // Ctrl+G: toggle markdown raw/rendered
    if (event.name === "g" && event.ctrl) {
      setMarkdownMode((current) => {
        const next = current === "rendered" ? "raw" : "rendered";
        showHint(next === "raw" ? "Markdown raw: ON" : "Markdown raw: OFF");
        return next;
      });
      event.preventDefault();
      event.stopPropagation();
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
        showHint("Queued message restored");
      } else {
        showHint("Queued message is already being sent");
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

  const modelDescriptor = getCurrentModelDescriptor(session);
  const modelName = modelDescriptor?.compactScopedLabel ?? "unknown";
  const modelNameColor = resolveModelNameColor(modelDescriptor, theme);

  // Thinking level suffix for the status line
  const thinkingLevel = session.thinkingLevel ?? "";
  const thinkingSuffix = (() => {
    if (!thinkingLevel || thinkingLevel === "none") return "";        // not a thinking model
    if (thinkingLevel === "off") return "(Thinking Off)";             // explicitly disabled
    if (thinkingLevel === "on" || thinkingLevel === "default") return "(Thinking On)"; // on but no granular level
    return `(${thinkingLevel})`;                                      // low/medium/high/xhigh/max
  })();

  // Agent counts for indicator — all 3 states
  const runningAgentCount = childSessions.filter((s) => s.lifecycle === "running" || s.lifecycle === "blocked").length;
  const idleAgentCount = childSessions.filter((s) => s.lifecycle === "idle").length;
  const archivedAgentCount = childSessions.filter((s) => s.lifecycle === "archived").length;

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
  const childSnapshot = selectedChildId
    ? (childSessions.find((s) => s.id === selectedChildId) ?? null)
    : null;

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
    if (!statPanel) {
      setStatData(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      if (cancelled) return;
      const stats = session.computeGlobalTokenStats?.();
      if (stats) {
        setStatData({
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
  }, [statPanel, session]);

  const effectiveCacheReadTokens = childSnapshot ? childSnapshot.cacheReadTokens : cacheReadTokens;
  const effectiveProcessing = childSnapshot ? childSnapshot.running : processing;
  const effectiveEntries = presentationEntries;
  // One-line usage indicator shown in the input area's bottom row (left of
  // context). null when not logged in / unsupported provider / fetch pending.
  const usageText = formatUsageLine(usageSnapshot);

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
      cacheReadTokens={effectiveCacheReadTokens}
      usageText={usageText}
      permissionMode={permissionModeState}
      presentationEntries={effectiveEntries}
      processing={effectiveProcessing}
      markdownMode={markdownMode}
      diffDisplayMode={diffDisplayMode}
      mainScrollRef={mainScrollRef}
      detailScrollRef={detailScrollRef}
      selectedChildId={selectedChildId}
      hasQueuedUserInput={queuedInputs.length > 0}
      onEntryClick={openDetailTab}
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
      checkboxPicker={checkboxPicker}
      promptSelect={promptSelect}
      promptSecret={promptSecret}
      promptSecretInputRef={promptSecretInputRef}
      oauthOverlay={oauthOverlay}
      helpPanel={helpPanel}
      onOverlayItemClick={clickOverlayItem}
      onCommandPickerItemClick={clickCommandPickerItem}
      onCheckboxPickerItemClick={clickCheckboxPickerItem}
      onPromptSelectItemClick={clickPromptSelectItem}
      onPromptSecretSubmit={submitPromptSecret}
      inputRef={inputRef}
      phase={effectivePhase}
      modelName={effectiveModelName}
      thinkingSuffix={childSnapshot ? "" : thinkingSuffix}
      modelColor={effectiveModelColor}
      turnElapsed={effectiveElapsed}
      hint={hint}
      composerTokenVisuals={composerTokenVisuals}
      keyBindings={COMPOSER_KEY_BINDINGS}
      onSubmit={() => {
        if (selectedChildId) {
          showHint("Return to the primary session to send messages.");
          return;
        }
        void handleSubmit(getSerializedComposerInput());
      }}
      onModelClick={() => {
        if (selectedChildId) {
          showHint("Sub-Agent models are fixed by their template or tier and cannot be changed manually.");
          return;
        }
        void handleSubmit("/model");
      }}
      onPermissionClick={cyclePermissionMode}
      runningAgentCount={runningAgentCount}
      idleAgentCount={idleAgentCount}
      archivedAgentCount={archivedAgentCount}
      sidebarMode={sidebarMode}
      statusPanel={(() => {
        const showAgents = agentsPanelOpen && childSessions.length > 0;
        const showTodos = todoPanelOpen && planCheckpoints.length > 0;
        if (!showAgents && !showTodos) return undefined;
        return (
          <StatusPanel
            agents={childSessions}
            showAgents={showAgents}
            todos={planCheckpoints}
            showTodos={showTodos}
            colors={theme.colors}
            contentWidth={terminal.width - 1}
            terminalHeight={terminal.height}
            onAgentClick={enterChildSession}
          />
        );
      })()}
      pendingMessages={queuedInputs.length > 0 ? (
        <box flexDirection="column" gap={0}>
          {queuedInputs.map((queued) => (
            <box key={queued.id} flexDirection="row">
              <box width={1} backgroundColor={theme.colors.accent} />
              <box paddingLeft={1} paddingRight={1} flexGrow={1} backgroundColor={theme.colors.userWash}>
                <text fg={theme.colors.dim} content={queued.text} wrapMode="word" width="100%" />
              </box>
            </box>
          ))}
        </box>
      ) : undefined}
      todoOpenCount={planCheckpoints.filter((cp) => cp.status !== "done").length}
      todoDoneCount={planCheckpoints.filter((cp) => cp.status === "done").length}
      todoPanelOpen={todoPanelOpen}
      onTodoClick={() => setTodoPanelOpen((p) => !p)}
      shellRunningCount={shellSnapshots.filter((s) => s.status === "running").length}
      onShellsClick={openShellsPicker}
      activeShells={shellSnapshots.map(({ id, command, status }) => ({ id, command, status }))}
      activeShellDetail={activeShellDetail}
      onStopShell={stopShellFromUi}
      agentsPanelOpen={agentsPanelOpen}
      onAgentsPanelClick={() => setAgentsPanelOpen((p) => !p)}
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
      updateToast={updateToast}
      onUpdateRestart={() => {
        triggerRelaunch();
      }}
      onUpdateDismiss={() => {
        setUpdateToast(null);
      }}
      mcpFailures={mcpFailures}
      copyToast={copyToast}
      usagePanel={usagePanel}
      usageData={usageData}
      onUsageDismiss={() => setUsagePanel(false)}
      statPanel={statPanel}
      statData={statData}
      onStatDismiss={() => setStatPanel(false)}
      onBackgroundMouseDown={() => {
        if (commandOverlay.visible) setCommandOverlay(EMPTY_COMMAND_OVERLAY);
        if (commandPicker) setCommandPicker(null);
        if (checkboxPicker) setCheckboxPicker(null);
      }}
    />
  );
}
