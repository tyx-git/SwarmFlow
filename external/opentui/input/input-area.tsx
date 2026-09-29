/** @jsxImportSource @opentui/react */

import React from "react";

import { createTextAttributes, type KeyBinding, type TextareaRenderable } from "@opentui/core";

const ATTRS_BOLD = createTextAttributes({ bold: true });
import type { ConversationPalette } from "../components/conversation-types.js";
import type { ComposerTokenVisuals } from "../composer-tokens.js";
import type { ActivityPhase } from "../display/types.js";
import { formatCompactTokensShort } from "../display/utils/format.js";
import {
  formatElapsed,
  formatWorkedDuration,
  formatWorkedStartTime,
} from "../presentation/use-turn-timer.js";
import type { UiText } from "../../../src/lib/ui-text.js";
import {
  useSpinner,
  WORKING_SPINNER_FRAMES,
  WORKING_SPINNER_INTERVAL,
  ASKING_SPINNER_FRAMES,
  ASKING_SPINNER_INTERVAL,
} from "../presentation/use-spinner.js";

interface InputAreaProps {
  inputRef: React.RefObject<TextareaRenderable | null>;
  processing: boolean;
  pendingAsk: boolean;
  selectedChildId: string | null;
  hasQueuedUserInput?: boolean;
  phase: ActivityPhase;
  modelName: string;
  /** 思考深度后缀，显示在"供应商/模型"之后（暗色）。空串 = 隐藏。 */
  thinkingSuffix: string;
  modelColor: string;
  elapsed: number;
  /** Duration and start time of the most recently completed turn. */
  lastWorkedElapsed?: number;
  lastWorkedStartedAt?: number | null;
  cwd: string;
  permissionMode?: string;
  hint: string | null;
  contextTokens: number;
  contextLimit: number | undefined;
  cacheReadTokens: number;
  /**
   * Pre-formatted one-line usage indicator (e.g. "5h: 90% left | wk: 80% left"
   * or "month: 300/300 left"). When null, the indicator is hidden entirely.
   * Only shown when cwd + usage + context all fit inside contentWidth.
   */
  usageText: string | null;
  /** Width of the content column (terminal width minus screen padding). */
  contentWidth: number;
  colors: ConversationPalette;
  maxInputLines: number;
  composerTokenVisuals: ComposerTokenVisuals;
  /** 界面文案表（language.json）；由上层按当前语言注入。 */
  uiText: UiText;
  keyBindings: readonly KeyBinding[];
  onSubmit: () => void;
  onModelClick: () => void;
  onPermissionClick?: () => void;
  commandOverlayVisible: boolean;
  commandPicker: boolean;
  /** Any command picker rendered in the composer's input slot. */
  inlinePicker?: React.ReactNode;
  checkboxPicker: boolean;
  promptSelect: boolean;
  promptSecret: boolean;
  /** Number of running child agents. */
  runningAgentCount?: number;
  /** Number of idle child agents. */
  idleAgentCount?: number;
  /** Number of archived child agents. */
  archivedAgentCount?: number;
  /** Number of RUNNING background shells (async only — sync bash never shows here). */
  shellRunningCount?: number;
  /** Open the shells picker. */
  onShellsClick?: () => void;
  /** Whether the agents panel is currently expanded. */
  agentsPanelOpen?: boolean;
  /** Toggle the agents panel. */
  onAgentsPanelClick?: () => void;
}

function getPhaseSpinnerConfig(phase: ActivityPhase): { frames: readonly string[]; interval: number } {
  if (phase === "Asking") return { frames: ASKING_SPINNER_FRAMES, interval: ASKING_SPINNER_INTERVAL };
  return { frames: WORKING_SPINNER_FRAMES, interval: WORKING_SPINNER_INTERVAL };
}

function getPhaseColor(phase: ActivityPhase, colors: ConversationPalette): string {
  if (phase === "Asking") return colors.dim;
  return colors.workingStatus;
}

/**
 * Decide whether the usage indicator fits on the bottom row alongside cwd
 * and context. `hint` is NOT reserved — it has flexShrink={1} + truncate,
 * so it collapses to whatever space is left. If the fixed-shrink parts
 * (cwd + usage + context + separators) fit inside contentWidth, we show
 * the usage indicator; otherwise it's hidden entirely.
 */
function shouldShowUsage(
  contentWidth: number,
  cwdLen: number,
  usageLen: number,
  contextLen: number,
): boolean {
  const inner = contentWidth - 2; // paddingLeft=1 + paddingRight=1
  const fixedWidth = cwdLen + usageLen + contextLen + 4; // "  " × 2 separators
  return inner >= fixedWidth;
}

