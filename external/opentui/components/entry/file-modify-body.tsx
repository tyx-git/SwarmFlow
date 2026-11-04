/** @jsxImportSource @opentui/react */

/**
 * Unified file-modify body for `edit` results.
 *
 * Input: FileModifyDisplayData (shared type from src/patches/hunk.ts)
 *
 * Modes:
 *   replace — DiffHunk[]: contextBefore + red lines + green lines + contextAfter, with ⋮
 *   write   — writeLines: syntax-highlighted code lines with line numbers (no ⋮)
 *
 * Two-pass rendering (perf): a cheap structural pass turns the data into
 * `LineDescriptor[]` (line numbers, signs, ellipsis, raw payload text — NO
 * syntax highlighting), and an expensive `materializeDescriptor` pass builds
 * the highlighted `StyledText` only for the lines actually displayed.
 */

import React, { useMemo } from "react";

import { RGBA, StyledText, type TextChunk } from "@opentui/core";
import { highlightToChunks } from "../syntax-highlighter.js";
import type { FileModifyDisplayData } from "../../../../src/patches/hunk.js";
import type { ConversationPalette } from "../conversation-types.js";
import { SelectableRow } from "../../display/primitives/selectable-row.js";
import { INLINE_EXPANSION_ELLIPSIS, INLINE_EXPANSION_MAX_LINES } from "./inline-expansion.js";
import {
  DIFF_BRIGHTNESS_ADDITION,
  DIFF_BRIGHTNESS_DELETION,
  DIFF_BRIGHTNESS_CONTEXT,
  createChunk,
  cloneChunksWithBaseStyle,
  chunkDisplayWidth,
  type ToolResultLineArtifact,
} from "../syntax-highlight-utils.js";

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const DEFAULT_MAX_VISIBLE = 25;

// ------------------------------------------------------------------
// Line descriptor — cheap structural representation (no highlighting)
// ------------------------------------------------------------------

/**
 * One rendered row, before syntax highlighting. The `prefixChunks` (line
 * number + sign / ellipsis glyph) are cheap to build for every row; the
 * `payloadText` is highlighted lazily in `materializeDescriptor` only when the
 * row is actually shown. Each descriptor renders to exactly one terminal row
 * (callers use `wrapMode="none"`), so descriptor index == row index — the
 * scroll-window math relies on this.
 */
