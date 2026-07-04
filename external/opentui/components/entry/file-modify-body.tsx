/** @jsxImportSource @opentui/react */

/**
 * Unified file-modify body — renders identically during streaming and after completion.
 *
 * Input: FileModifyDisplayData (shared type from src/lib/diff-hunk.ts)
 *
 * Modes:
 *   replace — DiffHunk[]: contextBefore + red lines + green lines + contextAfter, with ⋮
 *   append  — DiffHunk[]: ⋮ top + green lines (no ⋮ bottom)
 *   write   — writeLines: syntax-highlighted code lines with line numbers (no ⋮)
 *
 * Two-pass rendering (perf): a cheap structural pass turns the data into
 * `LineDescriptor[]` (line numbers, signs, ellipsis, raw payload text — NO
 * syntax highlighting), and an expensive `materializeDescriptor` pass builds
 * the highlighted `StyledText` only for the lines actually displayed. The
 * detail tab drives a scroll-window so a 400-line streaming write only
 * highlights + reconciles the ~viewport rows instead of the whole file on
 * every streamed delta. Inline previews materialize only the trailing window.
 */

import React, { useMemo } from "react";

import { RGBA, StyledText, type TextChunk } from "@opentui/core";
import { highlightToChunks } from "../../forked/patch-opentui-markdown.js";
import type { FileModifyDisplayData } from "../../../../src/lib/diff-hunk.js";
import type { ConversationPalette } from "../conversation-types.js";
import { SelectableRow } from "../../display/primitives/selectable-row.js";
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
    // Additions can extend beyond deletions (e.g. append hunks)
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

function buildAppendDescriptors(
  data: FileModifyDisplayData,
  colors: ConversationPalette,
): LineDescriptor[] {
  const dimFg = RGBA.fromHex(colors.dim);
  const greenFg = RGBA.fromHex(colors.text);
  const language = data.language;

  if (data.hunks.length === 0) return [];
  const hunk = data.hunks[0];

  const lines = hunk.additions;
  const startLine = hunk.startLine;
  const maxLineNo = startLine + lines.length - 1;
  const numW = startLine > 0 ? Math.max(String(maxLineNo).length, 2) : 0;

  const descriptors: LineDescriptor[] = [];

  // ⋮ top: always (there's existing file content above)
  descriptors.push(ellipsisDescriptor(numW, dimFg));

  for (let idx = 0; idx < lines.length; idx++) {
    const ln = startLine && numW ? `${lineNumStr(startLine + idx, numW)} ` : "";
    descriptors.push({
      prefixChunks: [
        createChunk(ln, { fg: dimFg }),
        createChunk("+", { fg: greenFg }),
      ],
      payloadText: lines[idx],
      payloadFallbackFg: greenFg,
      payloadBrightness: DIFF_BRIGHTNESS_ADDITION,
      language,
      rowBackgroundColor: colors.diffAdditionBg,
    });
  }

  // No ⋮ bottom — append content IS the end of the file

  return descriptors;
}

function buildWriteDescriptors(
  data: FileModifyDisplayData,
  colors: ConversationPalette,
): LineDescriptor[] {
  const textFg = RGBA.fromHex(colors.text);
  const dimFg = RGBA.fromHex(colors.dim);
  const language = data.language;

  const lines = data.writeLines ?? [];
  if (lines.length === 0) return [];

  const numW = Math.max(String(lines.length).length, 2);

  // No ⋮ — write shows the full file content
  // No brightness boost — this is neutral file content, not a diff addition
  return lines.map((line, idx) => ({
    prefixChunks: [createChunk(`${lineNumStr(idx + 1, numW)} `, { fg: dimFg })],
    payloadText: line,
    payloadFallbackFg: textFg,
    language,
  }));
}

/** Cheap structural pass — turns display data into row descriptors (no highlighting). */
export function buildLineDescriptors(
  data: FileModifyDisplayData,
  colors: ConversationPalette,
): LineDescriptor[] {
  switch (data.mode) {
    case "replace": return buildReplaceDescriptors(data, colors);
    case "append": return buildAppendDescriptors(data, colors);
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

/**
 * Full materialize (all rows) — used by tests as the equivalence oracle for
 * the windowed render: `materializeRange(descs, a, b)` must byte-match
 * `materializeAll(descs).slice(a, b)`.
 */
export function materializeDescriptors(
  descriptors: LineDescriptor[],
  colors: ConversationPalette,
  contentWidth: number,
  start = 0,
  end = descriptors.length,
): ToolResultLineArtifact[] {
  const dimFg = RGBA.fromHex(colors.dim);
  const lo = Math.max(0, Math.min(start, descriptors.length));
  const hi = Math.max(lo, Math.min(end, descriptors.length));
  const out: ToolResultLineArtifact[] = [];
  for (let i = lo; i < hi; i++) {
    out.push(materializeDescriptor(descriptors[i], contentWidth, dimFg));
  }
  return out;
}

// ------------------------------------------------------------------
// Component
// ------------------------------------------------------------------

interface FileModifyBodyProps {
  data: FileModifyDisplayData;
  colors: ConversationPalette;
  contentWidth: number;
  streaming: boolean;
  /** Inline mode: render only the trailing N rows (default 25). Ignored when `window` is set. */
  maxVisibleLines?: number;
  /**
   * Detail (virtualized) mode: render only rows in `[start, end)`, padded with
   * spacer boxes above/below so the scrollbar geometry stays correct. The
   * caller (detail tab) computes this window from the live scroll offset.
   */
  window?: { start: number; end: number };
  onOpenDetail?: () => void;
}

function FileModifyBodyInner({
  data,
  colors,
  contentWidth,
  maxVisibleLines = DEFAULT_MAX_VISIBLE,
  window,
  onOpenDetail,
}: FileModifyBodyProps): React.ReactNode {
  const descriptors = useMemo(() => buildLineDescriptors(data, colors), [data, colors]);
  const dimFg = useMemo(() => RGBA.fromHex(colors.dim), [colors.dim]);
  const total = descriptors.length;

  const virtualized = window != null;
  const start = virtualized
    ? Math.max(0, Math.min(window.start, total))
    : Math.max(0, total - maxVisibleLines);
  const end = virtualized
    ? Math.max(start, Math.min(window.end, total))
    : total;

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

  if (virtualized) {
    const topSpacer = start;
    const bottomSpacer = total - end;
    return (
      <box flexDirection="column" gap={0}>
        {topSpacer > 0 ? <box height={topSpacer} flexShrink={0} /> : null}
        {rows}
        {bottomSpacer > 0 ? <box height={bottomSpacer} flexShrink={0} /> : null}
      </box>
    );
  }

  const overflowCount = start;
  return (
    <box flexDirection="column" gap={0}>
      {overflowCount > 0 ? (
        <SelectableRow
          hoverBackgroundColor={colors.border}
          onPress={onOpenDetail}
        >
          <text fg={colors.dim} content={`...(${overflowCount} earlier lines${onOpenDetail ? ", CLICK to open" : ""})`} />
        </SelectableRow>
      ) : null}
      {rows}
    </box>
  );
}

export const FileModifyBody = React.memo(
  FileModifyBodyInner,
  (prev, next) =>
    prev.data === next.data
    && prev.colors === next.colors
    && prev.contentWidth === next.contentWidth
    && prev.streaming === next.streaming
    && prev.maxVisibleLines === next.maxVisibleLines
    && prev.onOpenDetail === next.onOpenDetail
    && prev.window?.start === next.window?.start
    && prev.window?.end === next.window?.end,
);
