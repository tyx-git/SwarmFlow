/** @jsxImportSource @opentui/react */

import React from "react";

import type { InputRenderable, KeyBinding, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import type { PendingAskUi } from "../../../../src/ask.js";
import type { AgentQuestionItem } from "../../../../src/ask.js";
import type { CommandPickerState } from "../../../../src/ui/command-picker.js";
import type { CheckboxPickerState } from "../../../../src/ui/checkbox-picker.js";
import type { PresentationEntry } from "../../presentation/types.js";
import type { ComposerTokenVisuals } from "../../composer-tokens.js";
import { createTextAttributes } from "@opentui/core";
import { PresentationPanel } from "../../components/entry/presentation-panel.js";
import { VERSION } from "../../../../src/version.js";
import { GlowText } from "../glow-text.js";

const ATTRS_BOLD = createTextAttributes({ bold: true });
import { DetailToolTab } from "../../components/entry/detail-tool-tab.js";
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
  CheckboxPickerView,
  CommandOverlayView,
  CommandPickerView,
  OAuthOverlayView,
  HelpPanelView,
  PromptSecretView,
  PromptSelectView,
} from "../overlays/views.js";
import { RightSidebar, type SidebarMode } from "../../sidebar/right-sidebar.js";
import { computePickerMaxVisible, getSidebarWidth } from "./metrics.js";
import { HorizontalTabBar } from "./horizontal-tab-bar.js";
import { shortenPath } from "../utils/format.js";
import { UpdateToast } from "../overlays/update-toast.js";
import { McpToast } from "../overlays/mcp-toast.js";
import { CopyToast } from "../overlays/copy-toast.js";
import { ToastStack } from "../overlays/toast-frame.js";
import { UsagePanel } from "../overlays/usage-panel.js";
import { StatPanel } from "../overlays/stat-panel.js";

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
  cacheReadTokens?: number;
  /** Pre-formatted usage line (e.g. "5h: 90% left | wk: 80% left" or "month: 300/300 left"); null to hide. */
  usageText?: string | null;
  permissionMode?: string;
  presentationEntries: readonly PresentationEntry[];
  processing: boolean;
  markdownMode: "rendered" | "raw";
  diffDisplayMode: "compact" | "full";
  mainScrollRef: React.RefObject<ScrollBoxRenderable | null>;
  detailScrollRef: React.RefObject<ScrollBoxRenderable | null>;
  selectedChildId: string | null;
  hasQueuedUserInput?: boolean;
  onEntryClick: (entry: PresentationEntry) => void;
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
  checkboxPicker: CheckboxPickerState | null;
  promptSelect: PromptSelectState | null;
  promptSecret: PromptSecretState | null;
  promptSecretInputRef: React.RefObject<InputRenderable | null>;
  oauthOverlay: OAuthOverlayState | null;
  helpPanel: boolean;
  onOverlayItemClick: (index: number) => void;
  onCommandPickerItemClick: (index: number) => void;
  onCheckboxPickerItemClick: (index: number) => void;
  onPromptSelectItemClick: (index: number) => void;
  onPromptSecretSubmit: (value: string) => void;
  inputRef: React.RefObject<TextareaRenderable | null>;
  phase: ActivityPhase;
  modelName: string;
  thinkingSuffix: string;
  modelColor: string;
  turnElapsed: number;
  hint: string | null;
  composerTokenVisuals: ComposerTokenVisuals;
  keyBindings: readonly KeyBinding[];
  onSubmit: () => void;
  onModelClick: () => void;
  onPermissionClick?: () => void;
  runningAgentCount?: number;
  idleAgentCount?: number;
  archivedAgentCount?: number;
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
  todoOpenCount?: number;
  todoDoneCount?: number;
  todoPanelOpen?: boolean;
  onTodoClick?: () => void;
  agentsPanelOpen?: boolean;
  onAgentsPanelClick?: () => void;
  /** Number of RUNNING background shells (badge above the input box). */
  shellRunningCount?: number;
  /** Open the shells picker. */
  onShellsClick?: () => void;
  /** Live data for the active detail-shell tab. */
  activeShellDetail?: import("../../components/entry/detail-shell-tab.js").ShellDetailData | null;
  /** Stop a background shell from the detail tab. */
  onStopShell?: (shellId: string) => void;
  /** Update toast state — null means hidden. */
  updateToast?: { phase: import("../overlays/update-toast.js").UpdateToastPhase; version?: string; error?: string } | null;
  /** MCP connection failures — null means hidden. Dismissal (manual via Ctrl+L
   * or auto-clear on recovery) is owned by the app; the screen just renders. */
  mcpFailures?: import("../overlays/mcp-toast.js").McpFailure[] | null;
  /** Copy-on-select toast body — null means hidden. The ~2s auto-dismiss
   * timer is owned by the app; the screen just renders. */
  copyToast?: string | null;
  /** Called when user clicks "Restart" in the update toast. */
  onUpdateRestart?: () => void;
  /** Called when user dismisses the update toast. */
  onUpdateDismiss?: () => void;
  /** Whether the usage panel overlay is visible. */
  usagePanel?: boolean;
  /** Usage data for the panel. */
  usageData?: import("../overlays/usage-panel.js").UsageData | null;
  /** Called when user dismisses the usage panel. */
  onUsageDismiss?: () => void;
  /** Whether the stat panel overlay is visible. */
  statPanel?: boolean;
  /** Stat data for the panel. */
  statData?: import("../overlays/stat-panel.js").StatData | null;
  /** Called when user dismisses the stat panel. */
  onStatDismiss?: () => void;
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
  cacheReadTokens,
  usageText,
  permissionMode,
  presentationEntries,
  processing,
  markdownMode,
  diffDisplayMode,
  mainScrollRef,
  detailScrollRef,
  selectedChildId,
  hasQueuedUserInput = false,
  onEntryClick,
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
  checkboxPicker,
  promptSelect,
  promptSecret,
  promptSecretInputRef,
  oauthOverlay,
  helpPanel,
  onOverlayItemClick,
  onCommandPickerItemClick,
  onCheckboxPickerItemClick,
  onPromptSelectItemClick,
  onPromptSecretSubmit,
  inputRef,
  phase,
  modelName,
  thinkingSuffix,
  modelColor,
  turnElapsed,
  hint,
  composerTokenVisuals,
  keyBindings,
  onSubmit,
  onModelClick,
  onPermissionClick,
  runningAgentCount,
  idleAgentCount,
  archivedAgentCount,
  onBackgroundMouseDown,
  sidebarMode = "close",
  activeShells = [],
  statusPanel,
  pendingMessages,
  sidebarPlanSection,
  sidebarContextSection,
  sidebarCodexSection,
  todoOpenCount,
  todoDoneCount,
  todoPanelOpen,
  onTodoClick,
  agentsPanelOpen,
  onAgentsPanelClick,
  shellRunningCount,
  onShellsClick,
  activeShellDetail,
  onStopShell,
  updateToast,
  onUpdateRestart,
  onUpdateDismiss,
  mcpFailures,
  copyToast,
  usagePanel,
  usageData,
  onUsageDismiss,
  statPanel,
  statData,
  onStatDismiss,
}: OpenTuiScreenProps): React.ReactNode {
  const conversationColumnWidth = terminal.width - 1;
  const conversationContentWidth = Math.max(20, conversationColumnWidth - 6);
  const pickerMaxVisible = computePickerMaxVisible(terminal.height, theme.layout);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const isDetailTab = activeTab?.kind === "detail-tool" || activeTab?.kind === "detail-shell";
  // Detail entry lookup: live entries → frozenEntry fallback
  const detailEntry = activeTab?.kind === "detail-tool"
    ? (presentationEntries.find((entry) => activeTabId === `detail:${entry.id}`)
       ?? activeTab?.frozenEntry
       ?? null) as typeof presentationEntries[number] | null
    : null;

  // Sidebar visibility: hidden in child page, respects mode + terminal width
  const isChildPage = selectedChildId !== null;
  const sidebarVisible = !isChildPage && (
    sidebarMode === "open" ||
    (sidebarMode === "auto" && terminal.width >= theme.layout.minTerminalWidthForSidebar)
  );
  const sidebarWidth = getSidebarWidth(terminal.width, theme.layout);
  const effectiveSidebarWidth = sidebarVisible ? sidebarWidth : 0;
  const pickerContentWidth = terminal.width - effectiveSidebarWidth - 10;

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
      Math.round(terminal.height * 0.4) - Math.floor(welcomeStageHeight / 2),
      terminal.height - welcomeStageHeight - 6,
    ),
  );

  // Shared InputArea element — rendered inside scrollbox for main view, outside for detail tabs
  const inputAreaElement = (
    <InputArea
      inputRef={inputRef}
      processing={processing}
      pendingAsk={Boolean(pendingAsk)}
      selectedChildId={selectedChildId}
      hasQueuedUserInput={hasQueuedUserInput}
      phase={phase}
      modelName={modelName}
      thinkingSuffix={thinkingSuffix}
      modelColor={modelColor}
      elapsed={turnElapsed}
      cwd={shortenPath(process.cwd())}
      permissionMode={permissionMode}
      hint={hint}
      contextTokens={contextTokens}
      contextLimit={contextLimit}
      cacheReadTokens={cacheReadTokens ?? 0}
      usageText={usageText ?? null}
      contentWidth={Math.max(20, conversationColumnWidth - effectiveSidebarWidth)}
      colors={theme.colors}
      maxInputLines={theme.layout.inputMaxVisibleLines}
      composerTokenVisuals={composerTokenVisuals}
      keyBindings={keyBindings}
      onSubmit={onSubmit}
      onModelClick={onModelClick}
      onPermissionClick={onPermissionClick}
      runningAgentCount={runningAgentCount}
      idleAgentCount={idleAgentCount}
      archivedAgentCount={archivedAgentCount}
      commandOverlayVisible={commandOverlay.visible}
      commandPicker={Boolean(commandPicker)}
      checkboxPicker={Boolean(checkboxPicker)}
      promptSelect={Boolean(promptSelect)}
      promptSecret={Boolean(promptSecret)}
      todoOpenCount={todoOpenCount}
      todoDoneCount={todoDoneCount}
      todoPanelOpen={todoPanelOpen}
      onTodoClick={onTodoClick}
      agentsPanelOpen={agentsPanelOpen}
      onAgentsPanelClick={onAgentsPanelClick}
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
        picker={commandPicker}
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
          terminalHeight={terminal.height}
          contentWidth={Math.max(20, conversationColumnWidth - effectiveSidebarWidth)}
        />
      ) : null}
      <CheckboxPickerView
        picker={checkboxPicker}
        theme={theme}
        contentWidth={pickerContentWidth}
        onItemClick={onCheckboxPickerItemClick}
      />
      <PromptSelectView
        prompt={promptSelect}
        theme={theme}
        contentWidth={pickerContentWidth}
        maxVisible={pickerMaxVisible}
        onItemClick={onPromptSelectItemClick}
      />
      <PromptSecretView
        prompt={promptSecret}
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
                markdownMode={markdownMode}
                diffDisplayMode={diffDisplayMode}
                colors={theme.colors}
                theme={theme}
                markdownStyle={theme.markdownStyle}
                selectedChildId={selectedChildId}
                showLogoInScroll={showLogoInScroll}
                branding={theme.branding}
                onEntryClick={onEntryClick}
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
          {detailEntry && activeTab?.kind === "detail-tool" ? (
            <DetailToolTab
              entry={detailEntry}
              colors={theme.colors}
              contentWidth={Math.max(20, conversationContentWidth - effectiveSidebarWidth)}
              scrollRef={detailScrollRef}
            />
          ) : null}
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
      <box height={1} />
      {pendingMessages}
      {pendingMessages ? <box height={1} /> : null}
      {statusPanel}
      {commandOverlayBlock}
      {inputAreaElement}

      <ToastStack terminalWidth={terminal.width}>
        {updateToast && onUpdateRestart && onUpdateDismiss ? (
          <UpdateToast
            phase={updateToast.phase}
            version={updateToast.version}
            error={updateToast.error}
            theme={theme}
            onRestart={onUpdateRestart}
            onDismiss={onUpdateDismiss}
          />
        ) : null}

        {mcpFailures && mcpFailures.length > 0 ? (
          <McpToast failures={mcpFailures} theme={theme} />
        ) : null}

        {copyToast ? <CopyToast message={copyToast} theme={theme} /> : null}
      </ToastStack>

      {usagePanel && onUsageDismiss ? (
        <UsagePanel
          data={usageData ?? null}
          theme={theme}
          terminalWidth={terminal.width}
          terminalHeight={terminal.height}
          onDismiss={onUsageDismiss}
        />
      ) : null}

      {statPanel && onStatDismiss ? (
        <StatPanel
          data={statData ?? null}
          theme={theme}
          terminalWidth={terminal.width}
          terminalHeight={terminal.height}
          onDismiss={onStatDismiss}
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
          width={terminal.width}
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
