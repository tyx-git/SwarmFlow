/**
 * @file 附件领域：引用解析、扫描、读取摘要与上下文块渲染。
 */

import path from "node:path";

import { context } from "../primitives/context.js";

// ------------------------------------------------------------------
// Data structures
// ------------------------------------------------------------------

/* 单个附加文件的元数据和内容。 */
export interface FileInfo {
  originalRef: string; // raw @reference from user input
  path: string; // resolved absolute path
  exists: boolean;
  isImage: boolean;
  isBinary: boolean;
  projectedDocumentType: string | null;
  sizeBytes: number;
  charCount: number;
  lineCount: number;
  content: string; // full content or preview
  isPreview: boolean;
  isCode: boolean;
  error: string;
  imageData: string | null; // base64-encoded image (multimodal)
  imageMediaType: string | null; // MIME type for image
}

export interface FileAttachResult {
  cleanedText: string; // user message with @refs removed
  contextStr: string; // rendered <context> block (empty if no files)
  files: FileInfo[];
  warnings: string[];
}

/* 是否附加了任何文件。 */
export function hasFiles(result: FileAttachResult): boolean {
  return result.files.length > 0;
}

/* 是否任何附加文件有base64图像数据的多模态。 */
export function hasImages(result: FileAttachResult): boolean {
  return result.files.some((f) => f.imageData !== null);
}

