/** @jsxImportSource @opentui/react */

import React, { useMemo } from "react";

import { RGBA, StyledText, type TextChunk } from "@opentui/core";
import type { InlineResultData } from "../../presentation/types.js";
import type { ConversationPalette } from "../conversation-types.js";
import { buildToolResultArtifacts, type ToolResultLineArtifact } from "../tool-result-artifacts.js";
import { SelectableRow } from "../../display/primitives/selectable-row.js";
import { chunkDisplayWidth, createChunk } from "../syntax-highlight-utils.js";

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
  onOpenDetail?: () => void;
}

const LINE_PREFIX = "";
const MAX_LINES_PER_HUNK = 20;
const CONTEXT_LINES = 3;
const FOLD_TEXT = "... (CLICK to open)";
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
  { data, colors, contentWidth, onOpenDetail }: InlineResultProps,
): React.ReactNode {
  const artifacts = useMemo(() => {
    if (data.toolMetadata) {
      return buildToolResultArtifacts({
        text: data.text,
        dim: data.dim,
        toolMetadata: data.toolMetadata,
        wrapWidth: Math.max(8, contentWidth - 8),
        colors,
        codePreviewOnly: data.noDiffBackground,
      });
    }
    return null;
  }, [data.text, data.dim, data.toolMetadata, data.noDiffBackground, contentWidth, colors]);

  // Memoized: for a large diff this rebuilds a 1000+ element structure, and
  // without the memo it ran on every re-render of the transcript.
  const hunks = useMemo(
    () => (artifacts && artifacts.some((a) => !!a.rowBackgroundColor)
      ? splitIntoHunks(artifacts)
      : null),
    [artifacts],
  );

  if (artifacts) {
    if (hunks) {
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
          const prevIsChanged = hi > 0 && hunks[hi - 1].isChanged;
          const nextIsChanged = hi < hunks.length - 1 && hunks[hi + 1].isChanged;

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
          const hasMoreChangedHunks = hunks.slice(hi + 1).some((h) => h.isChanged);
          const clickSuffix = !hasMoreChangedHunks && onOpenDetail
            ? ", CLICK to open"
            : "";
          elements.push(
            <FoldIndicator
              key={`fold-${elementKey++}`}
              text={`${LINE_PREFIX}... (${hidden} more changed lines${clickSuffix})`}
              colors={colors}
              onClick={onOpenDetail && !hasMoreChangedHunks ? onOpenDetail : undefined}
            />,
          );
        }

        // If last hunk is changed, add trailing ⋮
        if (isLast) pushSeparator();
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

    if (data.maxLines <= 1) {
      const first = artifacts[0];
      const dimFg = RGBA.fromHex(colors.dim);
      const availableWidth = Math.max(8, contentWidth - 2);
      const truncated = truncateStyledText(first.content, availableWidth, dimFg);
      const wasTruncated = truncated !== first.content;
      const moreCount = artifacts.length - 1;
      const hasMore = moreCount > 0 || wasTruncated || data.truncated === true;
      const foldText = moreCount > 0
        ? `${LINE_PREFIX}... (${moreCount} more ${moreCount === 1 ? "line" : "lines"}${onOpenDetail ? ", CLICK to open" : ""})`
        : `${LINE_PREFIX}${FOLD_TEXT}`;

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
              onClick={onOpenDetail}
            />
          )}
        </box>
      );
    }

    const visibleArtifacts = artifacts.slice(0, data.maxLines);
    const artifactHiddenCount = Math.max(0, artifacts.length - data.maxLines);
    const hasHiddenArtifacts = artifactHiddenCount > 0 || data.truncated === true;
    const artifactFoldText = artifactHiddenCount > 0
      ? `${LINE_PREFIX}... (${artifactHiddenCount} more lines${onOpenDetail ? ", CLICK to open" : ""})`
      : `${LINE_PREFIX}${FOLD_TEXT}`;

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
            onClick={onOpenDetail}
          />
        )}
      </box>
    );
  }

  // Plain text inline result (no toolMetadata) — result body uses the
  // two-tier dim palette (darker than tool call args).
  const textColor = data.dim ? colors.dim : "#5a6078";
  const lines = data.text.split("\n");

  if (data.maxLines <= 1 && lines.length > 0) {
    const firstLine = lines[0] || "";
    const availableWidth = Math.max(8, contentWidth - 2);
    const truncated = truncateString(firstLine, availableWidth);
    const wasTruncated = truncated !== firstLine;
    const moreCount = lines.length - 1;
    const hasMore = moreCount > 0 || wasTruncated || data.truncated === true;
    const foldText = moreCount > 0
      ? `${LINE_PREFIX}... (${moreCount} more ${moreCount === 1 ? "line" : "lines"}${onOpenDetail ? ", CLICK to open" : ""})`
      : `${LINE_PREFIX}${FOLD_TEXT}`;

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
            onClick={onOpenDetail}
          />
        )}
      </box>
    );
  }

  const visibleLines = lines.slice(0, data.maxLines);
  const hiddenCount = Math.max(0, lines.length - data.maxLines);
  const hasHiddenLines = hiddenCount > 0 || data.truncated === true;
  const foldText = hiddenCount > 0
    ? `${LINE_PREFIX}... (${hiddenCount} more lines${onOpenDetail ? ", CLICK to open" : ""})`
    : `${LINE_PREFIX}${FOLD_TEXT}`;

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
          onClick={onOpenDetail}
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
    && prev.onOpenDetail === next.onOpenDetail,
);
