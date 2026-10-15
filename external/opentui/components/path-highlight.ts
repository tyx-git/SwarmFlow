/**
 * 文件路径引用高亮：把 `src/a/b.ts:12`、`(/F:/proj/src/a/b.ts:12)` 这类引用染成
 * 主题的路径色，行号/列号用次级色。只改前景色，正文文本保持原样。
 */

import { RGBA, type TextChunk } from "@opentui/core";

export interface FileReference {
  /** 引用整体区间（含 `:行:列`）。 */
  start: number;
  end: number;
  /** 纯路径部分的结束偏移，`[pathEnd, end)` 即 `:行:列`。 */
  pathEnd: number;
}

const SEGMENT = String.raw`[A-Za-z0-9_+~-][A-Za-z0-9_.+~:-]*`;
const FILE_NAME = String.raw`${SEGMENT}\.[A-Za-z][A-Za-z0-9]{0,7}`;
const PATH_SOURCE = String.raw`(?:[A-Za-z]:[\\/]|[\\/])?(?:${SEGMENT}[\\/])+${FILE_NAME}`;
const LOCATOR_SOURCE = String.raw`(?::[0-9]{1,6}(?::[0-9]{1,6})?)?`;
const FILE_REFERENCE_RE = new RegExp(
  String.raw`(?<![A-Za-z0-9_.+~:-])(${PATH_SOURCE})${LOCATOR_SOURCE}(?![A-Za-z0-9_.+~:-])`,
  "g",
);
const URL_RE = /(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|mailto:|tel:)[^\s<>"'`)\]]+/g;

/** 找出文本中的文件路径引用；URL 覆盖的部分不算路径引用。 */
export function findFileReferences(text: string): FileReference[] {
  const urlRanges: Array<[number, number]> = [];
  for (const match of text.matchAll(URL_RE)) {
    urlRanges.push([match.index, match.index + match[0].length]);
  }

  const references: FileReference[] = [];
  for (const match of text.matchAll(FILE_REFERENCE_RE)) {
    const start = match.index;
    const end = start + match[0].length;
    if (urlRanges.some(([urlStart, urlEnd]) => start < urlEnd && end > urlStart)) continue;
    const pathEnd = start + match[1].length;
    if (pathEnd <= start || pathEnd > end) continue;
    references.push({ start, end, pathEnd });
  }
  return references;
}

export interface FileReferenceColors {
  pathFg: RGBA;
  lineFg: RGBA;
}

function sameColor(a: RGBA | undefined, candidates: Array<RGBA | undefined>): boolean {
  if (!a) return false;
  return candidates.some((candidate) => candidate !== undefined && a.equals(candidate));
}

/**
 * 在已经切好的 chunk 序列上补路径颜色。
 *
 * 输入文本是渲染后的可见文本（conceal 已生效），因此偏移量按 chunk 拼接结果计算；
 * `protectedColors` 命中的 chunk（行内代码、链接等）整体跳过，避免改写代码字面量。
 */
export function paintFileReferences<T extends TextChunk>(
  chunks: readonly T[],
  colors: FileReferenceColors,
  protectedColors: Array<RGBA | undefined> = [],
): T[] {
  if (chunks.length === 0) return chunks as T[];

  const offsets: number[] = [];
  let text = "";
  chunks.forEach((chunk, index) => {
    offsets[index] = text.length;
    text += chunk.text;
  });

  const protectedRanges: Array<[number, number]> = [];
  chunks.forEach((chunk, index) => {
    if (chunk.link || sameColor(chunk.fg, protectedColors)) {
      protectedRanges.push([offsets[index]!, offsets[index]! + chunk.text.length]);
    }
  });

  const paints: Array<{ start: number; end: number; fg: RGBA }> = [];
  for (const reference of findFileReferences(text)) {
    if (protectedRanges.some(([start, end]) => reference.start < end && reference.end > start)) continue;
    paints.push({ start: reference.start, end: reference.pathEnd, fg: colors.pathFg });
    if (reference.pathEnd < reference.end) {
      paints.push({ start: reference.pathEnd, end: reference.end, fg: colors.lineFg });
    }
  }
  if (paints.length === 0) return chunks as T[];

  const result: T[] = [];
  chunks.forEach((chunk, index) => {
    const chunkStart = offsets[index]!;
    const chunkEnd = chunkStart + chunk.text.length;
    const overlapping = paints
      .filter((paint) => paint.start < chunkEnd && paint.end > chunkStart)
      .sort((a, b) => a.start - b.start);
    if (overlapping.length === 0) {
      result.push(chunk);
      return;
    }

    let cursor = chunkStart;
    const emit = (from: number, to: number, fg: RGBA | undefined): void => {
      if (to <= from) return;
      result.push({ ...chunk, text: text.slice(from, to), fg });
    };

    for (const paint of overlapping) {
      const start = Math.max(paint.start, chunkStart);
      const end = Math.min(paint.end, chunkEnd);
      emit(cursor, start, chunk.fg);
      emit(start, end, paint.fg);
      cursor = end;
    }
    emit(cursor, chunkEnd, chunk.fg);
  });

  return result;
}
