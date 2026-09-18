import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { processFileAttachments } from "../src/lib/file-attach.js";
import { executeTool } from "../src/tools/basic.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("sensitive file read guards", () => {
  it("blocks read_file for .env files", async () => {
    const root = makeTempDir("swarmflow-sensitive-");
    try {
      writeFileSync(join(root, ".env"), "API_KEY=secret\n", "utf-8");

      const readResult = await executeTool(
        "read_file",
        { path: ".env" },
        { projectRoot: root },
      );
      expect(readResult.content).toMatch(/sensitive file/i);
      expect(readResult.content).toMatch(/\.env/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips sensitive files in grep with a notice", async () => {
    const root = makeTempDir("swarmflow-sensitive-search-");
    try {
      writeFileSync(join(root, "credentials.json"), "{\"password\":\"secret\"}\n", "utf-8");
      writeFileSync(join(root, "notes.txt"), "PASSWORD policy docs\n", "utf-8");

      const result = await executeTool(
        "grep",
        { pattern: "PASSWORD", path: "." },
        { projectRoot: root },
      );

      expect(result.content).toContain("notes.txt");
      expect(result.content).not.toContain("credentials.json");
      expect(result.content).toContain("Skipped 1 sensitive file");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("@file attachments block sensitive files and keep cleaned text", async () => {
    const root = makeTempDir("swarmflow-sensitive-attach-");
    try {
      writeFileSync(join(root, ".env"), "TOKEN=supersecret\n", "utf-8");
      const result = await processFileAttachments("Inspect @.env please", root, false, root);
      expect(result.cleanedText).toContain("Inspect");
      expect(result.contextStr).not.toContain("supersecret");
      expect(result.warnings.join("\n")).toMatch(/blocked sensitive file/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
