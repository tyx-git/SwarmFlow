/** @jsxImportSource @opentui/react */

import React from "react";

import type { InputRenderable, KeyBinding, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import type { PendingAskUi } from "../../../../src/ask.js";
import type { AgentQuestionItem } from "../../../../src/ask.js";
import type { CommandPickerState } from "../../../../src/ui/command-picker.js";
import type { PresentationEntry } from "../../presentation/types.js";
import type { ComposerTokenVisuals } from "../../composer-tokens.js";
import type { UiText } from "../../../../src/ui/text.js";
import { createTextAttributes } from "@opentui/core";
import { PresentationPanel } from "../../components/entry/presentation-panel.js";
import { VERSION } from "../../../../src/version.js";
import { GlowText } from "../glow-text.js";

const ATTRS_BOLD = createTextAttributes({ bold: true });
import { DetailShellTab } from "../../components/entry/detail-shell-tab.js";
import { InputArea } from "../../input/input-area.js";
import { ScrollViewport } from "../primitives/scroll-viewport.js";
import { osCapabilities } from "../../../../src/platform/index.js";
import type { TabState } from "../../sidebar/sidebar-tabs.js";
import type { DisplayTheme } from "../theme/index.js";
import type {
  ActivityPhase,
  CommandOverlayState,
  OAuthOverlayState,
  PromptSecretState,
  PromptSelectState,
  QuestionAnswerState,
} from "../types.js";
import { AskPanelView } from "../panels/ask-panel.js";
import {
  CommandOverlayView,
  CommandPickerView,
  OAuthOverlayView,
  HelpPanelView,
  PromptSecretView,
  PromptSelectView,
} from "../overlays/views.js";
import { RightSidebar, type SidebarMode } from "../../sidebar/right-sidebar.js";
import { computePickerMaxVisible, finiteInteger, getSidebarWidth } from "./metrics.js";
import { HorizontalTabBar } from "./horizontal-tab-bar.js";
import { shortenPath } from "../utils/format.js";
import { McpToast } from "../overlays/mcp-toast.js";
import { ToastStack } from "../overlays/toast-frame.js";
import { UsagePanel } from "../overlays/usage-panel.js";
import { SessionStatusPanel, type SessionStatusData } from "../overlays/session-status-panel.js";
import { MemoryPanel } from "../overlays/memory-panel.js";

export interface OpenTuiScreenProps {
  theme: DisplayTheme;
  terminal: { width: number; height: number };
  tabs: TabState[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  sidebarExpanded: boolean;
  onToggleSidebar: () => void;
  contextTokens: number;
  contextLimit?: number;
  cacheInputTokens?: number;
  cacheReadTokens?: number;
  cacheSupported?: boolean;
  sessionName: string;
  permissionMode?: string;
  presentationEntries: readonly PresentationEntry[];
  processing: boolean;
  diffDisplayMode: "compact" | "full";
  mainScrollRef: React.RefObject<ScrollBoxRenderable | null>;
  detailScrollRef: React.RefObject<ScrollBoxRenderable | null>;
  selectedChildId: string | null;
  hasQueuedUserInput?: boolean;
  /** Temporary retry/waiting label shown in the activity row. */
  retryStatus?: string | null;
  onAgentClick?: (agentId: string) => void;
  pendingAsk: PendingAskUi | null;
  askError: string | null;
  askSelectionIndex: number;
  currentQuestionIndex: number;
  questionAnswers: Map<number, QuestionAnswerState>;
  customInputMode: boolean;
  noteInputMode: boolean;
  reviewMode: boolean;
  askInputValue: string;
  optionNotes: Map<string, string>;
  askInputRef: React.RefObject<InputRenderable | null>;
  onAskInput: (value: string) => void;
  onAskSubmit: (value: string) => void;
  getAskQuestions: () => AgentQuestionItem[];
  commandOverlay: CommandOverlayState;
  commandPicker: CommandPickerState | null;
  pickerNoteInputRef: React.RefObject<InputRenderable | null>;
  pickerNoteValue: string;
  onPickerNoteInput: (value: string) => void;
  promptSelect: PromptSelectState | null;
  promptSecret: PromptSecretState | null;
  promptSecretInputRef: React.RefObject<InputRenderable | null>;
  oauthOverlay: OAuthOverlayState | null;
  helpPanel: boolean;
  onOverlayItemClick: (index: number) => void;
  onCommandPickerItemClick: (index: number) => void;
  onPromptSelectItemClick: (index: number) => void;
  onPromptSecretSubmit: (value: string) => void;
  inputRef: React.RefObject<TextareaRenderable | null>;
  phase: ActivityPhase;
  modelName: string;
  thinkingSuffix: string;
  modelColor: string;
  turnElapsed: number;
  lastWorkedElapsed?: number;
  lastWorkedStartedAt?: number | null;
  hint: string | null;
  composerTokenVisuals: ComposerTokenVisuals;
  /** 界面文案表（language.json）；语言切换时由上层刷新。 */
  uiText: UiText;
  keyBindings: readonly KeyBinding[];
  onSubmit: () => void;
  onModelClick: () => void;
  onBackgroundMouseDown: () => void;
  sidebarMode?: SidebarMode;
  activeShells?: Array<{ id: string; command: string; status: string }>;
  /** Pre-rendered status panel (agents + todos, between conversation and input) */
  statusPanel?: React.ReactNode;
  /** Pre-rendered pending queued messages (above input, compact user bubble style) */
  pendingMessages?: React.ReactNode;
  /** Pre-rendered plan panel for sidebar (deprecated) */
  sidebarPlanSection?: React.ReactNode;
  /** Pre-rendered context usage card for sidebar */
  sidebarContextSection?: React.ReactNode;
  /** Pre-rendered codex usage card for sidebar */
  sidebarCodexSection?: React.ReactNode;
  /** Number of RUNNING background shells (badge above the input box). */
  shellRunningCount?: number;
  /** Open the shells picker. */
  onShellsClick?: () => void;
  /** Live data for the active detail-shell tab. */
  activeShellDetail?: import("../../components/entry/detail-shell-tab.js").ShellDetailData | null;
  /** Stop a background shell from the detail tab. */
  onStopShell?: (shellId: string) => void;
  /** MCP connection failures — null means hidden. Dismissal (manual via Ctrl+L
   * or auto-clear on recovery) is owned by the app; the screen just renders. */
  mcpFailures?: import("../overlays/mcp-toast.js").McpFailure[] | null;
  /** Whether the combined usage panel is visible. */
  usagePanel?: boolean;
  /** Usage data for the panel. */
  usageData?: import("../overlays/usage-panel.js").UsageData | null;
  /** Called when user dismisses the usage panel. */
  onUsageDismiss?: () => void;
  /** Current page of the combined usage panel. */
  usagePage?: "usage" | "stats";
  /** All-time statistics shown on the second usage page. */
  usageStatsData?: import("../overlays/usage-panel.js").UsageStatsData | null;
  /** Current session status panel. */
  statusPanelOverlay?: boolean;
  statusData?: SessionStatusData | null;
  onStatusDismiss?: () => void;
  /** Current-session memory panel. */
  memoryPanel?: boolean;
  memoryLines?: readonly string[];
  onMemoryDismiss?: () => void;
}

export function OpenTuiScreen({
  theme,
  terminal,
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  contextTokens,
  contextLimit,
  cacheInputTokens,
  cacheReadTokens,
  cacheSupported = false,
  sessionName,
  permissionMode,
  presentationEntries,
  processing,
  diffDisplayMode,
  mainScrollRef,
  detailScrollRef,
  selectedChildId,
  hasQueuedUserInput = false,
  retryStatus = null,
  onAgentClick,
  pendingAsk,
  askError,
  askSelectionIndex,
  currentQuestionIndex,
  questionAnswers,
  customInputMode,
  noteInputMode,
  reviewMode,
  askInputValue,
  optionNotes,
  askInputRef,
  onAskInput,
  onAskSubmit,
  getAskQuestions,
  commandOverlay,
  commandPicker,
  pickerNoteInputRef,
  pickerNoteValue,
  onPickerNoteInput,
  promptSelect,
  promptSecret,
  promptSecretInputRef,
  oauthOverlay,
  helpPanel,
  onOverlayItemClick,
  onCommandPickerItemClick,
  onPromptSelectItemClick,
  onPromptSecretSubmit,
  inputRef,
  phase,
  modelName,
  thinkingSuffix,
  modelColor,
  turnElapsed,
  lastWorkedElapsed,
  lastWorkedStartedAt,
  hint,
  composerTokenVisuals,
  uiText,
  keyBindings,
  onSubmit,
  onModelClick,
  onBackgroundMouseDown,
  sidebarMode = "close",
  activeShells = [],
  statusPanel,
  pendingMessages,
  sidebarPlanSection,
  sidebarContextSection,
  sidebarCodexSection,
  shellRunningCount,
  onShellsClick,
  activeShellDetail,
  onStopShell,
  mcpFailures,
  usagePanel,
  usageData,
  onUsageDismiss,
  usagePage = "usage",
  usageStatsData = null,
  statusPanelOverlay = false,
  statusData = null,
  onStatusDismiss,
  memoryPanel = false,
  memoryLines = [],
  onMemoryDismiss,
}: OpenTuiScreenProps): React.ReactNode {
  const terminalWidth = Math.max(1, finiteInteger(terminal.width, 1));
  const terminalHeight = Math.max(1, finiteInteger(terminal.height, 1));
  const conversationColumnWidth = terminalWidth - 1;
  const conversationContentWidth = Math.max(20, conversationColumnWidth - 6);
  const pickerMaxVisible = computePickerMaxVisible(terminalHeight, theme.layout);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const isDetailTab = activeTab?.kind === "detail-shell";

  // Sidebar visibility: hidden in child page, respects mode + terminal width
  const isChildPage = selectedChildId !== null;
  const sidebarVisible = !isChildPage && (
    sidebarMode === "open" ||
    (sidebarMode === "auto" && terminalWidth >= theme.layout.minTerminalWidthForSidebar)
  );
  const sidebarWidth = getSidebarWidth(terminalWidth, theme.layout);
  const effectiveSidebarWidth = sidebarVisible ? sidebarWidth : 0;
  const pickerContentWidth = terminalWidth - effectiveSidebarWidth - 10;
  const inputContentWidth = Math.max(20, conversationColumnWidth - effectiveSidebarWidth);
  // The inline picker lives inside a PanelSurface with one cell of horizontal
  // padding on each side, so reserve those cells when calculating truncation.
  const inlinePickerContentWidth = Math.max(20, inputContentWidth - 2);

  // Logo disappears once any content appears in the conversation (user messages,
  // status messages like /help output, agent replies, etc.). Shown at every
  // terminal size — the welcome stage is centered and clamped below, so it
  // stays readable on narrow terminals instead of being hidden outright.
  const showLogoInScroll = presentationEntries.length === 0;
  // Welcome wordmark vertical placement, keyed to ABSOLUTE terminal
  // height (not the conversation viewport). The viewport shrinks when a
  // command/picker panel opens; anchoring to terminal height instead
  // keeps the logo perfectly still. Sits slightly above optical center
  // (~40%), clamped so it never collides with the footer/input on
  // short terminals.
  // Welcome stage: "SwarmFlow." headline + version·cwd + key hints.
  // 4 lines total (headline, blank, meta, hints), centered at ~40% of
  // absolute terminal height so it never shifts when panels open.
  const welcomeCwd = shortenPath(process.cwd());
  const welcomeMetaLine = `v${VERSION} · ${welcomeCwd}`;
  const welcomeStageHeight = 4;
  const welcomeTop = Math.max(
    1,
    Math.min(
      Math.round(terminalHeight * 0.4) - Math.floor(welcomeStageHeight / 2),
      terminalHeight - welcomeStageHeight - 6,
    ),
  );

  const inlinePicker = commandPicker?.inputArea ? (
    <CommandPickerView
      picker={commandPicker}
      theme={theme}
      contentWidth={inlinePickerContentWidth}
      maxVisible={pickerMaxVisible}
      language={uiText.language}
      onItemClick={onCommandPickerItemClick}
      noteInputRef={pickerNoteInputRef}
      noteValue={pickerNoteValue}
      onNoteInput={onPickerNoteInput}
    />
  ) : promptSelect?.inputArea ? (
    <PromptSelectView
      prompt={promptSelect}
      theme={theme}
      contentWidth={inlinePickerContentWidth}
      maxVisible={pickerMaxVisible}
      onItemClick={onPromptSelectItemClick}
    />
  ) : promptSecret?.inputArea ? (
    <PromptSecretView
      prompt={promptSecret}
      inputRef={promptSecretInputRef}
      focused={Boolean(promptSecret)}
      onSubmit={onPromptSecretSubmit}
      theme={theme}
    />
  ) : undefined;

  // Shared InputArea element — rendered inside scrollbox for main view, outside for detail tabs
  const inputAreaElement = (
    <InputArea
      inputRef={inputRef}
      processing={processing}
      pendingAsk={Boolean(pendingAsk)}
      selectedChildId={selectedChildId}
      hasQueuedUserInput={hasQueuedUserInput}
      phase={phase}
      retryStatus={retryStatus}
      modelName={modelName}
      thinkingSuffix={thinkingSuffix}
      modelColor={modelColor}
      elapsed={turnElapsed}
      lastWorkedElapsed={lastWorkedElapsed}
      lastWorkedStartedAt={lastWorkedStartedAt}
      cwd={shortenPath(process.cwd())}
      permissionMode={permissionMode}
      hint={hint}
      contextTokens={contextTokens}
      contextLimit={contextLimit}
      cacheInputTokens={cacheInputTokens ?? contextTokens}
      cacheReadTokens={cacheReadTokens ?? 0}
      cacheSupported={cacheSupported}
      sessionName={sessionName}
      contentWidth={inputContentWidth}
      colors={theme.colors}
      maxInputLines={theme.layout.inputMaxVisibleLines}
      composerTokenVisuals={composerTokenVisuals}
      uiText={uiText}
      keyBindings={keyBindings}
      onSubmit={onSubmit}
      onModelClick={onModelClick}
      commandOverlayVisible={commandOverlay.visible}
      commandPicker={Boolean(commandPicker)}
      inlinePicker={inlinePicker}
      usagePanel={usagePanel && onUsageDismiss ? (
        <UsagePanel
          data={usageData ?? null}
          theme={theme}
          terminalWidth={terminalWidth}
          terminalHeight={terminalHeight}
          onDismiss={onUsageDismiss}
          inline
          uiText={uiText}
          page={usagePage}
          statsData={usageStatsData}
        />
      ) : undefined}
      promptSelect={Boolean(promptSelect)}
      promptSecret={Boolean(promptSecret)}
      shellRunningCount={shellRunningCount}
      onShellsClick={onShellsClick}
    />
  );

  // Command overlays are rendered in the fixed footer so they expand upward
  // from the top edge of the input area instead of being placed in the
  // conversation scroll viewport.
  const commandOverlayBlock = (
    <>
      <CommandOverlayView
        overlay={commandOverlay}
        theme={theme}
        contentWidth={pickerContentWidth}
        maxVisible={pickerMaxVisible}
        onItemClick={onOverlayItemClick}
      />
      <CommandPickerView
        picker={commandPicker?.inputArea ? null : commandPicker}
        theme={theme}
        contentWidth={pickerContentWidth}
        maxVisible={pickerMaxVisible}
        onItemClick={onCommandPickerItemClick}
        noteInputRef={pickerNoteInputRef}
        noteValue={pickerNoteValue}
        onNoteInput={onPickerNoteInput}
      />
    </>
  );

  // Shared non-command overlays block
  const overlaysBlock = (
    <>
      {pendingAsk ? (
        <AskPanelView
          ask={pendingAsk}
          error={askError}
          selectedIndex={askSelectionIndex}
          currentQuestionIndex={currentQuestionIndex}
          totalQuestions={pendingAsk.kind === "agent_question" ? getAskQuestions().length : 1}
          questionAnswers={questionAnswers}
          customInputMode={customInputMode}
          noteInputMode={noteInputMode}
          reviewMode={reviewMode}
          inlineValue={askInputValue}
          optionNotes={optionNotes}
          inputRef={askInputRef}
          onInput={onAskInput}
          onSubmit={onAskSubmit}
          theme={theme}
          terminalHeight={terminalHeight}
          contentWidth={Math.max(20, conversationColumnWidth - effectiveSidebarWidth)}
        />
      ) : null}
      <PromptSelectView
        prompt={promptSelect?.inputArea ? null : promptSelect}
        theme={theme}
        contentWidth={pickerContentWidth}
        maxVisible={pickerMaxVisible}
        onItemClick={onPromptSelectItemClick}
      />
      <PromptSecretView
        prompt={promptSecret?.inputArea ? null : promptSecret}
        inputRef={promptSecretInputRef}
        focused={Boolean(promptSecret)}
        onSubmit={onPromptSecretSubmit}
        theme={theme}
      />
      <OAuthOverlayView
        state={oauthOverlay}
        theme={theme}
        contentWidth={pickerContentWidth}
      />
      <HelpPanelView
        visible={helpPanel}
        theme={theme}
        contentWidth={pickerContentWidth}
      />
    </>
  );

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      paddingTop={theme.spacing.screenPaddingY}
      paddingBottom={theme.spacing.screenPaddingY}
      paddingLeft={1}
      paddingRight={0}
      gap={0}
      // Background click-to-dismiss handler — opt out of the onMouseDown
      // pointer auto-detection so hovering empty screen edges stays an arrow.
      cursor="default"
      onMouseDown={onBackgroundMouseDown}
    >
      {/* Horizontal tab bar */}
      <HorizontalTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        colors={theme.colors}
      />

      {/* Content area: main column + optional right sidebar */}
      <box flexDirection="row" flexGrow={1} gap={0}>
        {/* Main content column */}
        <box flexDirection="column" flexGrow={1} gap={0}>
          {/*
            Main conversation view — ALWAYS mounted. Hidden via Yoga
            Display.None when a detail tab is active so its ScrollViewport
            keeps its scroll position and the InputArea keeps its composer
            text across tab switches. Mounting once also avoids re-projecting
            the whole transcript on every tab transition.
          */}
          <box flexDirection="column" flexGrow={1} visible={!isDetailTab}>
            <ScrollViewport
              colors={theme.colors}
              scrollRef={mainScrollRef}
              stickyScroll={true}
              stickyStart="bottom"
              multiplier={osCapabilities.conversationScrollMultiplier}
            >
              <PresentationPanel
                items={presentationEntries}
                processing={processing}
                contentWidth={Math.max(20, conversationContentWidth - effectiveSidebarWidth)}
                diffDisplayMode={diffDisplayMode}
                colors={theme.colors}
                interruptionText={uiText.get(["Views", "interrupt", "conversation"])}
                theme={theme}
                markdownStyle={theme.markdownStyle}
                selectedChildId={selectedChildId}
                showLogoInScroll={showLogoInScroll}
                branding={theme.branding}
                onAgentClick={onAgentClick}
              />
              {/* Non-command overlays render inside the scroll area so they
                  appear right after the last transcript entry. */}
              {overlaysBlock}
            </ScrollViewport>
          </box>

          {/* Detail tabs — own scrollbox. Conditional render is fine here:
              detail views don't need cross-switch state (they always show the
              same single entry; nothing to "remember"). */}
          {activeTab?.kind === "detail-shell" ? (
            <DetailShellTab
              shellId={activeTab.shellId ?? ""}
              detail={activeShellDetail ?? null}
              colors={theme.colors}
              scrollRef={detailScrollRef}
              onStop={onStopShell}
            />
          ) : null}
        </box>
        {/* End main content column */}

        {/* Right sidebar */}
        <RightSidebar
          visible={sidebarVisible}
          width={sidebarWidth}
          colors={theme.colors}
          cwd={process.cwd()}
          activeShells={activeShells}
          planSection={sidebarPlanSection}
          contextSection={sidebarContextSection}
          codexSection={sidebarCodexSection}
        />
      </box>
      {/* End content row */}

      {/*
        Fixed footer — input area stays visible while scrolling.
        Lifted out of the main scrollbox so it stays at the bottom.
      */}
      {!memoryPanel ? pendingMessages : null}
      {!memoryPanel ? statusPanel : null}
      {!memoryPanel ? commandOverlayBlock : null}
      {!memoryPanel ? inputAreaElement : null}

      <ToastStack terminalWidth={terminalWidth}>
        {mcpFailures && mcpFailures.length > 0 ? (
          <McpToast failures={mcpFailures} theme={theme} />
        ) : null}

      </ToastStack>

      {statusPanelOverlay && onStatusDismiss && statusData ? (
        <SessionStatusPanel
          data={statusData}
          theme={theme}
          terminalWidth={terminalWidth}
          terminalHeight={terminalHeight}
          onDismiss={onStatusDismiss}
        />
      ) : null}
      {memoryPanel && onMemoryDismiss ? (
        <MemoryPanel
          lines={memoryLines}
          theme={theme}
          terminalWidth={terminalWidth}
          terminalHeight={terminalHeight}
          onDismiss={onMemoryDismiss}
        />
      ) : null}

      {/*
        Welcome wordmark — absolutely positioned against terminal height,
        OUTSIDE the conversation scrollbox. Decoupled from the viewport so
        opening a slash/command/picker panel (which grows the in-flow
        footer and shrinks the scrollbox) leaves it perfectly still. Gated
        off the moment a user message exists so it never paints over a
        real conversation.
      */}
      {showLogoInScroll ? (
        <box
          position="absolute"
          top={welcomeTop}
          left={0}
          width={terminalWidth}
          zIndex={5}
          flexDirection="column"
          alignItems="center"
        >
          <GlowText
            text="SwarmFlow."
            fromColor={theme.colors.accent}
            toColor={theme.colors.accent}
          />
          <box height={1} />
          <text fg={theme.colors.dim} content={welcomeMetaLine} />
          <box flexDirection="row">
            <text fg={theme.colors.text} attributes={ATTRS_BOLD} content="/ " />
            <text fg={theme.colors.dim} content="commands · " />
            <text fg={theme.colors.text} attributes={ATTRS_BOLD} content="@ " />
            <text fg={theme.colors.dim} content="files · " />
            <text fg={theme.colors.text} attributes={ATTRS_BOLD} content="/help " />
            <text fg={theme.colors.dim} content="shortcuts" />
          </box>
        </box>
      ) : null}
    </box>
  );
}
