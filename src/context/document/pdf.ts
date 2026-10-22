/**
 * PDF 投影：文本抽取并拼成 Markdown。
 */

﻿import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export async function convertPdf(filePath: string): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const data = new Uint8Array(readFileSync(filePath));
  // verbosity 0 = 仅错误；抑制 pdf.js 字体警告（"TT: undefined function"）
  const pdf = await getDocumentProxy(data, { verbosity: 0 });
  // 不使用 mergePages：它会将所有空白（包括每个换行符）压缩为单个空格，
  // 将文档变成一行巨型文本，然后被 read_file 的每行上限截断。
  // 逐页提取保持 pdf.js 的 hasEOL 换行符完整；页面作为段落连接。
  const { text } = await extractText(pdf);
  return (text as string[]).map((page) => page.trim()).filter(Boolean).join("\n\n");
}

// ── DOCX（mammoth → HTML → turndown，与 markitdown 使用相同的引擎）──

