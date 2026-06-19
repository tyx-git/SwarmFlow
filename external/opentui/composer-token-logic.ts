import stringWidth from "string-width";

export type ComposerTokenKind = "file" | "paste" | "image";

export interface ComposerTokenMetadata {
  kind: ComposerTokenKind;
  label: string;
  submitText: string;
  path?: string;
  index?: number;
  lineCount?: number;
  imageId?: string;
}

export interface ComposerTokenSnapshot extends ComposerTokenMetadata {
  id: number;
  start: number;
  end: number;
}

export interface TextDiffRange {
  startJs: number;
  endBeforeJs: number;
  endAfterJs: number;
  removedText: string;
  insertedText: string;
  startOffset: number;
  endAfterOffset: number;
}

export interface FileReferenceQuery {
  prefix: string;
  startOffset: number;
  endOffset: number;
}

export interface DisplaySpan {
  text: string;
  startOffset: number;
  endOffset: number;
}

interface DisplaySegment {
  text: string;
  startOffset: number;
  endOffset: number;
}

const DEFAULT_TAB_WIDTH = 2;
const graphemeSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

function segmentDisplayWidth(segment: string): number {
  if (segment === "\n") return 1;
  if (segment === "\t") return DEFAULT_TAB_WIDTH;
  return stringWidth(segment);
}

function* iterateDisplaySegments(text: string): Generator<DisplaySegment> {
  let offset = 0;

  if (graphemeSegmenter) {
    for (const entry of graphemeSegmenter.segment(text)) {
      const width = segmentDisplayWidth(entry.segment);
      yield {
        text: entry.segment,
        startOffset: offset,
        endOffset: offset + width,
      };
      offset += width;
    }
    return;
  }

  for (const segment of Array.from(text)) {
    const width = segmentDisplayWidth(segment);
    yield {
      text: segment,
      startOffset: offset,
      endOffset: offset + width,
    };
    offset += width;
  }
}

export function displayWidthWithNewlines(text: string): number {
  let width = 0;
  for (const segment of iterateDisplaySegments(text)) {
    width += segment.endOffset - segment.startOffset;
  }
  return width;
}

export function getTextDiffRange(before: string, after: string): TextDiffRange | null {
  if (before === after) return null;

  let startJs = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (startJs < maxPrefix && before[startJs] === after[startJs]) {
    startJs += 1;
  }

  let beforeTail = before.length;
  let afterTail = after.length;
  while (
    beforeTail > startJs &&
    afterTail > startJs &&
    before[beforeTail - 1] === after[afterTail - 1]
  ) {
    beforeTail -= 1;
    afterTail -= 1;
  }

  return {
    startJs,
    endBeforeJs: beforeTail,
    endAfterJs: afterTail,
    removedText: before.slice(startJs, beforeTail),
    insertedText: after.slice(startJs, afterTail),
    startOffset: displayWidthWithNewlines(after.slice(0, startJs)),
    endAfterOffset: displayWidthWithNewlines(after.slice(0, afterTail)),
  };
}

export function buildFileReferenceLabel(candidate: string): string {
  return candidate.includes(" ") ? `@"${candidate}"` : `@${candidate}`;
}

export function sliceTextByOffset(text: string, startOffset: number, endOffset: number): string {
  if (endOffset <= startOffset) return "";

  let output = "";

  for (const segment of iterateDisplaySegments(text)) {
    if (segment.endOffset <= startOffset) continue;
    if (segment.startOffset >= endOffset) break;
    output += segment.text;
  }

  return output;
}

export function findFileReferenceQuery(text: string, cursorOffset: number): FileReferenceQuery | null {
  const beforeCursor = sliceTextByOffset(text, 0, cursorOffset);
  const atIdx = beforeCursor.lastIndexOf("@");
  if (atIdx < 0) return null;

  const beforeAt = atIdx === 0 ? "" : beforeCursor[atIdx - 1] ?? "";
  if (atIdx !== 0 && beforeAt !== " " && beforeAt !== "\t" && beforeAt !== "\n") {
    return null;
  }

  const prefix = beforeCursor.slice(atIdx + 1);
  if (/\s/.test(prefix)) return null;

  const afterCursor = sliceTextByOffset(text, cursorOffset, displayWidthWithNewlines(text));
  const tokenSuffix = afterCursor.match(/^[^\s]*/)?.[0] ?? "";
  const startOffset = displayWidthWithNewlines(beforeCursor.slice(0, atIdx));
  const endOffset = cursorOffset + displayWidthWithNewlines(tokenSuffix);

  return {
    prefix,
    startOffset,
    endOffset,
  };
}

export function getDisplaySpanEndingAtOffset(text: string, endOffset: number): DisplaySpan | null {
  for (const segment of iterateDisplaySegments(text)) {
    if (segment.endOffset === endOffset) {
      return {
        text: segment.text,
        startOffset: segment.startOffset,
        endOffset: segment.endOffset,
      };
    }
  }
  return null;
}

export function getDisplaySpanStartingAtOffset(text: string, startOffset: number): DisplaySpan | null {
  for (const segment of iterateDisplaySegments(text)) {
    if (segment.startOffset === startOffset) {
      return {
        text: segment.text,
        startOffset: segment.startOffset,
        endOffset: segment.endOffset,
      };
    }
  }
  return null;
}

export function serializeVisibleTextWithTokens(
  visibleText: string,
  tokens: Array<Pick<ComposerTokenSnapshot, "start" | "end" | "submitText">>,
): string {
  if (tokens.length === 0) return visibleText;

  const sortedTokens = [...tokens].sort((a, b) => a.start - b.start);
  const totalOffset = displayWidthWithNewlines(visibleText);
  let cursor = 0;
  let output = "";

  for (const token of sortedTokens) {
    if (token.start > cursor) {
      output += sliceTextByOffset(visibleText, cursor, token.start);
    }
    output += token.submitText;
    cursor = token.end;
  }

  if (cursor < totalOffset) {
    output += sliceTextByOffset(visibleText, cursor, totalOffset);
  }

  return output;
}
