import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { processFileAttachments } from "../../src/attachments/pipeline.js";
import { executeTool } from "../../src/tools/dispatch.js";

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

      // 用小写 pattern：smart-case 下它会同时命中 credentials.json 的 "password"
      // 与 notes.txt 的 "PASSWORD"，从而真正走到「敏感文件必须被拦下」的路径。
      // 大写 PASSWORD 在 smart-case 下区分大小写，本就匹配不到 credentials.json，
      // 测不出过滤是否生效。
      const result = await executeTool(
        "grep",
        { pattern: "password", path: "." },
        { projectRoot: root },
      );

      expect(result.content).toContain("notes.txt");
      expect(result.content).not.toContain("credentials.json");
      expect(result.content).not.toContain("secret");
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
