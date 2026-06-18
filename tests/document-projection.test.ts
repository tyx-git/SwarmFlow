import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";
import JSZip from "jszip";

import { loadProjectedDocumentView } from "../src/document-projection.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function writeZip(filePath: string, entries: Record<string, string>): Promise<void> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer" }));
}

const SPREADSHEET_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const RELS_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const DRAWING_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const PRESENTATION_NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const PACKAGE_RELS_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';

describe("XLSX projection", () => {
  it("renders shared strings, booleans, dates, and escapes pipes", async () => {
    const dir = tempDir("swarmflow-proj-xlsx-");
    try {
      const filePath = join(dir, "report.xlsx");
      await writeZip(filePath, {
        "xl/workbook.xml": `<workbook ${SPREADSHEET_NS} ${RELS_NS}><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/><sheet name="Raw" sheetId="2" r:id="rId2"/></sheets></workbook>`,
        "xl/_rels/workbook.xml.rels": `<Relationships ${PACKAGE_RELS_NS}><Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="t" Target="worksheets/sheet2.xml"/></Relationships>`,
        "xl/sharedStrings.xml": `<sst ${SPREADSHEET_NS}><si><t>Header A</t></si><si><r><t>rich </t></r><r><t>text</t></r></si><si><t>has|pipe</t></si></sst>`,
        "xl/styles.xml": `<styleSheet ${SPREADSHEET_NS}><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
        "xl/worksheets/sheet1.xml": `<worksheet ${SPREADSHEET_NS}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>42</v></c><c r="B2" t="b"><v>1</v></c></row><row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3" s="1"><v>25569</v></c></row></sheetData></worksheet>`,
        "xl/worksheets/sheet2.xml": `<worksheet ${SPREADSHEET_NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>only cell</t></is></c></row></sheetData></worksheet>`,
      });

      const view = await loadProjectedDocumentView(filePath);
      expect(view.text).toContain("## Summary");
      expect(view.text).toContain("| Header A | rich text |");
      expect(view.text).toContain("| 42 | TRUE |");
      expect(view.text).toContain("has\\|pipe");
      expect(view.text).toContain("1970-01-01");
      expect(view.text).toContain("## Raw");
      expect(view.text).toContain("| only cell |");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("respects the 1904 date system when workbookPr declares it", async () => {
    const dir = tempDir("swarmflow-proj-xlsx-1904-");
    try {
      const filePath = join(dir, "mac.xlsx");
      await writeZip(filePath, {
        "xl/workbook.xml": `<workbook ${SPREADSHEET_NS}><workbookPr date1904="1"/><sheets><sheet name="S" sheetId="1"/></sheets></workbook>`,
        "xl/styles.xml": `<styleSheet ${SPREADSHEET_NS}><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
        // Serial 24107 is 1970-01-01 in the 1904 system (1966-01-01 if the
        // 1900 epoch were wrongly applied).
        "xl/worksheets/sheet1.xml": `<worksheet ${SPREADSHEET_NS}><sheetData><row r="1"><c r="A1" s="1"><v>24107</v></c></row></sheetData></worksheet>`,
      });

      const view = await loadProjectedDocumentView(filePath);
      expect(view.text).toContain("1970-01-01");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aligns sparse rows by cell reference", async () => {
    const dir = tempDir("swarmflow-proj-xlsx-sparse-");
    try {
      const filePath = join(dir, "sparse.xlsx");
      await writeZip(filePath, {
        "xl/workbook.xml": `<workbook ${SPREADSHEET_NS}><sheets><sheet name="S" sheetId="1"/></sheets></workbook>`,
        "xl/worksheets/sheet1.xml": `<worksheet ${SPREADSHEET_NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="C1" t="inlineStr"><is><t>c</t></is></c></row></sheetData></worksheet>`,
      });

      const view = await loadProjectedDocumentView(filePath);
      expect(view.text).toContain("| a |  | c |");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PPTX projection", () => {
  it("extracts slide text, tables, and speaker notes in slide order", async () => {
    const dir = tempDir("swarmflow-proj-pptx-");
    try {
      const filePath = join(dir, "deck.pptx");
      const slide = (body: string) =>
        `<p:sld ${DRAWING_NS} ${PRESENTATION_NS}><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
      const textShape = (...paragraphs: string[]) =>
        `<p:sp><p:txBody>${paragraphs.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>`;
      const table =
        `<p:graphicFrame><a:tbl>` +
        `<a:tr><a:tc><a:txBody><a:p><a:r><a:t>K</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>V</a:t></a:r></a:p></a:txBody></a:tc></a:tr>` +
        `<a:tr><a:tc><a:txBody><a:p><a:r><a:t>cpu</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>80%</a:t></a:r></a:p></a:txBody></a:tc></a:tr>` +
        `</a:tbl></p:graphicFrame>`;

      await writeZip(filePath, {
        // slide10 ensures numeric (not lexicographic) ordering
        "ppt/slides/slide1.xml": slide(textShape("Title slide", "Subtitle text") + table),
        "ppt/slides/slide2.xml": slide(textShape("Second slide")),
        "ppt/slides/slide10.xml": slide(textShape("Last slide")),
        "ppt/slides/_rels/slide1.xml.rels": `<Relationships ${PACKAGE_RELS_NS}><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
        "ppt/notesSlides/notesSlide1.xml": slide(textShape("Remember the demo", "3")),
      });

      const view = await loadProjectedDocumentView(filePath);
      expect(view.text).toContain("## Slide 1");
      expect(view.text).toContain("Title slide");
      expect(view.text).toContain("| K | V |");
      expect(view.text).toContain("| cpu | 80% |");
      expect(view.text).toContain("**Notes:** Remember the demo");
      expect(view.text).not.toContain("**Notes:** Remember the demo 3");
      // Headings are deck positions, not fossilized part numbers: without a
      // presentation.xml the parts 1/2/10 surface as Slides 1/2/3.
      expect(view.text).not.toContain("## Slide 10");
      const slide2 = view.text.indexOf("## Slide 2");
      const slide3 = view.text.indexOf("## Slide 3");
      expect(slide2).toBeGreaterThan(-1);
      expect(slide3).toBeGreaterThan(slide2);
      expect(view.text.indexOf("Last slide")).toBeGreaterThan(slide3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("follows presentation.xml order for rearranged decks", async () => {
    const dir = tempDir("swarmflow-proj-pptx-order-");
    try {
      const filePath = join(dir, "rearranged.pptx");
      const slide = (body: string) =>
        `<p:sld ${DRAWING_NS} ${PRESENTATION_NS}><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
      const textShape = (t: string) =>
        `<p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`;

      await writeZip(filePath, {
        "ppt/slides/slide1.xml": slide(textShape("Alpha part one")),
        "ppt/slides/slide2.xml": slide(textShape("Beta part two")),
        "ppt/slides/slide3.xml": slide(textShape("Gamma part three")),
        // Deck rearranged: displayed order is 3, 1, 2.
        "ppt/presentation.xml": `<p:presentation ${PRESENTATION_NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="258" r:id="rId3"/><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
        "ppt/_rels/presentation.xml.rels": `<Relationships ${PACKAGE_RELS_NS}><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide3.xml"/></Relationships>`,
      });

      const view = await loadProjectedDocumentView(filePath);
      const gamma = view.text.indexOf("Gamma part three");
      const alpha = view.text.indexOf("Alpha part one");
      const beta = view.text.indexOf("Beta part two");
      expect(gamma).toBeGreaterThan(-1);
      expect(alpha).toBeGreaterThan(gamma);
      expect(beta).toBeGreaterThan(alpha);
      // Slide 1 is the deck's first slide — physically slide3.xml.
      expect(view.text.indexOf("## Slide 1")).toBeLessThan(gamma);
      expect(view.text).not.toContain("## Slide 4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("DOCX projection", () => {
  it("converts paragraphs through mammoth and turndown", async () => {
    const dir = tempDir("swarmflow-proj-docx-");
    try {
      const filePath = join(dir, "doc.docx");
      await writeZip(filePath, {
        "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
        "_rels/.rels": `<Relationships ${PACKAGE_RELS_NS}><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
        "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>First paragraph.</w:t></w:r></w:p><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold text.</w:t></w:r></w:p></w:body></w:document>`,
      });

      const view = await loadProjectedDocumentView(filePath);
      expect(view.text).toContain("First paragraph.");
      expect(view.text).toContain("**Bold text.**");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PDF projection", () => {
  it("preserves line breaks within pages and separates pages with blank lines", async () => {
    const dir = tempDir("swarmflow-proj-pdf-");
    try {
      const filePath = join(dir, "min.pdf");
      // Hand-built 2-page PDF without an xref table (pdf.js reconstructs it).
      // Page 1 has two text lines at different y positions, which pdf.js
      // surfaces via hasEOL. Regression guard: unpdf's mergePages option
      // collapses ALL whitespace into single spaces — the whole document came
      // back as one giant line that read_file's per-line cap then mangled.
      writeFileSync(
        filePath,
        `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 90 >> stream
BT /F1 12 Tf 72 720 Td (Alpha first line) Tj 0 -20 Td (Beta second line) Tj ET
endstream
endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
6 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
7 0 obj << /Length 50 >> stream
BT /F1 12 Tf 72 720 Td (Gamma page two) Tj ET
endstream
endobj
trailer << /Root 1 0 R >>
%%EOF
`,
        "utf-8",
      );

      const view = await loadProjectedDocumentView(filePath);
      expect(view.text).toContain("Alpha first line\nBeta second line");
      expect(view.text).toContain("Beta second line\n\nGamma page two");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("projection error handling", () => {
  it("rejects files that are not valid archives", async () => {
    const dir = tempDir("swarmflow-proj-bad-");
    try {
      const filePath = join(dir, "broken.xlsx");
      writeFileSync(filePath, Buffer.from("not a zip"));
      await expect(loadProjectedDocumentView(filePath)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