export interface LineDescriptor {
  prefixChunks: TextChunk[];
  /** Highlightable line content, or null for structural rows (ellipsis). */
  payloadText: string | null;
  payloadFallbackFg?: RGBA;
  payloadBrightness?: number;
  language?: string;
  rowBackgroundColor?: string;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function highlightLine(
  text: string,
  language: string | undefined,
  fallbackFg: RGBA,
  brightness?: number,
): TextChunk[] {
  const highlighted = language ? highlightToChunks(text, language) : null;
  if (highlighted && highlighted.length > 0) {
    return cloneChunksWithBaseStyle(highlighted, { fallbackFg, brightness });
  }
  return [createChunk(text || " ", { fg: fallbackFg })];
}

function lineNumStr(num: number, width: number): string {
  return String(num).padStart(width);
}

function lineNumBlank(width: number): string {
  return " ".repeat(width);
}

function truncateChunks(
  chunks: TextChunk[],
  maxWidth: number,
  ellipsisFg: RGBA,
): TextChunk[] {
  let totalWidth = 0;
  for (const chunk of chunks) {
    totalWidth += chunkDisplayWidth(chunk.text);
  }
  if (totalWidth <= maxWidth) return chunks;

  const result: TextChunk[] = [];
  let usedWidth = 0;
  const targetWidth = maxWidth - 1;

  for (const chunk of chunks) {
    const cw = chunkDisplayWidth(chunk.text);
    if (usedWidth + cw <= targetWidth) {
      result.push(chunk);
      usedWidth += cw;
    } else {
      const remaining = targetWidth - usedWidth;
      if (remaining > 0) {
        let truncText = "";
        let truncWidth = 0;
        for (const ch of chunk.text) {
          const charW = chunkDisplayWidth(ch);
          if (truncWidth + charW > remaining) break;
          truncText += ch;
          truncWidth += charW;
        }
        if (truncText) {
          result.push({ ...chunk, text: truncText });
        }
      }
      result.push(createChunk("…", { fg: ellipsisFg }));
      return result;
    }
  }
  return result;
}

// ------------------------------------------------------------------
// Ellipsis descriptor builder
// ------------------------------------------------------------------

function ellipsisDescriptor(numW: number, dimFg: RGBA): LineDescriptor {
  return {
    prefixChunks: [
      createChunk(numW ? `${lineNumBlank(numW)} ` : "", { fg: dimFg }),
      createChunk("⋮", { fg: dimFg }),
    ],
    payloadText: null,
  };
}

// ------------------------------------------------------------------
// Descriptor builders (cheap — no syntax highlighting)
// ------------------------------------------------------------------

function buildReplaceDescriptors(
  data: FileModifyDisplayData,
  colors: ConversationPalette,
): LineDescriptor[] {
  const dimFg = RGBA.fromHex(colors.dim);
  const redFg = RGBA.fromHex(colors.text);
  const greenFg = RGBA.fromHex(colors.text);
  const language = data.language;

  // Compute global line number column width across all hunks
  let maxLineNo = 0;
  for (const hunk of data.hunks) {
    const afterStart = hunk.startLine + hunk.deletions.length;
    const endLine = afterStart + hunk.contextAfter.length;
    if (endLine > maxLineNo) maxLineNo = endLine;
    // Additions can extend beyond deletions (e.g. add-file hunks)
    const addEnd = hunk.startLine + hunk.additions.length;
    if (addEnd > maxLineNo) maxLineNo = addEnd;
  }
  const numW = maxLineNo > 0 ? Math.max(String(maxLineNo).length, 2) : 0;

  const descriptors: LineDescriptor[] = [];

  for (let i = 0; i < data.hunks.length; i++) {
    const hunk = data.hunks[i];
    const isFirst = i === 0;
    const isLast = i === data.hunks.length - 1;

    // ⋮ top: only if there are hidden lines above
    if (isFirst) {
      const firstDisplayLine = hunk.startLine - hunk.contextBefore.length;
      if (firstDisplayLine > 1) {
        descriptors.push(ellipsisDescriptor(numW, dimFg));
      }
    } else {
      // Between hunks: only show ⋮ if there are hidden lines between them
      const prevHunk = data.hunks[i - 1];
      const prevHunkEnd = prevHunk.startLine + prevHunk.deletions.length + prevHunk.contextAfter.length;
      const currHunkStart = hunk.startLine - hunk.contextBefore.length;
      if (currHunkStart > prevHunkEnd) {
        descriptors.push(ellipsisDescriptor(numW, dimFg));
      }
    }

    // Context before
    const ctxBeforeStartLine = hunk.startLine - hunk.contextBefore.length;
    for (let j = 0; j < hunk.contextBefore.length; j++) {
      const lineNo = ctxBeforeStartLine + j;
      descriptors.push({
        prefixChunks: [
          createChunk(numW ? `${lineNumStr(lineNo, numW)} ` : "", { fg: dimFg }),
          createChunk(" ", { fg: dimFg }),
        ],
        payloadText: hunk.contextBefore[j],
        payloadFallbackFg: dimFg,
        payloadBrightness: DIFF_BRIGHTNESS_CONTEXT,
        language,
      });
    }

    // Deletions (red)
    for (let j = 0; j < hunk.deletions.length; j++) {
      const lineNo = hunk.startLine + j;
      descriptors.push({
        prefixChunks: [
          createChunk(numW ? `${lineNumStr(lineNo, numW)} ` : "", { fg: dimFg }),
          createChunk("-", { fg: redFg }),
        ],
        payloadText: hunk.deletions[j],
        payloadFallbackFg: redFg,
        payloadBrightness: DIFF_BRIGHTNESS_DELETION,
        language,
        rowBackgroundColor: colors.diffDeletionBg,
      });
    }

    // Additions (green)
    for (let j = 0; j < hunk.additions.length; j++) {
      const lineNo = hunk.startLine + j;
      descriptors.push({
        prefixChunks: [
          createChunk(numW ? `${lineNumStr(lineNo, numW)} ` : "", { fg: dimFg }),
          createChunk("+", { fg: greenFg }),
        ],
        payloadText: hunk.additions[j],
        payloadFallbackFg: greenFg,
        payloadBrightness: DIFF_BRIGHTNESS_ADDITION,
        language,
        rowBackgroundColor: colors.diffAdditionBg,
      });
    }

    // Context after
    const afterStartLine = hunk.startLine + hunk.deletions.length;
    for (let j = 0; j < hunk.contextAfter.length; j++) {
      const lineNo = afterStartLine + j;
      descriptors.push({
        prefixChunks: [
          createChunk(numW ? `${lineNumStr(lineNo, numW)} ` : "", { fg: dimFg }),
          createChunk(" ", { fg: dimFg }),
        ],
        payloadText: hunk.contextAfter[j],
        payloadFallbackFg: dimFg,
        payloadBrightness: DIFF_BRIGHTNESS_CONTEXT,
        language,
      });
    }

    // ⋮ bottom: only if there are hidden lines below
    if (isLast) {
      const lastDisplayLine = afterStartLine + hunk.contextAfter.length - 1;
      if (data.totalLineCount > 0 && lastDisplayLine < data.totalLineCount) {
        descriptors.push(ellipsisDescriptor(numW, dimFg));
      }
    }
  }

  return descriptors;
}

/**
 * 新增行描述：行号 + `+`，整行绿色底。write（Add File）使用；
 * firstLine 为 null 表示不显示行号。
 */
function buildAdditionDescriptors(
  lines: readonly string[],
  firstLine: number | null,
  numW: number,
  language: string | undefined,
  colors: ConversationPalette,
): LineDescriptor[] {
  const dimFg = RGBA.fromHex(colors.dim);
  const lineFg = RGBA.fromHex(colors.text);
  return lines.map((line, idx) => ({
    prefixChunks: [
      createChunk(firstLine === null ? "" : `${lineNumStr(firstLine + idx, numW)} `, { fg: dimFg }),
      createChunk("+", { fg: lineFg }),
    ],
    payloadText: line,
    payloadFallbackFg: lineFg,
    payloadBrightness: DIFF_BRIGHTNESS_ADDITION,
    language,
    rowBackgroundColor: colors.diffAdditionBg,
  }));
}

function buildWriteDescriptors(
  data: FileModifyDisplayData,
  colors: ConversationPalette,
): LineDescriptor[] {
  const lines = data.writeLines ?? [];
  if (lines.length === 0) return [];

  const numW = Math.max(String(lines.length).length, 2);

  // 无 ⋮ —— write 展示整份文件；每一行都按新增行渲染（绿底 + `+`），
  // 与 edit 的 additions 保持同一视觉语言。
  return buildAdditionDescriptors(lines, 1, numW, data.language, colors);
}

/** Cheap structural pass — turns display data into row descriptors (no highlighting). */
export function buildLineDescriptors(
  data: FileModifyDisplayData,
  colors: ConversationPalette,
): LineDescriptor[] {
  switch (data.mode) {
    case "replace": return buildReplaceDescriptors(data, colors);
    case "write": return buildWriteDescriptors(data, colors);
  }
}

/** Expensive pass — highlights one descriptor and builds its final StyledText row. */
export function materializeDescriptor(
  desc: LineDescriptor,
  contentWidth: number,
  dimFg: RGBA,
): ToolResultLineArtifact {
  const payload = desc.payloadText != null
    ? highlightLine(desc.payloadText, desc.language, desc.payloadFallbackFg ?? dimFg, desc.payloadBrightness)
    : [];
  let chunks = payload.length > 0 ? desc.prefixChunks.concat(payload) : desc.prefixChunks;
  if (contentWidth > 0) chunks = truncateChunks(chunks, contentWidth, dimFg);
  return { content: new StyledText(chunks), rowBackgroundColor: desc.rowBackgroundColor };
}

// ------------------------------------------------------------------
// Component
// ------------------------------------------------------------------

interface FileModifyBodyProps {
  data: FileModifyDisplayData;
  colors: ConversationPalette;
  contentWidth: number;
  /** Inline preview row count before the user expands this result. */
  maxVisibleLines?: number;
  expanded?: boolean;
  onToggleExpand?: () => void;
}

function FileModifyBodyInner({
  data,
  colors,
  contentWidth,
  maxVisibleLines = DEFAULT_MAX_VISIBLE,
  expanded = false,
  onToggleExpand,
}: FileModifyBodyProps): React.ReactNode {
  const descriptors = useMemo(() => buildLineDescriptors(data, colors), [data, colors]);
  const dimFg = useMemo(() => RGBA.fromHex(colors.dim), [colors.dim]);
  const total = descriptors.length;

  const inlineLimit = Math.min(INLINE_EXPANSION_MAX_LINES, Math.max(1, maxVisibleLines));
  const visibleCount = Math.min(total, expanded ? INLINE_EXPANSION_MAX_LINES : inlineLimit);
  const start = expanded || maxVisibleLines === Number.POSITIVE_INFINITY
    ? 0
    : Math.max(0, total - visibleCount);
  const end = Math.min(total, start + visibleCount);

  const visible = useMemo(
    () => {
      const out: ToolResultLineArtifact[] = [];
      for (let i = start; i < end; i++) {
        out.push(materializeDescriptor(descriptors[i], contentWidth, dimFg));
      }
      return out;
    },
    [descriptors, start, end, contentWidth, dimFg],
  );

  const rows = visible.map((artifact, idx) => (
    <box
      key={start + idx}
      flexDirection="row"
      width="100%"
      backgroundColor={artifact.rowBackgroundColor}
    >
      <text content={artifact.content} wrapMode="none" />
    </box>
  ));

  const overflowCount = start;
  const trailingOverflow = end < total;
  return (
    <box flexDirection="column" gap={0}>
      {overflowCount > 0 ? (
        <SelectableRow
          hoverBackgroundColor={colors.border}
          onPress={onToggleExpand}
        >
          <text fg={colors.dim} content={`... (${overflowCount} earlier lines${onToggleExpand ? ", click to expand" : ""})`} />
        </SelectableRow>
      ) : null}
      {rows}
      {expanded ? (
        <SelectableRow
          hoverBackgroundColor={colors.border}
          onPress={onToggleExpand}
        >
          <text fg={colors.dim} content={`${INLINE_EXPANSION_ELLIPSIS}${onToggleExpand ? " (click to collapse)" : ""}`} />
        </SelectableRow>
      ) : trailingOverflow ? (
        <SelectableRow hoverBackgroundColor={colors.border} onPress={onToggleExpand}>
          <text fg={colors.dim} content={`${INLINE_EXPANSION_ELLIPSIS}${onToggleExpand ? " (click to expand)" : ""}`} />
        </SelectableRow>
      ) : null}
    </box>
  );
}

export const FileModifyBody = React.memo(
  FileModifyBodyInner,
  (prev, next) =>
    prev.data === next.data
    && prev.colors === next.colors
    && prev.contentWidth === next.contentWidth
    && prev.maxVisibleLines === next.maxVisibleLines
    && prev.expanded === next.expanded
    && prev.onToggleExpand === next.onToggleExpand,
);
