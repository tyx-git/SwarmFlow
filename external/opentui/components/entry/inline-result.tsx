/** @jsxImportSource @opentui/react */

import React, { useMemo } from "react";

import { RGBA, StyledText, type TextChunk } from "@opentui/core";
import type { InlineResultData } from "../../presentation/types.js";
import type { ConversationPalette } from "../conversation-types.js";
import { buildToolResultArtifacts, type ToolResultLineArtifact } from "../tool-result-artifacts.js";
import { SelectableRow } from "../../display/primitives/selectable-row.js";
import { chunkDisplayWidth, createChunk } from "../syntax-highlight-utils.js";
import { CommandText } from "./command-text.js";
import { INLINE_EXPANSION_ELLIPSIS, INLINE_EXPANSION_MAX_LINES } from "./inline-expansion.js";

/** Clickable fold indicator with hover highlight. */
function FoldIndicator(
  { text, colors, onClick }: { text: string; colors: ConversationPalette; onClick?: () => void },
): React.ReactNode {
  return (
    <SelectableRow
      hoverBackgroundColor={colors.border}
      onPress={onClick}
    >
      <text fg={colors.dim} content={text} />
    </SelectableRow>
  );
}

interface InlineResultProps {
  data: InlineResultData;
  colors: ConversationPalette;
  contentWidth: number;
  language?: string;
  syntaxMode?: "command" | "output";
  expanded?: boolean;
  fullText?: string;
  onToggleExpand?: () => void;
}

const LINE_PREFIX = "";
const MAX_LINES_PER_HUNK = 20;
const CONTEXT_LINES = 3;
const ELLIPSIS = "\u2026";

/** Sum display widths of all chunks in a StyledText. */
function styledTextWidth(st: StyledText): number {
  let w = 0;
  for (const chunk of st.chunks) {
    w += chunkDisplayWidth(chunk.text);
  }
  return w;
}

/** Truncate a StyledText to fit within maxWidth, appending an ellipsis character. */
function truncateStyledText(st: StyledText, maxWidth: number, ellipsisFg: RGBA): StyledText {
  const total = styledTextWidth(st);
  if (total <= maxWidth) return st;

  const target = maxWidth - 1; // reserve 1 for ellipsis
  const newChunks: TextChunk[] = [];
  let used = 0;

  for (const chunk of st.chunks) {
    const cw = chunkDisplayWidth(chunk.text);
    if (used + cw <= target) {
      newChunks.push(chunk);
      used += cw;
    } else {
      const remaining = target - used;
      if (remaining > 0) {
        let truncText = "";
        let truncW = 0;
        for (const ch of chunk.text) {
          const charW = chunkDisplayWidth(ch);
          if (truncW + charW > remaining) break;
          truncText += ch;
          truncW += charW;
        }
        if (truncText) {
          newChunks.push({ ...chunk, text: truncText });
        }
      }
      newChunks.push(createChunk(ELLIPSIS, { fg: ellipsisFg }));
      return new StyledText(newChunks);
    }
  }

  // Should not reach here (total > maxWidth but couldn't fit ellipsis — very narrow)
  newChunks.push(createChunk(ELLIPSIS, { fg: ellipsisFg }));
  return new StyledText(newChunks);
}

/** Truncate a plain string to fit within maxWidth, appending "…". */
function truncateString(s: string, maxWidth: number): string {
  const total = chunkDisplayWidth(s);
  if (total <= maxWidth) return s;

  const target = maxWidth - 1;
  let result = "";
  let used = 0;
  for (const ch of s) {
    const charW = chunkDisplayWidth(ch);
    if (used + charW > target) break;
    result += ch;
    used += charW;
  }
  return result + ELLIPSIS;
}



interface Hunk {
  artifacts: ToolResultLineArtifact[];
  isChanged: boolean;
}

/**
 * Split artifacts into hunks. A "changed" hunk contains lines with row
 * background color (additions/deletions). Consecutive unchanged context
 * lines form a separate "unchanged" hunk.
 */
function splitIntoHunks(artifacts: ToolResultLineArtifact[]): Hunk[] {
  const hunks: Hunk[] = [];
  let current: ToolResultLineArtifact[] = [];
  let currentIsChanged = false;

  for (const artifact of artifacts) {
    const isChanged = !!artifact.rowBackgroundColor;
    if (current.length > 0 && isChanged !== currentIsChanged) {
      hunks.push({ artifacts: current, isChanged: currentIsChanged });
      current = [];
    }
    currentIsChanged = isChanged;
    current.push(artifact);
  }
  if (current.length > 0) {
    hunks.push({ artifacts: current, isChanged: currentIsChanged });
  }
  return hunks;
}

