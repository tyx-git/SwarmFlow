/**
 * DOCX 投影：段落、列表、超链接与表格转 Markdown。
 */

﻿import { createHash } from "node:crypto";

import path from "node:path";

export async function convertDocx(filePath: string): Promise<string> {
  const [{ default: mammoth }, { default: TurndownService }, { gfm }] = await Promise.all([
    import("mammoth"),
    import("turndown"),
    import("@joplin/turndown-plugin-gfm"),
  ]);
  const { value: html } = await mammoth.convertToHtml(
    { path: filePath },
    // 跳过图像负载：投影仅限文本，base64 内联会膨胀内存。
    { convertImage: mammoth.images.imgElement(async () => ({ src: "" })) },
  );
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  turndown.use(gfm);
  turndown.addRule("dropImages", { filter: "img", replacement: () => "" });
  return turndown.turndown(html);
}

// ── XLSX（zip + XML，只读投影为 markdown 表格）──

/** 内置日期格式 ID 集合 */
