import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import React from "react";
import { createRoot, flushSync } from "@opentui/react";
import { createTestRenderer } from "@opentui/core/testing";

import { FileModifyBody } from "../../external/opentui/components/entry/file-modify-body.js";
import { buildToolResultArtifacts } from "../../external/opentui/components/tool-result-artifacts.js";
import { createDisplayTheme } from "../../external/opentui/display/theme/default-theme.js";
import { splitDisplayLines } from "../../src/lib/line-window.js";
import { buildHunkFromMatch, buildWriteDisplayData } from "../../src/patches/hunk.js";
import { toolWriteFile } from "../../src/tools/file-write.js";

/**
 * CRLF 文本的展示契约：行尾 CR 不能变成额外空行，真实空行必须保留。
 * 写盘内容不受影响（文件仍是 CRLF）。
 */

function usedRows(frame: string): string[] {
  const rows = frame.split("\n").map((line) => line.trimEnd());
  const firstBlank = rows.findIndex((line) => line.trim() === "");
  return firstBlank >= 0 ? rows.slice(0, firstBlank) : rows;
}

async function renderWriteBody(content: string): Promise<string[]> {
  const theme = createDisplayTheme("dark");
  const setup = await createTestRenderer({ width: 60, height: 12, useThread: false, consoleMode: "disabled" });
  const root = createRoot(setup.renderer);
  try {
    flushSync(() => root.render(React.createElement(FileModifyBody as any, {
      data: buildWriteDisplayData("src/sample.ts", content, 0),
      colors: theme.colors,
      contentWidth: 56,
      streaming: false,
      maxVisibleLines: Number.POSITIVE_INFINITY,
    })));
    await setup.flush({ maxPasses: 100 });
    return usedRows(setup.captureCharFrame());
  } finally {
    flushSync(() => root.unmount());
    setup.renderer.destroy();
    theme.markdownStyle.destroy();
  }
}

describe("display line splitting", () => {
  it("treats CRLF like LF and keeps real blank lines", () => {
    expect(splitDisplayLines("a\r\nb\r\n\r\nc")).toEqual(["a", "b", "", "c"]);
    expect(splitDisplayLines("a\n\n\nb")).toEqual(["a", "", "", "b"]);
    expect(splitDisplayLines("a\r\nb\nc")).toEqual(["a", "b", "c"]);
  });
});

describe("file-modify display data", () => {
  it("strips the CR that CRLF writes would leave on every line", () => {
    const { writeLines } = buildWriteDisplayData("src/sample.ts", "a\r\nb\r\n\r\nc", 0);
    expect(writeLines).toEqual(["a", "b", "", "c"]);
    expect(writeLines?.some((line) => line.includes("\r"))).toBe(false);
  });

  it("keeps hunk lines and context CR-free while preserving blank context rows", () => {
    const content = "a\r\n\r\nb\r\nc\r\n";
    const hunk = buildHunkFromMatch(content, content.indexOf("b\r\n"), "b", "B");
    expect(hunk.deletions).toEqual(["b"]);
    expect(hunk.additions).toEqual(["B"]);
    expect(hunk.contextBefore).toEqual(["a", ""]);
    expect(hunk.contextAfter).toEqual(["c"]);
    for (const line of [...hunk.contextBefore, ...hunk.deletions, ...hunk.additions, ...hunk.contextAfter]) {
      expect(line.includes("\r")).toBe(false);
    }
  });

  it("renders a CRLF write without phantom rows", async () => {
    const rows = await renderWriteBody("a\r\nb\r\nc");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("1 a");
    expect(rows[1]).toContain("2 b");
    expect(rows[2]).toContain("3 c");
  });

  it("renders a real blank line as exactly one row", async () => {
    const rows = await renderWriteBody("a\n\nb");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("1 a");
    expect(rows[1].trim()).toBe("2");
    expect(rows[2]).toContain("3 b");
  });

  it("leaves the on-disk CRLF convention alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swarmflow-crlf-display-"));
    try {
      const crlfPath = join(dir, "crlf.ts");
      writeFileSync(crlfPath, "const a = 1;\r\nconst b = 2;\r\n", "utf-8");

      const result = await toolWriteFile(crlfPath, "const a = 1;\nconst b = 3;\n") as any;
      expect(result.metadata.fileModifyData.writeLines).toEqual(["const a = 1;", "const b = 3;", ""]);
      expect(readFileSync(crlfPath, "utf-8")).toContain("\r\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tool result artifacts", () => {
  it("splits CRLF result text into the same rows as LF", () => {
    const theme = createDisplayTheme("dark");
    try {
      const artifacts = buildToolResultArtifacts({
        text: "a\r\nb\r\n\r\nc",
        colors: theme.colors,
        wrapWidth: 80,
      });
      const rows = artifacts.map((artifact) => artifact.content.chunks.map((chunk) => chunk.text).join(""));
      expect(rows).toEqual(["a", "b", " ", "c"]);
    } finally {
      theme.markdownStyle.destroy();
    }
  });
});
