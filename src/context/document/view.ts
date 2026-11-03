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

/**
 * Word/Excel/PowerPoint 97-2003 是 OLE 复合二进制（D0 CF 11 E0），不是
 * zip+XML，投影器解不开。它们必须显式列出来：不在任何名单里就会落到
 * 「文本」分支按 UTF-8 硬读，既不报错也读不出东西。
 * modern/app 供报错文案点名转换目标与 COM 程序名，两个事实只登记在这一处。
 */
const LEGACY_DOCUMENT_CONVERSIONS: Readonly<Record<string, { modern: string; app: string }>> = {
  ".doc": { modern: "docx", app: "Word.Application" },
  ".xls": { modern: "xlsx", app: "Excel.Application" },
  ".ppt": { modern: "pptx", app: "PowerPoint.Application" },
};

/** 无法投影的 97-2003 二进制 Office 扩展名。 */
export const LEGACY_BINARY_DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.keys(LEGACY_DOCUMENT_CONVERSIONS),
);

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

/** 检查文件路径是否为无法投影的 97-2003 二进制 Office 文档。 */
export function isLegacyBinaryDocumentPath(filePath: string): boolean {
  return LEGACY_BINARY_DOCUMENT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * 面向模型的报错：说清为什么读不出来，并给出转成现代 OOXML 的两条路子，
 * 让模型自己决定是先转换还是回问用户，而不是拿一屏乱码继续。
 */
export function legacyBinaryDocumentMessage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const { modern, app } = LEGACY_DOCUMENT_CONVERSIONS[ext] ?? { modern: ext.slice(1), app: "" };
  return [
    `${filePath} is a Word/Excel/PowerPoint 97-2003 binary (OLE) file, not zip+XML, `
      + `so it cannot be projected to text and nothing was read.`,
    `Convert it to .${modern} first, then read the converted file:`,
    `  soffice --headless --convert-to ${modern} --outdir [dir] "${filePath}"`,
    `  Windows without LibreOffice: drive ${app || "Office"} through PowerShell COM and SaveAs .${modern}`,
  ].join("\n");
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
