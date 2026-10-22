/**
 * PPTX 投影：按幻灯片顺序抽取文本框与表格。
 */

﻿import { createHash } from "node:crypto";

import path from "node:path";
import {
  byLocalName,
  loadZipXml,
  relationshipId,
  toMarkdownTable,
  type XmlElement,
} from "./ooxml.js";

function pptxParagraphs(txBody: XmlElement): string[] {
  const out: string[] = [];
  for (const p of byLocalName(txBody, "p")) {
    const text = byLocalName(p, "t").map((t) => t.textContent ?? "").join("");
    if (text.trim()) out.push(text.trim());
  }
  return out;
}

/** 将 PPTX 表格转换为 markdown 表格 */
function pptxTable(tbl: XmlElement): string {
  const rows: string[][] = [];
  for (const tr of byLocalName(tbl, "tr")) {
    const cells: string[] = [];
    for (const tc of byLocalName(tr, "tc")) {
      cells.push(byLocalName(tc, "t").map((t) => t.textContent ?? "").join(" "));
    }
    rows.push(cells);
  }
  return toMarkdownTable(rows);
}

/** XML 元素节点类型常量 */
const ELEMENT_NODE = 1;

/** 递归遍历幻灯片 XML 树，提取文本和表格 */
function walkSlideTree(el: XmlElement, out: string[]): void {
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType !== ELEMENT_NODE) continue;
    const elem = child as unknown as XmlElement;
    if (elem.localName === "txBody") {
      out.push(...pptxParagraphs(elem));
    } else if (elem.localName === "tbl") {
      const table = pptxTable(elem);
      if (table) out.push(table);
    } else {
      walkSlideTree(elem, out);
    }
  }
}

/**
 * 按演示顺序排列的幻灯片条目。部件文件名（slideN.xml）固化了创建顺序
 * ——PowerPoint 在重新排列幻灯片时不重命名部件。
 * 显示顺序是 presentation.xml 的 sldIdLst 序列，
 * 通过 presentation.xml.rels 解析。当这些部件缺失或无法解析时，
 * 回退到部件编号顺序。
 */
async function orderedSlideEntries(
  readXml: (entry: string) => Promise<XmlElement | null>,
  entryNames: string[],
): Promise<string[]> {
  const byPartNumber = entryNames
    .map((name) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((m) => m[0]);

  const presentation = await readXml("ppt/presentation.xml");
  const rels = await readXml("ppt/_rels/presentation.xml.rels");
  const sldIdLst = presentation ? byLocalName(presentation, "sldIdLst")[0] : undefined;
  if (!sldIdLst || !rels) return byPartNumber;

  const targets = new Map<string, string>();
  for (const rel of byLocalName(rels, "Relationship")) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (!id || !target) continue;
    targets.set(
      id,
      target.startsWith("/") ? target.slice(1) : path.posix.normalize(path.posix.join("ppt", target)),
    );
  }

  const known = new Set(entryNames);
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const sldId of byLocalName(sldIdLst, "sldId")) {
    const rid = relationshipId(sldId);
    const target = rid ? targets.get(rid) : undefined;
    if (target && known.has(target) && !seen.has(target)) {
      seen.add(target);
      ordered.push(target);
    }
  }
  if (ordered.length === 0) return byPartNumber;

  // 防御性：sldIdLst 中缺失的物理幻灯片部件排在最后，按部件顺序。
  for (const entry of byPartNumber) {
    if (!seen.has(entry)) ordered.push(entry);
  }
  return ordered;
}

/** 将 PPTX 文件转换为 markdown 文本 */
export async function convertPptx(filePath: string): Promise<string> {
  const { readXml, entryNames } = await loadZipXml(filePath);
  const slideEntries = await orderedSlideEntries(readXml, entryNames);

  const sections: string[] = [];
  for (let position = 0; position < slideEntries.length; position++) {
    const entry = slideEntries[position]!;
    const slide = await readXml(entry);
    if (!slide) continue;

    const blocks: string[] = [];
    walkSlideTree(slide, blocks);

    // 演讲者备注，通过幻灯片的关系文件解析。
    const slideDir = path.posix.dirname(entry);
    const slideRels = await readXml(`${slideDir}/_rels/${path.posix.basename(entry)}.rels`);
    if (slideRels) {
      const notesRel = byLocalName(slideRels, "Relationship").find((rel) =>
        (rel.getAttribute("Type") ?? "").endsWith("/notesSlide"),
      );
      const target = notesRel?.getAttribute("Target");
      if (target) {
        const notesEntry = target.startsWith("/")
          ? target.slice(1)
          : path.posix.normalize(path.posix.join(slideDir, target));
        const notes = await readXml(notesEntry);
        if (notes) {
          const noteBlocks: string[] = [];
          walkSlideTree(notes, noteBlocks);
          // 丢弃备注母版注入的纯幻灯片编号占位符。
          const noteText = noteBlocks.filter((b) => !/^\d+$/.test(b));
          if (noteText.length) blocks.push(`**Notes:** ${noteText.join(" ")}`);
        }
      }
    }

    // 在演示文稿中的位置，而非部件文件名的固化编号。
    sections.push(`## Slide ${position + 1}`);
    if (blocks.length) sections.push(blocks.join("\n\n"));
  }

  return sections.join("\n\n");
}

// ── 投影入口点 ──

/** 根据文件扩展名将文档转换为文本 */
