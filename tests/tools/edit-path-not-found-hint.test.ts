import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { executeTool } from "../../src/tools/dispatch.js";
import { toolEditFileMulti } from "../../src/tools/file-edit.js";

/**
 * edit_file 打在不存在的路径上时，结果必须给出可执行的纠错提示，
 * 否则模型会拿着同一个错误路径反复重试。
 */
describe("edit_file missing-path guidance", () => {
  it("tells the model to verify the path and use write_file for new files", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "swarmflow-edit-missing-"));
    try {
      const result = await executeTool("edit_file", {
        path: "missing-file.ts",
        edits: [{ old_str: "a", new_str: "b" }],
      }, { projectRoot });

      expect(result.content).toContain("File not found");
      expect(result.content).toContain("missing-file.ts");
      expect(result.content).toContain("list_dir");
      expect(result.content).toContain("write_file");
      expect(result.content).toContain("Do not retry");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("keeps the executor-level not-found branch consistent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swarmflow-edit-missing-"));
    try {
      const result = await toolEditFileMulti(join(dir, "gone.ts"), [{ old_str: "a", new_str: "b" }]);
      expect(result).toContain("File not found");
      expect(result).toContain("list_dir");
      expect(result).toContain("write_file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not add the hint to successful edits", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "swarmflow-edit-ok-"));
    try {
      writeFileSync(join(projectRoot, "a.ts"), "const a = 1;\n", "utf-8");
      const result = await executeTool("edit_file", {
        path: "a.ts",
        edits: [{ old_str: "const a = 1;", new_str: "const a = 2;" }],
      }, { projectRoot });

      expect(result.content).toContain("OK:");
      expect(result.content).not.toContain("list_dir");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
