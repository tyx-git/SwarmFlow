/**
 * @file 附件领域：引用解析、扫描、读取摘要与上下文块渲染。
 */

import path from "node:path";
import type { FileInfo } from "./types.js";
import { PREVIEW_CHAR_LIMIT, CODE_LINE_LIMIT } from "./file-kinds.js";

export function formatContextBlock(files: FileInfo[]): string {
  const entries: string[] = [];

  for (let idx = 0; idx < files.length; idx++) {
    const fi = files[idx];
    const num = idx + 1;

    if (!fi.exists) {
      entries.push(
        `[${num}] ${fi.path}\n\u26a0 ${fi.error || "File not found."}`,
      );
      continue;
    }

    if (fi.error) {
      entries.push(`[${num}] ${fi.path}\n\u26a0 ${fi.error}`);
      continue;
    }

    const sizeMB = (fi.sizeBytes / (1024 * 1024)).toFixed(1);

    if (fi.isImage) {
      entries.push(
        `[${num}] ${fi.path} (image, ${sizeMB} MB)\n${fi.content}`,
      );
    } else if (fi.projectedDocumentType) {
      const docLabel = fi.projectedDocumentType.toUpperCase();
      if (fi.isPreview) {
        const shown = Math.min(PREVIEW_CHAR_LIMIT, fi.charCount);
        const pct = fi.charCount
          ? Math.round((shown / fi.charCount) * 100)
          : 0;
        const previewLines = fi.content.split("\n").length;
        const continueHint =
          `\nUse read_file on the original path (${fi.path}) with start_line=${previewLines + 1} to continue reading.`;
        entries.push(
          `[${num}] ${fi.path} (${docLabel}, ${sizeMB} MB; auto-extracted Markdown view, ${fi.charCount} chars, ${fi.lineCount} lines)\n` +
            `Preview (first ${shown}/${fi.charCount} chars(${pct}%), through line ${previewLines} of ${fi.lineCount}):\n${fi.content}\n...${continueHint}`,
        );
      } else {
        entries.push(
          `[${num}] ${fi.path} (${docLabel}, ${sizeMB} MB; auto-extracted Markdown view, ${fi.charCount} chars, ${fi.lineCount} lines)\n` +
            `Full extracted content:\n${fi.content}`,
        );
      }
    } else if (fi.isBinary) {
      entries.push(
        `[${num}] ${fi.path} (binary, ${sizeMB} MB)\n${fi.content}`,
      );
    } else if (fi.isPreview) {
      let hint: string;
      const previewLines = fi.content.split("\n").length;
      if (fi.isCode) {
        const shown = Math.min(CODE_LINE_LIMIT, fi.lineCount);
        const pct = fi.lineCount
          ? Math.round((shown / fi.lineCount) * 100)
          : 0;
        hint = `first ${shown}/${fi.lineCount} lines(${pct}%), through line ${previewLines} of ${fi.lineCount}. Use read_file with start_line=${previewLines + 1} to continue.`;
      } else {
        const shown = Math.min(PREVIEW_CHAR_LIMIT, fi.charCount);
        const pct = fi.charCount
          ? Math.round((shown / fi.charCount) * 100)
          : 0;
        hint = `first ${shown}/${fi.charCount} chars(${pct}%), through line ${previewLines} of ${fi.lineCount}. Use read_file with start_line=${previewLines + 1} to continue.`;
      }
      entries.push(
        `[${num}] ${fi.path} (${fi.charCount} chars, ${fi.lineCount} lines)\n` +
          `Preview (${hint}):\n${fi.content}\n...`,
      );
    } else {
      entries.push(
        `[${num}] ${fi.path} (${fi.charCount} chars, ${fi.lineCount} lines)\n` +
          `Full content:\n${fi.content}`,
      );
    }
  }

  return entries.join("\n\n");
}

