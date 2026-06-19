/** @jsxImportSource @opentui/react */

// =============================================================================
// SwarmFlow GUI — 工具操作条目渲染
// =============================================================================
// 职责：渲染工具调用的参数、结果、状态条
// 工具类型：Read/Edit/Write/List/Bash/Glob 等
// 特性：流式输出（shimmer）、可点击文件路径（打开文件）、diff 展开/折叠

import React, { useEffect, useRef, useState } from "react";
import path from "node:path";

import { browser, osCapabilities } from "../../../src/platform/index.js";

import { RGBA, createTextAttributes } from "@opentui/core";

const ATTRS_UNDERLINE = createTextAttributes({ underline: true });
const ATTRS_BOLD = createTextAttributes({ bold: true });
import type { PresentationEntry } from "../../presentation/types.js";
import { useShimmer } from "../../presentation/use-shimmer.js";
import type { ConversationPalette } from "../conversation-types.js";
import { InlineResult } from "./inline-result.js";
import { FileModifyBody } from "./file-modify-body.js";
import type { DisplayTheme } from "../../display/theme/index.js";

const BAR_COLOR = "#66635c";

// 流式工具输出最多显示 10 行（后续折叠）
const TOOL_STREAM_MAX_LINES = 10;

// Tool call arg / result body two-tier dim palette (matches AgentRows done state).
const ARG_COLOR = "#7a8098";    // L=54 鈥?brighter: tool args, path, suffix, event timeout
const RESULT_COLOR = "#5a6078"; // L=41 鈥?darker:  tool result body content
const PATH_TOOL_NAMES = new Set(["Read", "Edit", "Write", "List"]);

function openFile(filePath: string): void {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  browser.openFile(resolved);
}

/** A file-path text element with hover highlight and click-to-open. */
function ClickablePath({ text, baseColor, hoverBg }: { text: string; baseColor: string; hoverBg: string }): React.ReactNode {
  const [hovered, setHovered] = useState(false);
  return (
    <box
      flexShrink={1}
      backgroundColor={hovered ? hoverBg : undefined}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(e: any) => {
        e.stopPropagation();
        e.preventDefault();
        if (text) openFile(text);
      }}
    >
      <text
        fg={baseColor}
        attributes={ATTRS_UNDERLINE}
        content={text}
        truncate
      />
    </box>
  );
}

/** A sub-agent name element with hover highlight and click-to-open-tab. */
function ClickableAgentName(
  { text, baseColor, hoverBg, onClick }: { text: string; baseColor: string; hoverBg: string; onClick: () => void },
): React.ReactNode {
  const [hovered, setHovered] = useState(false);
  return (
    <box
      flexShrink={1}
      backgroundColor={hovered ? hoverBg : undefined}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(e: any) => {
        e.stopPropagation();
        e.preventDefault();
        onClick();
      }}
    >
      <text
        fg={baseColor}
        attributes={ATTRS_UNDERLINE}
        content={text}
        truncate
      />
    </box>
  );
}

function buildSectionPreview(text: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return { text, truncated: false };
  }
  return {
    text: lines.slice(0, maxLines).join("\n"),
    truncated: true,
  };
}

/** Live elapsed seconds since a start timestamp (updates every second). Returns 0 when inactive. */
function useElapsedSince(startMs: number | undefined, active: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!active || !startMs) {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      setElapsed(0);
      return;
    }
    const tick = () => setElapsed(Math.floor((Date.now() - startMs) / 1000));
    tick();
    intervalRef.current = setInterval(tick, 1000);
    return () => { if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; } };
  }, [active, startMs]);
  return elapsed;
}

interface ToolOperationEntryProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
  theme: DisplayTheme;
  contentWidth: number;
  diffDisplayMode: "compact" | "full";
  onEntryClick?: (entry: PresentationEntry) => void;
  onAgentClick?: (agentId: string) => void;
}

