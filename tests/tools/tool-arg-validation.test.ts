import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Session } from "../../src/session.js";
import { executeTool } from "../../src/tools/dispatch.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("Phase 2 tool validation and grep limits", () => {
  it("validates high-risk basic tool arguments at runtime", async () => {
    const root = makeTempDir("swarmflow-phase2-basic-");
    try {
      const readBad = await executeTool("read_file", { path: 123 as unknown as string }, { projectRoot: root });
      expect(readBad.content).toContain("Invalid arguments for read_file");
      expect(readBad.content).toContain("'path' must be a string");

      const bashBad = await executeTool(
        "bash",
        { command: "echo hi", timeout: 1.5 as unknown as number },
        { projectRoot: root },
      );
      expect(bashBad.content).toContain("Invalid arguments for bash");
      expect(bashBad.content).toContain("'timeout' must be an integer");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns current local time with timezone and UTC offset", async () => {
    const root = makeTempDir("swarmflow-phase2-time-tool-");
    try {
      const result = await executeTool("time", {}, { projectRoot: root });
      expect(result.content).toContain("Current local time:");
      expect(result.content).toContain("Timezone:");
      expect(result.content).toContain("ISO 8601:");
      expect(result.content).toMatch(/UTC[+-]\d{2}:\d{2}/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects risky/overlong regex patterns before grep execution", async () => {
    const root = makeTempDir("swarmflow-phase2-search-regex-");
    try {
      writeFileSync(join(root, "a.txt"), "aaaaab\n", "utf-8");

      const tooLong = await executeTool(
        "grep",
        { pattern: "a".repeat(301), path: "." },
        { projectRoot: root },
      );
      expect(tooLong.content).toContain("Invalid arguments for grep");
      expect(tooLong.content).toContain("max length");

      const risky = await executeTool(
        "grep",
        { pattern: "(a+)+$", path: "." },
        { projectRoot: root },
      );
      expect(risky.content).toContain("Regex appears too complex/risky");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enforces grep depth and file-size limits with notices", async () => {
    const root = makeTempDir("swarmflow-phase2-search-limits-");
    try {
      // Depth limit is SEARCH_MAX_DEPTH (8). Bury the file at depth 10 so it must be skipped.
      let deep = root;
      for (let i = 0; i < 10; i++) {
        deep = join(deep, `d${i}`);
        mkdirSync(deep);
      }
      writeFileSync(join(deep, "too-deep.txt"), "needle\n", "utf-8");

      // Large file > 1MB should be skipped
      writeFileSync(join(root, "large.txt"), "x".repeat(1024 * 1024 + 10) + "needle", "utf-8");

      const result = await executeTool(
        "grep",
        { pattern: "needle", path: "." },
        { projectRoot: root },
      );

      // 限制由行为验证：needle 只存在于「超出深度上限」和「超出 1 MB」的两个文件里，
      // 因此无匹配即证明两条限制都生效。
      // native 路径（rg --max-depth / --max-filesize）实施同样的限制，但不报告
      // 跳过的文件数量，故不再断言 JS 实现特有的计数提示。
      expect(result.content).toContain("No matches found.");
      expect(result.content).not.toContain("too-deep.txt");
      expect(result.content).not.toContain("large.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates comm tool arguments at runtime", async () => {
    const fake = Object.create(Session.prototype) as any;
    fake._activeAgents = new Map();
    fake._progress = undefined;
    fake._turnCount = 0;
    fake._hasActiveAgents = () => false;

    // A bare string ids:"a" is now REPAIRED to ["a"] (tool-input repair, see
    // arg-repair.ts), so use a genuinely unrepairable value to hit the error
    // path. Bare-string→array repair is covered in arg-repair.test.ts.
    const killBad = Session.prototype["_execKillAgent"].call(fake, { ids: 5 });
    expect(killBad.content).toContain("invalid arguments for kill_agent");
    expect(killBad.isError).toBe(true);

    const askBad = Session.prototype["_execAsk"].call(fake, { questions: "bad" });
    expect(askBad.content).toContain("Error: 'questions' must be an array of 1-4 items.");
    expect(askBad.isError).toBe(true);
  });
});
