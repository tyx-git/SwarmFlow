/**
 * 文档投影视图：扩展名判定、投影缓存读写与按扩展名分派转换。
 */

﻿import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { convertPdf } from "./pdf.js";
import { convertDocx } from "./docx.js";
import { convertXlsx } from "./xlsx.js";
import { convertPptx } from "./pptx.js";

export const PROJECTED_DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".pptx"]);
/** 投影缓存目录名 */
const PROJECTION_CACHE_DIR = ".document-projections";

/** 文档投影视图——投影后的文本内容 */
export interface ProjectedDocumentView {
  /** 源文件路径 */
  sourcePath: string;
  /** 源文件扩展名 */
  sourceExt: string;
  /** 投影后的文本内容 */
  text: string;
  /** 文件大小（字节） */
  sizeBytes: number;
  /** 文件修改时间（毫秒） */
  mtimeMs: number;
}

/** 标准化文档基础文件名，去除特殊字符 */
function normalizeDocBaseName(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath)) || "document";
  return base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").slice(0, 64) || "document";
}

/** 构建投影缓存文件路径 */
function buildCachePath(filePath: string, artifactsDir: string, sizeBytes: number, mtimeMs: number): string {
  const ext = path.extname(filePath).toLowerCase();
  const safeBase = normalizeDocBaseName(filePath);
  const hash = createHash("sha256")
    .update(`${filePath}:${sizeBytes}:${mtimeMs}`)
    .digest("hex")
    .slice(0, 10);
  return path.join(artifactsDir, PROJECTION_CACHE_DIR, `${safeBase}-${hash}${ext}.md`);
}

/** 检查文件路径是否为可投影的文档类型 */
export function isProjectedDocumentPath(filePath: string): boolean {
  return PROJECTED_DOCUMENT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** 获取文档投影的标签文本（大写扩展名） */
export function projectedDocumentLabel(filePath: string): string {
  return path.extname(filePath).toLowerCase().slice(1).toUpperCase() || "document";
}

// ══ 共享 Markdown 辅助函数 ═════════════════════════════════════════════════

async function convertDocument(filePath: string, ext: string): Promise<string> {
  switch (ext) {
    case ".pdf":
      return convertPdf(filePath);
    case ".docx":
      return convertDocx(filePath);
    case ".xlsx":
      return convertXlsx(filePath);
    case ".pptx":
      return convertPptx(filePath);
    default:
      throw new Error(`Unsupported projected document type: ${ext || "(no extension)"}`);
  }
}

/** 加载文档投影视图——从文件或缓存读取并转换为文本 */
export async function loadProjectedDocumentView(
  filePath: string,
  artifactsDir?: string,
): Promise<ProjectedDocumentView> {
  const ext = path.extname(filePath).toLowerCase();
  if (!PROJECTED_DOCUMENT_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported projected document type: ${ext || "(no extension)"}`);
  }

  const stat = statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }

  let cachePath: string | null = null;
  if (artifactsDir) {
    cachePath = buildCachePath(filePath, artifactsDir, stat.size, stat.mtimeMs);
    if (existsSync(cachePath)) {
      return {
        sourcePath: filePath,
        sourceExt: ext,
        text: readFileSync(cachePath, "utf-8"),
        sizeBytes: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
      };
    }
  }

  const markdown = (await convertDocument(filePath, ext)).trim();
  if (!markdown) {
    throw new Error(`${projectedDocumentLabel(filePath)} conversion produced no text.`);
  }

  if (cachePath) {
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, markdown, "utf-8");
  }

  return {
    sourcePath: filePath,
    sourceExt: ext,
    text: markdown,
    sizeBytes: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs),
  };
}
