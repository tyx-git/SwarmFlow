/**
 * @file 附件领域：引用解析、扫描、读取摘要与上下文块渲染。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { loadProjectedDocumentView, projectedDocumentLabel } from "../context/document/view.js";
import type { FileInfo } from "./types.js";
import {
  CODE_EXTENSIONS,
  CODE_LINE_LIMIT,
  PREVIEW_CHAR_LIMIT,
  MAX_IMAGE_FILE_SIZE,
  IMAGE_MEDIA_TYPES,
  MAX_TEXT_FILE_SIZE,
} from "./file-kinds.js";

export function makeFileInfo(partial: Partial<FileInfo> & { originalRef: string; path: string }): FileInfo {
  return {
    exists: false,
    isImage: false,
    isBinary: false,
    projectedDocumentType: null,
    sizeBytes: 0,
    charCount: 0,
    lineCount: 0,
    content: "",
    isPreview: false,
    isCode: false,
    error: "",
    imageData: null,
    imageMediaType: null,
    ...partial,
  };
}

export function summarizeTextContent(
  text: string,
  filePath: string,
): Pick<FileInfo, "charCount" | "lineCount" | "content" | "isPreview" | "isCode"> {
  const charCount = text.length;
  const lineCount = text === ""
    ? 0
    : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  const ext = path.extname(filePath).toLowerCase();
  const isCode = CODE_EXTENSIONS.has(ext);

  let content: string;
  let isPreview: boolean;

  if (isCode) {
    const lines = text.split("\n");
    isPreview = lines.length > CODE_LINE_LIMIT;
    content = isPreview ? lines.slice(0, CODE_LINE_LIMIT).join("\n") : text;
  } else {
    isPreview = charCount > PREVIEW_CHAR_LIMIT;
    content = isPreview ? text.slice(0, PREVIEW_CHAR_LIMIT) : text;
  }

  return {
    charCount,
    lineCount,
    content,
    isPreview,
    isCode,
  };
}

/* 处理用户输入中的@file引用的结果。 */

export async function readAndSummarize(
  filePath: string,
  isImage = false,
  isBinary = false,
  projectedDocumentType: string | null = null,
  supportsMultimodal = false,
  artifactsDir?: string,
): Promise<FileInfo> {
  const ref = filePath;

  if (!existsSync(filePath)) {
    return makeFileInfo({
      originalRef: ref,
      path: filePath,
      exists: false,
      error: "File not found.",
    });
  }

  let stat;
  try {
    stat = statSync(filePath);
  } catch (e) {
    return makeFileInfo({
      originalRef: ref,
      path: filePath,
      exists: false,
      error: `Stat error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  const size = stat.size;

  // --- Image ---
  if (isImage) {
    if (size > MAX_IMAGE_FILE_SIZE) {
      return makeFileInfo({
        originalRef: ref,
        path: filePath,
        exists: true,
        isImage: true,
        isBinary: true,
        sizeBytes: size,
        error: `Image too large (${(size / 1024 / 1024).toFixed(1)} MB, limit ${MAX_IMAGE_FILE_SIZE / 1024 / 1024} MB).`,
      });
    }

    if (supportsMultimodal) {
      try {
        const raw = readFileSync(filePath);
        const b64Data = raw.toString("base64");
        const ext = path.extname(filePath).toLowerCase();
        const mediaType = IMAGE_MEDIA_TYPES[ext] ?? "application/octet-stream";
        return makeFileInfo({
          originalRef: ref,
          path: filePath,
          exists: true,
          isImage: true,
          isBinary: true,
          sizeBytes: size,
          content: "Image file attached.",
          imageData: b64Data,
          imageMediaType: mediaType,
        });
      } catch (exc) {
        return makeFileInfo({
          originalRef: ref,
          path: filePath,
          exists: true,
          isImage: true,
          isBinary: true,
          sizeBytes: size,
          content: `Image read error: ${exc instanceof Error ? exc.message : String(exc)}`,
        });
      }
    }

    return makeFileInfo({
      originalRef: ref,
      path: filePath,
      exists: true,
      isImage: true,
      isBinary: true,
      sizeBytes: size,
      content: "Current model does not support image input.",
    });
  }

  // --- PDF ---
  if (projectedDocumentType) {
    try {
      const view = await loadProjectedDocumentView(filePath, artifactsDir);

      return makeFileInfo({
        originalRef: ref,
        path: filePath,
        exists: true,
        isBinary: true,
        projectedDocumentType,
        sizeBytes: size,
        ...summarizeTextContent(view.text, `${filePath}.md`),
      });
    } catch (exc) {
      return makeFileInfo({
        originalRef: ref,
        path: filePath,
        exists: true,
        isBinary: true,
        projectedDocumentType,
        sizeBytes: size,
        error: `${projectedDocumentLabel(filePath)} conversion failed: ${exc instanceof Error ? exc.message : String(exc)}`,
      });
    }
  }

  // ——其他二进制——
  if (isBinary) {
    return makeFileInfo({
      originalRef: ref,
      path: filePath,
      exists: true,
      isBinary: true,
      sizeBytes: size,
      content: "Binary file — path provided for reference.",
    });
  }

  // ——文本文件——
  if (size > MAX_TEXT_FILE_SIZE) {
    return makeFileInfo({
      originalRef: ref,
      path: filePath,
      exists: true,
      sizeBytes: size,
      error: `File too large (${(size / 1024 / 1024).toFixed(1)} MB, limit ${MAX_TEXT_FILE_SIZE / 1024 / 1024} MB).`,
    });
  }

  let text: string;
  try {
    text = readFileSync(filePath, { encoding: "utf-8" });
  } catch (exc) {
    return makeFileInfo({
      originalRef: ref,
      path: filePath,
      exists: true,
      error: `Read error: ${exc instanceof Error ? exc.message : String(exc)}`,
    });
  }

  return makeFileInfo({
    originalRef: ref,
    path: filePath,
    exists: true,
    sizeBytes: size,
    ...summarizeTextContent(text, filePath),
  });
}

/**
 * 将FileInfo列表格式化为编号的文本条目。
 */