function ToolOperationEntryInner(
  { entry, colors, theme, contentWidth, diffDisplayMode, onEntryClick, onAgentClick }: ToolOperationEntryProps,
): React.ReactNode {
  const active = entry.state === "active";

  const toolNameColor = theme.presentation.toolNameColor;
  const toolNameRgba = React.useMemo(() => RGBA.fromHex(toolNameColor), [toolNameColor]);
  const displayName = entry.toolDisplayName ?? "Tool";
  const barColor = BAR_COLOR;
  const shimmer = useShimmer(displayName, toolNameRgba, active, ATTRS_BOLD);
  const interrupted = entry.toolInterrupted === true;

  // Done-state glyph is platform-specific: on Windows PowerShell's
  // default font U+23FA falls through to Segoe UI Symbol and renders
  // as a square-outlined "record" icon, so the win32 osCapabilities
  // profile substitutes U+2B24 BLACK LARGE CIRCLE which stays a clean
  // filled circle in Cascadia Mono / Consolas.
  const indicator = active ? "鈥? : osCapabilities.toolIndicatorGlyph;

  const indicatorColor = active
    ? toolNameColor
    : interrupted
      ? theme.colors.waitingStatus
      : entry.state === "error"
      ? theme.presentation.errorColor
      : theme.presentation.successColor;

  const isAwaitEvent = displayName === "Wait";
  const awaitElapsed = useElapsedSince(entry.toolStartedAt, active && isAwaitEvent);
  const toolText = entry.toolText ?? "";
  const suffix = entry.toolSuffix ?? "";
  const streamSections = entry.toolStreamSections ?? [];

  // File-modify tools use FileModifyBody with unified FileModifyDisplayData
  const fmd = entry.fileModifyData;
  const showFileModify = fmd
    && (fmd.hunks.length > 0 || (fmd.writeLines && fmd.writeLines.length > 0))
    && entry.state !== "error";

  // Fallback: legacy streaming body for non-file-modify tools
  // (file-modify tools should never show raw section labels 鈥?they use FileModifyBody or InlineResult)
  const isFileModifyTool = entry.toolStreamMode === "replace"
    || entry.toolStreamMode === "append"
    || entry.toolStreamMode === "write";
  const showStreamBody = !showFileModify
    && !isFileModifyTool
    && streamSections.length > 0
    && !entry.toolInlineResult;

  // Fallback: InlineResult for non-file-modify tools after completion
  const showInlineResult = !showFileModify
    && !showStreamBody
    && entry.toolInlineResult
    && entry.state !== "active";

  const hasBody = showFileModify || showStreamBody || showInlineResult;

  return (
    <box flexDirection="column" width="100%" gap={0}>
      <box
        flexDirection="row"
        paddingTop={1}
        width="100%"
      >
        <text fg={indicatorColor} content={`${indicator} `} flexShrink={0} />
        {active ? (
          <text content={shimmer} flexShrink={0} />
        ) : (
          <text fg={toolNameColor} attributes={ATTRS_BOLD} content={displayName} flexShrink={0} />
        )}
        {suffix ? (
          <text fg={ARG_COLOR} content={` ${suffix}`} flexShrink={0} />
        ) : null}
        <text content="  " flexShrink={0} />
        {isAwaitEvent && active ? (
          <text fg={ARG_COLOR} content={`${awaitElapsed}s  Timeout: ${toolText} (Send a message to interrupt)`} flexShrink={0} />
        ) : entry.toolAgentName && !active ? (
          <ClickableAgentName
            text={entry.toolAgentName}
            baseColor={ARG_COLOR}
            hoverBg={colors.border}
            onClick={() => onAgentClick?.(entry.toolAgentName!)}
          />
        ) : PATH_TOOL_NAMES.has(displayName) && toolText && !active ? (
          <ClickablePath text={toolText} baseColor={ARG_COLOR} hoverBg={colors.border} />
        ) : (
          <text fg={ARG_COLOR} content={toolText} wrapMode="char" flexGrow={1} flexShrink={1} />
        )}
      </box>
      {hasBody ? (
        <box flexDirection="row" paddingLeft={3} alignItems="flex-start">
          <text fg={barColor} content="鈹? flexShrink={0} />
          <box
            flexDirection="column"
            flexGrow={1}
            border={["left"] as any}
            borderColor={barColor}
            borderStyle="single"
            paddingLeft={1}
            gap={0}
          >
            {showFileModify ? (
              <FileModifyBody
                data={fmd!}
                colors={colors}
                contentWidth={contentWidth - 6}
                streaming={entry.state === "active"}
                maxVisibleLines={diffDisplayMode === "full" ? Infinity : undefined}
                onOpenDetail={onEntryClick ? () => onEntryClick(entry) : undefined}
              />
            ) : showStreamBody ? (
              <box flexDirection="column" gap={0}>
                {streamSections.map((section) => {
                  const preview = buildSectionPreview(section.text, TOOL_STREAM_MAX_LINES);
                  return (
                    <box key={section.key} flexDirection="column" width="100%" paddingBottom={1}>
                      <text fg={colors.dim} content={`${section.label}${section.complete ? "" : " (streaming)"}`} />
                      <text fg={RESULT_COLOR} content={preview.text} wrapMode="char" />
                      {preview.truncated ? (
                        <text fg={colors.dim} content="(... more lines, click to open)" />
                      ) : null}
                    </box>
                  );
                })}
                {entry.toolRepairedFromPartial ? (
                  <text fg={colors.dim} content="(repaired from partial stream)" />
                ) : null}
              </box>
            ) : showInlineResult ? (
              entry.toolInlineResult!.text.startsWith("[Interrupted]") ? (
                <text fg={colors.dim} content={entry.toolInlineResult!.text} />
              ) : (
                <InlineResult
                  data={entry.toolInlineResult!}
                  colors={colors}
                  contentWidth={contentWidth - 6}
                  onOpenDetail={onEntryClick ? () => onEntryClick(entry) : undefined}
                />
              )
            ) : null}
          </box>
        </box>
      ) : null}
    </box>
  );
}

export const ToolOperationEntry = React.memo(
  ToolOperationEntryInner,
  (prev, next) =>
    prev.entry === next.entry
    && prev.colors === next.colors
    && prev.theme === next.theme
    && prev.contentWidth === next.contentWidth
    && prev.diffDisplayMode === next.diffDisplayMode,
);
