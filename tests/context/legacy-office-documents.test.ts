import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import {
  LEGACY_BINARY_DOCUMENT_EXTENSIONS,
  PROJECTED_DOCUMENT_EXTENSIONS,
  legacyBinaryDocumentMessage,
} from "../../src/context/document/view.js";
import { readAndSummarize } from "../../src/attachments/reader.js";
import { classifyFile } from "../../src/attachments/file-kinds.js";
import { toolReadFile } from "../../src/tools/file-read.js";

/**
 * Word/Excel/PowerPoint 97-2003 是 OLE 复合二进制，不是 zip+XML，投影不出来。
 * 修之前它们不在任何名单里，会落到「文本文件」分支按 UTF-8 硬读，
 * 既不报错也不给可用的内容——现在要在读入口就拒绝并给出转换建议。
 */
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "swarmflow-legacy-office-"));
}

function writeOleFile(dir: string, name: string): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, Buffer.concat([OLE_MAGIC, Buffer.from("\u0000\u0000Résumé \u0000\u0000".repeat(40), "utf-8")]));
  return filePath;
}

async function writeRealDocx(filePath: string): Promise<void> {
  const zip = new JSZip();
  zip.file("word/document.xml", [
    '<?xml version="1.0"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    "<w:body><w:p><w:r><w:t>modern docx still projects</w:t></w:r></w:p></w:body></w:document>",
  ].join(""));
  writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer" }));
}

async function readResult(filePath: string): Promise<string> {
  const value = await toolReadFile(filePath);
  return typeof value === "string" ? value : JSON.stringify(value);
}

describe("legacy OLE office documents", () => {
  it.each([
    [".doc", "docx"],
    [".xls", "xlsx"],
    [".ppt", "pptx"],
  ])("read_file rejects %s with a conversion hint to %s", async (ext, modernExt) => {
    const dir = tempDir();
    try {
      const filePath = writeOleFile(dir, `report${ext}`);
      const result = await readResult(filePath);
      expect(result.startsWith("ERROR:")).toBe(true);
      expect(result).toContain("97-2003");
      expect(result).toContain("convert");
      expect(result).toContain(modernExt);
      // 不许再把 OLE 字节当文本返回
      expect(result).not.toContain("Résumé");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("read_file rejects the uppercase extension too", async () => {
    const dir = tempDir();
    try {
      const result = await readResult(writeOleFile(dir, "REPORT.DOC"));
      expect(result.startsWith("ERROR:")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("attachment reading reports the same hint instead of garbled text", async () => {
    const dir = tempDir();
    try {
      const filePath = writeOleFile(dir, "deck.ppt");
      const [isImage, isBinary, projectedType] = classifyFile(filePath);
      const info = await readAndSummarize(filePath, isImage, isBinary, projectedType, false, dir);
      expect(info.error).toContain("97-2003");
      expect(info.error).toContain("pptx");
      expect(info.content).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not swallow the modern OOXML formats", async () => {
    const dir = tempDir();
    try {
      const docxPath = join(dir, "report.docx");
      await writeRealDocx(docxPath);
      const result = await readResult(docxPath);
      expect(result).not.toContain("ERROR:");
      expect(result).toContain("modern docx still projects");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the legacy and projected extension sets disjoint and mappable", () => {
    for (const ext of LEGACY_BINARY_DOCUMENT_EXTENSIONS) {
      expect(PROJECTED_DOCUMENT_EXTENSIONS.has(ext)).toBe(false);
      const modern = `${ext}x`;
      expect(PROJECTED_DOCUMENT_EXTENSIONS.has(modern)).toBe(true);
      expect(legacyBinaryDocumentMessage(`a/b/note${ext}`)).toContain(modern.slice(1));
    }
  });
});
