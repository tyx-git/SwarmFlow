/**
 * OOXML（zip + XML）读取与 Markdown 表格拼装助手。
 */

﻿import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export function escapeTableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

export function toMarkdownTable(rows: string[][]): string {
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length), 1);
  const padded = rows.map((r) => {
    const cells = r.map(escapeTableCell);
    while (cells.length < width) cells.push("");
    return cells;
  });
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const separator = `| ${Array.from({ length: width }, () => "---").join(" | ")} |`;
  return [line(padded[0]!), separator, ...padded.slice(1).map(line)].join("\n");
}

export type XmlElement = {
  localName: string;
  textContent: string | null;
  getAttribute(name: string): string | null;
  getAttributeNS(ns: string, localName: string): string | null;
  getElementsByTagNameNS(ns: string, name: string): ArrayLike<XmlElement>;
  childNodes: ArrayLike<{ nodeType: number }>;
};

const OOXML_RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** OOXML 元素的 r:id，按命名空间解析，失败时回退到常规前缀。 */
export function relationshipId(el: XmlElement): string | null {
  return el.getAttributeNS(OOXML_RELATIONSHIPS_NS, "id") || el.getAttribute("r:id");
}

export function byLocalName(node: XmlElement, name: string): XmlElement[] {
  return Array.from(node.getElementsByTagNameNS("*", name));
}

export async function loadZipXml(filePath: string): Promise<{
  readXml: (entry: string) => Promise<XmlElement | null>;
  entryNames: string[];
}> {
  const { default: JSZip } = await import("jszip");
  const { DOMParser } = await import("@xmldom/xmldom");
  const zip = await JSZip.loadAsync(readFileSync(filePath));
  const parser = new DOMParser();
  return {
    entryNames: Object.keys(zip.files),
    readXml: async (entry: string) => {
      const file = zip.file(entry);
      if (!file) return null;
      const xml = await file.async("string");
      return parser.parseFromString(xml, "text/xml").documentElement as unknown as XmlElement;
    },
  };
}

// ── PDF（unpdf：无服务器 pdf.js 构建，无需 worker/DOM）──

/** 将 PDF 文件转换为纯文本 */
