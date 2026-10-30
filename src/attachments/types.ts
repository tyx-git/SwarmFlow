/** 附件数据结构：单个文件的元数据、处理结果与便捷判定。 */

import path from "node:path";

import { context } from "../primitives/context.js";

// ------------------------------------------------------------------
// 数据结构
// ------------------------------------------------------------------

/** 单个附加文件的元数据与内容。 */
export interface FileInfo {
  originalRef: string; // 用户输入中的原始 @ 引用
  path: string; // 解析后的绝对路径
  exists: boolean;
  isImage: boolean;
  isBinary: boolean;
  projectedDocumentType: string | null;
  sizeBytes: number;
  charCount: number;
  lineCount: number;
  content: string; // 完整内容或预览
  isPreview: boolean;
  isCode: boolean;
  error: string;
  imageData: string | null; // Base64 图片数据（多模态）
  imageMediaType: string | null; // 图片 MIME 类型
}

/** 附件处理结果：清理后的文本、渲染出的 `<context>` 块与文件列表。 */
export interface FileAttachResult {
  cleanedText: string; // 移除 @ 引用后的用户消息
  contextStr: string; // 渲染出的 `<context>` 块（无文件时为空）
  files: FileInfo[];
  warnings: string[];
}

/** 是否附加了任何文件。 */
export function hasFiles(result: FileAttachResult): boolean {
  return result.files.length > 0;
}

/** 是否包含带 Base64 数据的多模态图片。 */
export function hasImages(result: FileAttachResult): boolean {
  return result.files.some((f) => f.imageData !== null);
}