function InputAreaInner(props: InputAreaProps): React.ReactNode {
  const {
    inputRef,
    processing,
    pendingAsk,
    selectedChildId,
    hasQueuedUserInput = false,
    phase,
    modelName,
    modelColor,
    elapsed,
    lastWorkedElapsed = 0,
    lastWorkedStartedAt = null,
    cwd,
    permissionMode,
    hint,
    contextTokens,
    contextLimit,
    cacheReadTokens,
    usageText,
    contentWidth,
    colors,
    maxInputLines,
    composerTokenVisuals,
    uiText,
    keyBindings,
    onSubmit,
    onModelClick,
    onPermissionClick,
    commandOverlayVisible,
    commandPicker,
    inlinePicker,
    checkboxPicker,
    promptSelect,
    promptSecret,
    runningAgentCount = 0,
    idleAgentCount = 0,
    archivedAgentCount = 0,
    agentsPanelOpen = false,
    onAgentsPanelClick,
    shellRunningCount = 0,
    onShellsClick,
  } = props;

  const t = uiText;
  const placeholder = pendingAsk
    ? t.get(["Views", "input", "askPending"])
    : selectedChildId
      ? t.get(["Views", "input", "childActive"])
      : hasQueuedUserInput
        ? t.get(["Views", "input", "queuedHint"])
        : t.get(["Views", "input", "default"]);

  const focused = phase !== "closing" && !pendingAsk && !commandPicker && !checkboxPicker && !promptSelect && !promptSecret && !selectedChildId;

  const spinnerConfig = getPhaseSpinnerConfig(phase);
  const activeSpinner = useSpinner(spinnerConfig.frames, spinnerConfig.interval, processing);
  const phaseColor = getPhaseColor(phase, colors);
  const workedStatus = typeof lastWorkedElapsed === "number" && lastWorkedStartedAt !== null
    ? `Worked for ${formatWorkedDuration(lastWorkedElapsed)} · ${formatWorkedStartTime(lastWorkedStartedAt)}`
    : null;
  const activityStatus = processing ? (
    <box flexDirection="row" flexShrink={0}>
      <text fg={phaseColor} content={`${activeSpinner} ${phase}`} />
      {elapsed > 0 ? (
        <text fg={colors.dim} content={` ${formatElapsed(elapsed)}`} />
      ) : null}
    </box>
  ) : workedStatus ? (
    <text fg="#616161" content={workedStatus} />
  ) : null;

  if (inlinePicker) {
    return (
      <box flexDirection="column" gap={0} flexShrink={0}>
        <box flexDirection="row" width="100%" paddingLeft={1} paddingRight={1}>
          {activityStatus}
          <box flexGrow={1} />
          <box flexDirection="row" flexShrink={0}>
            <text fg={modelColor} content={modelName} />
            {props.thinkingSuffix ? <text fg={colors.dim} content={` ${props.thinkingSuffix}`} /> : null}
          </box>
        </box>
        <text fg={colors.dim} content={"─".repeat(Math.max(1, contentWidth))} />
        <box flexDirection="row" width="100%">
          <box flexGrow={1} flexDirection="column">{inlinePicker}</box>
        </box>
        <text fg={colors.dim} content={"─".repeat(Math.max(1, contentWidth))} />
      </box>
    );
  }

  const cacheLabel = cacheReadTokens > 0 ? ` (${formatCompactTokensShort(cacheReadTokens)} cached)` : "";
  const contextText = contextLimit
    ? `${formatCompactTokensShort(contextTokens)}/${formatCompactTokensShort(contextLimit)}${cacheLabel}`
    : `${formatCompactTokensShort(contextTokens)}${cacheLabel}`;

  return (
    <box flexDirection="column" gap={0} flexShrink={0}>
      {/* Top row: activity indicator (left) + agent indicator (center) + model name (right) */}
      <box flexDirection="row" width="100%" paddingLeft={1} paddingRight={1}>
        {activityStatus}

        {/* Agent indicator: show whenever agents exist */}
        {(runningAgentCount + idleAgentCount + archivedAgentCount) > 0 && !selectedChildId ? (
          <>
          {processing ? <box width={2} /> : null}
          <box
            flexDirection="row"
            flexShrink={0}
            cursor="pointer"
            backgroundColor={agentsPanelOpen ? colors.badgeAgentBgActive : colors.badgeAgentBg}
            onMouseDown={(e: any) => { e.stopPropagation(); e.preventDefault(); onAgentsPanelClick?.(); }}
          >
            <text fg={colors.badgeAgentFg} content={(() => {
              const parts: string[] = [];
              if (runningAgentCount > 0) parts.push(t.get(["Views", "indicators", "agentsRunning"], { count: runningAgentCount }));
              const doneAgents = idleAgentCount + archivedAgentCount;
              if (doneAgents > 0) parts.push(t.get(["Views", "indicators", "agentsDone"], { count: doneAgents }));
              return t.get(["Views", "indicators", "agents"], { parts: parts.join(", ") });
            })()} />
          </box>
          </>
        ) : null}

        {/* Shells indicator: running background shells only (sync bash never appears here) */}
        {shellRunningCount > 0 && !selectedChildId ? (
          <>
          {((runningAgentCount + idleAgentCount + archivedAgentCount) > 0 || processing) ? <box width={1} /> : null}
          <box
            flexDirection="row"
            flexShrink={0}
            cursor="pointer"
            backgroundColor={colors.badgeShellBg}
            onMouseDown={(e: any) => { e.stopPropagation(); e.preventDefault(); onShellsClick?.(); }}
          >
            <text fg={colors.badgeShellFg} content={t.get(["Views", "indicators", "shells"], { count: shellRunningCount })} />
          </box>
          </>
        ) : null}

        <box flexGrow={1} />
        <box
          flexDirection="row"
          flexShrink={0}
          cursor="pointer"
          onMouseDown={(e: any) => { e.stopPropagation(); e.preventDefault(); onModelClick(); }}
        >
          <text fg={modelColor} content={modelName} />
          {props.thinkingSuffix ? (
            <text fg={colors.dim} content={` ${props.thinkingSuffix}`} />
          ) : null}
        </box>
      </box>

      {/* Input area: two horizontal lines with ❯ prompt */}
      <box width="100%" flexShrink={0}>
        <text fg={colors.dim} content={"─".repeat(Math.max(1, contentWidth))} />
        <box flexDirection="row" width="100%">
          <text fg={colors.dim} attributes={ATTRS_BOLD} content="❯ " flexShrink={0} />
          <textarea
            ref={(node: any) => {
              (inputRef as any).current = node;
            }}
            placeholder={placeholder}
            focused={focused}
            textColor={selectedChildId ? colors.muted : colors.text}
            focusedTextColor={selectedChildId ? colors.muted : colors.text}
            placeholderColor={colors.muted}
            cursorStyle={{ style: "line", blinking: true }}
            cursorColor={colors.cursor}
            flexGrow={1}
            maxHeight={maxInputLines}
            minHeight={1}
            syntaxStyle={composerTokenVisuals.syntaxStyle}
            keyBindings={[...keyBindings]}
            onSubmit={onSubmit}
            wrapMode="word"
            scrollMargin={0}
          />
        </box>
        <text fg={colors.dim} content={"─".repeat(Math.max(1, contentWidth))} />
      </box>

      {/* Bottom row: permission/hint (left, mutually exclusive) + usage + context (right) */}
      {!commandOverlayVisible && !commandPicker && !checkboxPicker && !promptSelect && !promptSecret && !pendingAsk ? (
        <box flexDirection="row" width="100%" paddingLeft={1} paddingRight={1}>
          <box
            flexShrink={1}
            flexGrow={0}
            cursor={!hint && onPermissionClick ? "pointer" : undefined}
            onMouseDown={!hint && onPermissionClick ? (e: any) => { e.stopPropagation(); e.preventDefault(); onPermissionClick(); } : undefined}
          >
            {hint ? (
              <text fg={colors.dim} content={hint} truncate />
            ) : (
              <text
                fg={permissionMode === "yolo" ? colors.red : permissionMode === "read_only" ? colors.permissionReadOnly : colors.accent}
                content={permissionMode === "yolo"
                  ? t.get(["Views", "permission", "yolo"])
                  : permissionMode === "read_only"
                    ? t.get(["Views", "permission", "readOnly"])
                    : t.get(["Views", "permission", "reversible"])}
              />
            )}
          </box>
          <box flexGrow={1} />
          {usageText && shouldShowUsage(contentWidth, 11, usageText.length, contextText.length) ? (
            <text fg={colors.dim} content={`  ${usageText}`} flexShrink={0} />
          ) : null}
          <text fg={colors.dim} content={`  ${contextText}`} flexShrink={0} />
        </box>
      ) : null}
    </box>
  );
}

export const InputArea = React.memo(InputAreaInner);