function InlineResultInner(
  { data, colors, contentWidth, language, syntaxMode, expanded = false, fullText, onToggleExpand }: InlineResultProps,
): React.ReactNode {
  const displayExpanded = expanded;
  const text = displayExpanded && fullText !== undefined ? fullText : data.text;
  const lineLimit = displayExpanded
    ? INLINE_EXPANSION_MAX_LINES
    : Math.min(INLINE_EXPANSION_MAX_LINES, Math.max(1, data.maxLines));
  const unknownRemainder = data.truncated === true && !(displayExpanded && fullText !== undefined);

  const artifacts = useMemo(() => {
    if (data.toolMetadata) {
      return buildToolResultArtifacts({
        text,
        dim: data.dim,
        toolMetadata: data.toolMetadata,
        wrapWidth: Math.max(8, contentWidth - 8),
        colors,
        codePreviewOnly: data.noDiffBackground,
      });
    }
    return null;
  }, [text, data.dim, data.toolMetadata, data.noDiffBackground, contentWidth, colors]);

  // Memoized: for a large diff this rebuilds a 1000+ element structure, and
  // without the memo it ran on every re-render of the transcript.
  const hunks = useMemo(
    () => (artifacts && artifacts.some((a) => !!a.rowBackgroundColor)
      ? splitIntoHunks(artifacts.slice(0, INLINE_EXPANSION_MAX_LINES))
      : null),
    [artifacts],
  );

  // 命令和源码输出预览需要绕过通用 metadata/diff 分支，
  // 否则工具结果的弱化样式会覆盖语法高亮文本。
  if (language || syntaxMode) {
    const lines = text.split("\n");
    const visibleLines = lines.slice(0, lineLimit);
    const hiddenCount = Math.max(0, lines.length - visibleLines.length);
    const hasRemainder = hiddenCount > 0 || unknownRemainder;
    return (
      <box flexDirection="column" gap={0}>
        {visibleLines.map((line, idx) => (
          <CommandText
            key={idx}
            text={line}
            colors={colors}
            mode={syntaxMode ?? "output"}
            language={language}
            fallbackColor={data.dim ? colors.dim : colors.toolResultBody}
            wrapMode="char"
          />
        ))}
        {hasRemainder ? (
          <FoldIndicator
            text={displayExpanded
              ? INLINE_EXPANSION_ELLIPSIS
              : hiddenCount > 0
                ? `${LINE_PREFIX}... (${hiddenCount} more lines${onToggleExpand ? ", CLICK to expand" : ""})`
                : INLINE_EXPANSION_ELLIPSIS}
            colors={colors}
            onClick={!displayExpanded && (hiddenCount > 0 || unknownRemainder) ? onToggleExpand : undefined}
          />
        ) : null}
      </box>
    );
  }

  if (artifacts) {
    if (hunks) {
      if (displayExpanded) {
        const visibleArtifacts = artifacts.slice(0, INLINE_EXPANSION_MAX_LINES);
        return (
          <box flexDirection="column" gap={0}>
            {visibleArtifacts.map((artifact, idx) => (
              <box key={idx} flexDirection="row" width="100%" backgroundColor={artifact.rowBackgroundColor}>
                <text fg={colors.dim} content={LINE_PREFIX} />
                <text content={artifact.content} wrapMode="none" />
              </box>
            ))}
            {artifacts.length > visibleArtifacts.length || unknownRemainder
              ? <text fg={colors.dim} content={INLINE_EXPANSION_ELLIPSIS} />
              : null}
          </box>
        );
      }
      const elements: React.ReactNode[] = [];
      let elementKey = 0;

      const pushSeparator = () => {
        elements.push(
          <box key={`sep-${elementKey++}`} flexDirection="row" width="100%">
            <text fg={colors.dim} content={`${LINE_PREFIX}⋮`} />
          </box>,
        );
      };

      const pushArtifact = (artifact: ToolResultLineArtifact) => {
        elements.push(
          <box
            key={`a-${elementKey++}`}
            flexDirection="row"
            width="100%"
            backgroundColor={artifact.rowBackgroundColor}
          >
            <text fg={colors.dim} content={LINE_PREFIX} />
            <text content={artifact.content} wrapMode="none" />
          </box>,
        );
      };

      for (let hi = 0; hi < hunks.length; hi++) {
        const hunk = hunks[hi];
        const isFirst = hi === 0;
        const isLast = hi === hunks.length - 1;

        if (!hunk.isChanged) {
          // Unchanged context hunk: show up to CONTEXT_LINES at each edge
          const n = hunk.artifacts.length;
          if (isFirst) {
            // Leading context: ⋮ then last CONTEXT_LINES
            pushSeparator();
            const start = Math.max(0, n - CONTEXT_LINES);
            for (let j = start; j < n; j++) pushArtifact(hunk.artifacts[j]);
          } else if (isLast) {
            // Trailing context: first CONTEXT_LINES then ⋮
            const end = Math.min(n, CONTEXT_LINES);
            for (let j = 0; j < end; j++) pushArtifact(hunk.artifacts[j]);
            pushSeparator();
          } else if (n <= CONTEXT_LINES * 2) {
            // Between two changed hunks, small gap: show all
            for (const a of hunk.artifacts) pushArtifact(a);
          } else {
            // Between two changed hunks, large gap: first N + ⋮ + last N
            for (let j = 0; j < CONTEXT_LINES; j++) pushArtifact(hunk.artifacts[j]);
            pushSeparator();
            for (let j = n - CONTEXT_LINES; j < n; j++) pushArtifact(hunk.artifacts[j]);
          }
          continue;
        }

        // If first hunk is changed, add leading ⋮
        if (isFirst) pushSeparator();

        // Changed hunk: truncate at MAX_LINES_PER_HUNK
        const visible = hunk.artifacts.slice(0, MAX_LINES_PER_HUNK);
        const hidden = hunk.artifacts.length - visible.length;

        for (const artifact of visible) pushArtifact(artifact);

        if (hidden > 0) {
          const clickSuffix = onToggleExpand
            ? ", CLICK to expand"
            : "";
          elements.push(
            <FoldIndicator
              key={`fold-${elementKey++}`}
              text={`${LINE_PREFIX}... (${hidden} more changed lines${clickSuffix})`}
              colors={colors}
              onClick={onToggleExpand}
            />,
          );
        }

        // If last hunk is changed, add trailing ⋮
        if (isLast) pushSeparator();
      }

      if (artifacts.length > INLINE_EXPANSION_MAX_LINES || unknownRemainder) {
        elements.push(
          <FoldIndicator
            key={`fold-${elementKey++}`}
            text={displayExpanded ? INLINE_EXPANSION_ELLIPSIS : `${INLINE_EXPANSION_ELLIPSIS} (click to expand)`}
            colors={colors}
            onClick={!displayExpanded ? onToggleExpand : undefined}
          />,
        );
      }

      return (
        <box flexDirection="column" gap={0}>
          {elements}
        </box>
      );
    }

    // Non-diff artifacts (plain tool result with metadata, or Create/Overwrite with stripped bg)
    if (artifacts.length === 0) {
      return <box flexDirection="column" gap={0} />;
    }

    if (!displayExpanded && data.maxLines <= 1) {
      const first = artifacts[0];
      const dimFg = RGBA.fromHex(colors.dim);
      const availableWidth = Math.max(8, contentWidth - 2);
      const truncated = truncateStyledText(first.content, availableWidth, dimFg);
      const wasTruncated = truncated !== first.content;
      const moreCount = artifacts.length - 1;
      const hasMore = moreCount > 0 || wasTruncated || unknownRemainder;
      const foldText = moreCount > 0
        ? `${LINE_PREFIX}... (${moreCount} more ${moreCount === 1 ? "line" : "lines"}${onToggleExpand ? ", CLICK to expand" : ""})`
        : unknownRemainder ? INLINE_EXPANSION_ELLIPSIS : `${LINE_PREFIX}...`;

      return (
        <box flexDirection="column" gap={0}>
          <box
            flexDirection="row"
            width="100%"
            backgroundColor={first.rowBackgroundColor}
          >
            <text fg={colors.dim} content={LINE_PREFIX} />
            <text content={truncated} wrapMode="none" />
          </box>
          {hasMore && (
            <FoldIndicator
              text={foldText}
              colors={colors}
              onClick={moreCount > 0 || unknownRemainder ? onToggleExpand : undefined}
            />
          )}
        </box>
      );
    }

    const visibleArtifacts = artifacts.slice(0, lineLimit);
    const artifactHiddenCount = Math.max(0, artifacts.length - visibleArtifacts.length);
    const hasHiddenArtifacts = artifactHiddenCount > 0 || unknownRemainder;
    const artifactFoldText = artifactHiddenCount > 0
      ? displayExpanded
        ? INLINE_EXPANSION_ELLIPSIS
        : `${LINE_PREFIX}... (${artifactHiddenCount} more lines${onToggleExpand ? ", CLICK to expand" : ""})`
      : INLINE_EXPANSION_ELLIPSIS;

    return (
      <box flexDirection="column" gap={0}>
        {visibleArtifacts.map((artifact, idx) => (
          <box
            key={idx}
            flexDirection="row"
            width="100%"
            backgroundColor={artifact.rowBackgroundColor}
          >
            <text
              fg={colors.dim}
              content={LINE_PREFIX}
            />
            <text content={artifact.content} wrapMode="none" />
          </box>
        ))}
        {hasHiddenArtifacts && (
          <FoldIndicator
            text={artifactFoldText}
            colors={colors}
            onClick={!displayExpanded && (artifactHiddenCount > 0 || unknownRemainder) ? onToggleExpand : undefined}
          />
        )}
      </box>
    );
  }

  // Plain text inline result (no toolMetadata) — result body uses the
  // two-tier dim palette (darker than tool call args).
  const textColor = data.dim ? colors.dim : colors.toolResultBody;
  const lines = text.split("\n");

  if (!displayExpanded && data.maxLines <= 1 && lines.length > 0) {
    const firstLine = lines[0] || "";
    const availableWidth = Math.max(8, contentWidth - 2);
    const truncated = truncateString(firstLine, availableWidth);
    const wasTruncated = truncated !== firstLine;
    const moreCount = lines.length - 1;
    const hasMore = moreCount > 0 || wasTruncated || unknownRemainder;
    const foldText = moreCount > 0
      ? `${LINE_PREFIX}... (${moreCount} more ${moreCount === 1 ? "line" : "lines"}${onToggleExpand ? ", CLICK to expand" : ""})`
      : unknownRemainder ? INLINE_EXPANSION_ELLIPSIS : `${LINE_PREFIX}...`;

    return (
      <box flexDirection="column" gap={0}>
        <box flexDirection="row" width="100%">
          <text fg={colors.dim} content={LINE_PREFIX} />
          <text fg={textColor} content={truncated} wrapMode="none" />
        </box>
        {hasMore && (
          <FoldIndicator
            text={foldText}
            colors={colors}
            onClick={moreCount > 0 || unknownRemainder ? onToggleExpand : undefined}
          />
        )}
      </box>
    );
  }

  const visibleLines = lines.slice(0, lineLimit);
  const hiddenCount = Math.max(0, lines.length - visibleLines.length);
  const hasHiddenLines = hiddenCount > 0 || unknownRemainder;
  const foldText = hiddenCount > 0
    ? displayExpanded
      ? INLINE_EXPANSION_ELLIPSIS
      : `${LINE_PREFIX}... (${hiddenCount} more lines${onToggleExpand ? ", CLICK to expand" : ""})`
    : INLINE_EXPANSION_ELLIPSIS;

  return (
    <box flexDirection="column" gap={0}>
      {visibleLines.map((line, idx) => (
        <box key={idx} flexDirection="row" width="100%">
          <text
            fg={colors.dim}
            content={LINE_PREFIX}
          />
          <text fg={textColor} content={line} wrapMode="none" />
        </box>
      ))}
      {hasHiddenLines && (
        <FoldIndicator
          text={foldText}
          colors={colors}
          onClick={!displayExpanded && (hiddenCount > 0 || unknownRemainder) ? onToggleExpand : undefined}
        />
      )}
    </box>
  );
}

export const InlineResult = React.memo(
  InlineResultInner,
  (prev, next) =>
    prev.data === next.data
    && prev.colors === next.colors
    && prev.contentWidth === next.contentWidth
    && prev.expanded === next.expanded
    && prev.fullText === next.fullText
    && prev.onToggleExpand === next.onToggleExpand,
);
