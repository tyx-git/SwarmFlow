import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const PROJECTED_DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".pptx"]);
const PROJECTION_CACHE_DIR = ".document-projections";

export interface ProjectedDocumentView {
  sourcePath: string;
  sourceExt: string;
  text: string;
  sizeBytes: number;
  mtimeMs: number;
}

function normalizeDocBaseName(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath)) || "document";
  return base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").slice(0, 64) || "document";
}

function buildCachePath(filePath: string, artifactsDir: string, sizeBytes: number, mtimeMs: number): string {
  const ext = path.extname(filePath).toLowerCase();
  const safeBase = normalizeDocBaseName(filePath);
  const hash = createHash("sha256")
    .update(`${filePath}:${sizeBytes}:${mtimeMs}`)
    .digest("hex")
    .slice(0, 10);
  return path.join(artifactsDir, PROJECTION_CACHE_DIR, `${safeBase}-${hash}${ext}.md`);
}

export function isProjectedDocumentPath(filePath: string): boolean {
  return PROJECTED_DOCUMENT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function projectedDocumentLabel(filePath: string): string {
  return path.extname(filePath).toLowerCase().slice(1).toUpperCase() || "document";
}

// 鈹€鈹€ shared markdown helpers 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function toMarkdownTable(rows: string[][]): string {
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

type XmlElement = {
  localName: string;
  textContent: string | null;
  getAttribute(name: string): string | null;
  getAttributeNS(ns: string, localName: string): string | null;
  getElementsByTagNameNS(ns: string, name: string): ArrayLike<XmlElement>;
  childNodes: ArrayLike<{ nodeType: number }>;
};

const OOXML_RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** The r:id of an OOXML element, namespace-aware with a conventional-prefix fallback. */
function relationshipId(el: XmlElement): string | null {
  return el.getAttributeNS(OOXML_RELATIONSHIPS_NS, "id") || el.getAttribute("r:id");
}

function byLocalName(node: XmlElement, name: string): XmlElement[] {
  return Array.from(node.getElementsByTagNameNS("*", name));
}

async function loadZipXml(filePath: string): Promise<{
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

// 鈹€鈹€ PDF (unpdf: serverless pdf.js build, no worker/DOM requirements) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

async function convertPdf(filePath: string): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const data = new Uint8Array(readFileSync(filePath));
  // verbosity 0 = errors only; suppresses pdf.js font warnings ("TT: undefined function")
  const pdf = await getDocumentProxy(data, { verbosity: 0 });
  // No mergePages: it collapses ALL whitespace (including every newline) into
  // single spaces, turning the document into one giant line that read_file's
  // per-line cap then mangles. Per-page extraction keeps pdf.js's hasEOL line
  // breaks intact; pages are joined as paragraphs.
  const { text } = await extractText(pdf);
  return (text as string[]).map((page) => page.trim()).filter(Boolean).join("\n\n");
}

// 鈹€鈹€ DOCX (mammoth 鈫?HTML 鈫?turndown, same engines markitdown used) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

async function convertDocx(filePath: string): Promise<string> {
  const [{ default: mammoth }, { default: TurndownService }, { gfm }] = await Promise.all([
    import("mammoth"),
    import("turndown"),
    import("@joplin/turndown-plugin-gfm"),
  ]);
  const { value: html } = await mammoth.convertToHtml(
    { path: filePath },
    // Skip image payloads: projection is text-only and base64 inlining bloats memory.
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

// 鈹€鈹€ XLSX (zip + XML, read-only projection to markdown tables) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

const BUILTIN_DATE_NUMFMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function looksLikeDateFormat(formatCode: string): boolean {
  // Strip quoted literals and [] sections, then look for date/time tokens.
  const bare = formatCode.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "");
  return /[ymdhs]/i.test(bare) && !/^general$/i.test(bare.trim());
}

// Serial-number offsets to 1970-01-01 for Excel's two date systems. The
// workbook-level <workbookPr date1904="1"/> flag (legacy Mac Excel default,
// sticky once set) selects the 1904 system; everything else uses 1900.
const EXCEL_EPOCH_1900_OFFSET_DAYS = 25569;
const EXCEL_EPOCH_1904_OFFSET_DAYS = 24107;

function excelSerialToIso(serial: number, epochOffsetDays: number): string {
  const ms = Math.round((serial - epochOffsetDays) * 86400 * 1000);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return String(serial);
  const iso = date.toISOString();
  const hasTime = Math.abs(serial % 1) > 1e-9;
  return hasTime ? iso.slice(0, 19).replace("T", " ") : iso.slice(0, 10);
}

function columnIndexFromRef(ref: string): number {
  let col = 0;
  for (const ch of ref) {
    if (ch < "A" || ch > "Z") break;
    col = col * 26 + (ch.charCodeAt(0) - 64);
  }
  return Math.max(0, col - 1);
}

function sharedStringText(si: XmlElement): string {
  return byLocalName(si, "t").map((t) => t.textContent ?? "").join("");
}

async function convertXlsx(filePath: string): Promise<string> {
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

  // Style index 鈫?"is a date format" lookup, for serial鈫扞SO rendering.
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

// 鈹€鈹€ PPTX (zip + XML, text runs / tables / speaker notes per slide) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function pptxParagraphs(txBody: XmlElement): string[] {
  const out: string[] = [];
  for (const p of byLocalName(txBody, "p")) {
    const text = byLocalName(p, "t").map((t) => t.textContent ?? "").join("");
    if (text.trim()) out.push(text.trim());
  }
  return out;
}

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

const ELEMENT_NODE = 1;

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
 * Slide entries in presentation order. Part filenames (slideN.xml) fossilize
 * creation order 鈥?PowerPoint does not rename parts when slides are
 * rearranged. The displayed order is presentation.xml's sldIdLst sequence,
 * resolved through presentation.xml.rels. Falls back to part-number order
 * when those parts are missing or unparsable.
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

  // Defensive: physical slide parts absent from sldIdLst go last, in part order.
  for (const entry of byPartNumber) {
    if (!seen.has(entry)) ordered.push(entry);
  }
  return ordered;
}

async function convertPptx(filePath: string): Promise<string> {
  const { readXml, entryNames } = await loadZipXml(filePath);
  const slideEntries = await orderedSlideEntries(readXml, entryNames);

  const sections: string[] = [];
  for (let position = 0; position < slideEntries.length; position++) {
    const entry = slideEntries[position]!;
    const slide = await readXml(entry);
    if (!slide) continue;

    const blocks: string[] = [];
    walkSlideTree(slide, blocks);

    // Speaker notes, resolved through the slide's relationship file.
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
          // Drop bare slide-number placeholders that notes masters inject.
          const noteText = noteBlocks.filter((b) => !/^\d+$/.test(b));
          if (noteText.length) blocks.push(`**Notes:** ${noteText.join(" ")}`);
        }
      }
    }

    // Position in the deck, not the part filename's fossilized number.
    sections.push(`## Slide ${position + 1}`);
    if (blocks.length) sections.push(blocks.join("\n\n"));
  }

  return sections.join("\n\n");
}

// 鈹€鈹€ projection entry point 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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
