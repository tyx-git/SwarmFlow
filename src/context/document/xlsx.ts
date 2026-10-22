/**
 * XLSX 投影：共享字符串、单元格样式日期判定与工作表转 Markdown。
 */

﻿import { createHash } from "node:crypto";

import path from "node:path";
import {
  byLocalName,
  loadZipXml,
  toMarkdownTable,
  type XmlElement,
} from "./ooxml.js";

const BUILTIN_DATE_NUMFMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** 检查格式代码是否看起来像日期格式 */
function looksLikeDateFormat(formatCode: string): boolean {
  // 剥离引号字面量和 [] 部分，然后查找日期/时间标记。
  const bare = formatCode.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "");
  return /[ymdhs]/i.test(bare) && !/^general$/i.test(bare.trim());
}

// Excel 两种日期系统到 1970-01-01 的序列号偏移量。
// 工作簿级别的 <workbookPr date1904="1"/> 标志（旧版 Mac Excel 默认值，
// 设置后保持不变）选择 1904 系统；其他所有情况使用 1900。
const EXCEL_EPOCH_1900_OFFSET_DAYS = 25569;
const EXCEL_EPOCH_1904_OFFSET_DAYS = 24107;

/** 将 Excel 序列号转换为 ISO 日期字符串 */
function excelSerialToIso(serial: number, epochOffsetDays: number): string {
  const ms = Math.round((serial - epochOffsetDays) * 86400 * 1000);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return String(serial);
  const iso = date.toISOString();
  const hasTime = Math.abs(serial % 1) > 1e-9;
  return hasTime ? iso.slice(0, 19).replace("T", " ") : iso.slice(0, 10);
}

/** 从单元格引用（如 "A1"）解析列索引 */
function columnIndexFromRef(ref: string): number {
  let col = 0;
  for (const ch of ref) {
    if (ch < "A" || ch > "Z") break;
    col = col * 26 + (ch.charCodeAt(0) - 64);
  }
  return Math.max(0, col - 1);
}

/** 从共享字符串 XML 元素中提取文本 */
function sharedStringText(si: XmlElement): string {
  return byLocalName(si, "t").map((t) => t.textContent ?? "").join("");
}

/** 将 XLSX 文件转换为 markdown 表格文本 */
export async function convertXlsx(filePath: string): Promise<string> {
  const { readXml } = await loadZipXml(filePath);

  const workbook = await readXml("xl/workbook.xml");
  if (!workbook) throw new Error("Invalid XLSX: missing xl/workbook.xml");

  const date1904 = byLocalName(workbook, "workbookPr")[0]?.getAttribute("date1904");
  const epochOffsetDays = date1904 === "1" || date1904 === "true"
    ? EXCEL_EPOCH_1904_OFFSET_DAYS
    : EXCEL_EPOCH_1900_OFFSET_DAYS;

  const relTargets = new Map<string, string>();
  const rels = await readXml("xl/_rels/workbook.xml.rels");
  if (rels) {
    for (const rel of byLocalName(rels, "Relationship")) {
      const id = rel.getAttribute("Id");
      const target = rel.getAttribute("Target");
      if (!id || !target) continue;
      relTargets.set(id, target.startsWith("/") ? target.slice(1) : path.posix.join("xl", target));
    }
  }

  const sharedStrings: string[] = [];
  const shared = await readXml("xl/sharedStrings.xml");
  if (shared) {
    for (const si of byLocalName(shared, "si")) sharedStrings.push(sharedStringText(si));
  }

  // Style index →"is a date format" lookup, for serial→ISO rendering.
  const dateStyleIds = new Set<number>();
  const styles = await readXml("xl/styles.xml");
  if (styles) {
    const customDateFmts = new Set<number>();
    for (const fmt of byLocalName(styles, "numFmt")) {
      const id = Number(fmt.getAttribute("numFmtId"));
      const code = fmt.getAttribute("formatCode") ?? "";
      if (Number.isFinite(id) && looksLikeDateFormat(code)) customDateFmts.add(id);
    }
    const cellXfs = byLocalName(styles, "cellXfs")[0];
    if (cellXfs) {
      byLocalName(cellXfs, "xf").forEach((xf, index) => {
        const numFmtId = Number(xf.getAttribute("numFmtId") ?? 0);
        if (BUILTIN_DATE_NUMFMT_IDS.has(numFmtId) || customDateFmts.has(numFmtId)) {
          dateStyleIds.add(index);
        }
      });
    }
  }

  const cellText = (cell: XmlElement): string => {
    const type = cell.getAttribute("t") ?? "n";
    if (type === "inlineStr") {
      const is = byLocalName(cell, "is")[0];
      return is ? byLocalName(is, "t").map((t) => t.textContent ?? "").join("") : "";
    }
    const value = byLocalName(cell, "v")[0]?.textContent ?? "";
    if (type === "s") return sharedStrings[Number(value)] ?? "";
    if (type === "b") return value === "1" ? "TRUE" : "FALSE";
    if (type === "str" || type === "e") return value;
    if (value === "") return "";
    const styleId = Number(cell.getAttribute("s") ?? -1);
    if (dateStyleIds.has(styleId)) {
      const serial = Number(value);
      if (Number.isFinite(serial)) return excelSerialToIso(serial, epochOffsetDays);
    }
    return value;
  };

  const sections: string[] = [];
  const sheetEls = byLocalName(workbook, "sheet");
  for (let i = 0; i < sheetEls.length; i++) {
    const sheetEl = sheetEls[i]!;
    const name = sheetEl.getAttribute("name") ?? `Sheet${i + 1}`;
    const relId = sheetEl.getAttribute("r:id") ?? sheetEl.getAttribute("id");
    const entry = (relId && relTargets.get(relId)) || `xl/worksheets/sheet${i + 1}.xml`;
    const sheet = await readXml(entry);
    if (!sheet) continue;

    const rows: string[][] = [];
    let maxCol = 0;
    for (const row of byLocalName(sheet, "row")) {
      const cells: string[] = [];
      let cursor = 0;
      for (const cell of byLocalName(row, "c")) {
        const ref = cell.getAttribute("r");
        const col = ref ? columnIndexFromRef(ref) : cursor;
        cells[col] = cellText(cell);
        cursor = col + 1;
      }
      const normalized = Array.from(cells, (c) => c ?? "");
      if (normalized.some((c) => c !== "")) {
        let last = normalized.length - 1;
        while (last >= 0 && normalized[last] === "") last--;
        maxCol = Math.max(maxCol, last + 1);
        rows.push(normalized);
      }
    }
    const trimmed = rows.map((r) => r.slice(0, maxCol));

    sections.push(`## ${name}`);
    sections.push(trimmed.length ? toMarkdownTable(trimmed) : "(empty sheet)");
  }

  return sections.join("\n\n");
}

// ── PPTX（zip + XML，每张幻灯片的文本段落/表格/演讲者备注）──

/** 从 PPTX 文本框中提取段落文本 */
