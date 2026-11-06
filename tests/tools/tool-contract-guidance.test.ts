import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { MEMORY_TOOL } from "../../src/tools/comm.js";
import { BASIC_TOOLS_MAP } from "../../src/tools/definitions.js";
import { TASK_UPDATE_TOOL } from "../../src/tools/tasks.js";

/**
 * 工具契约与角色文档的一致性：
 * - 数值分页参数在 schema 里就声明 >= 1（模型看得到，不用等运行时拒绝）；
 * - 描述与六份 tools.md 都写明“省略 tail_lines 从第 1 行读”；
 * - `edit` 的零参数正文补丁契约与 worker tools.md 保持同步；
 * - `memory` 同样零参数，且只在根会话的角色文档里出现；
 * - 任务状态文案是条件式的，单步任务不需要先建任务。
 */
describe("tool schema guidance", () => {
  const readParams = BASIC_TOOLS_MAP["read_file"].parameters as any;
  const editDescription = BASIC_TOOLS_MAP["edit"].description ?? "";
  const readDescription = BASIC_TOOLS_MAP["read_file"].description ?? "";

  it("declares minimum 1 on every paging argument", () => {
    for (const key of ["start_line", "offset", "limit", "tail_lines"]) {
      expect(readParams.properties[key].minimum, key).toBe(1);
    }
    // end_line 支持 -1（读到 EOF），不能加 minimum。
    expect(readParams.properties["end_line"].minimum).toBeUndefined();
  });

  it("spells out the tail_lines rule in the tool description", () => {
    expect(readDescription).toContain("tail_lines must be >= 1");
    expect(readDescription).toContain("omit it to read from line 1");
  });

  it("spells out the zero-argument body patch contract for edit", () => {
    expect(editDescription).toContain("NO arguments");
    expect(editDescription).toContain("assistant message");
    expect(editDescription).toContain("Do not wrap the patch in JSON");
    expect((BASIC_TOOLS_MAP["edit"].parameters as any).properties).toEqual({});
    expect((BASIC_TOOLS_MAP["edit"].parameters as any).required).toEqual([]);
  });

  it("keeps the same read rules in the role prompts", () => {
    for (const role of ["guard", "merger", "queen", "reviewer", "scout", "worker"]) {
      const text = readFileSync(`prompts/templates/${role}/tools.md`, "utf8");
      expect(text, role).toContain("omit it to read from line 1");
      expect(text, role).toContain("all paging values must be >= 1");
    }
    const worker = readFileSync("prompts/templates/worker/tools.md", "utf8");
    expect(worker).toContain("Call this tool with **no arguments**");
    expect(worker).toContain("*** Begin Patch");
    expect(worker).toContain("*** End Patch");
    expect(worker).not.toContain("old_str");
  });

  it("words task status as conditional so a single-step task needs no bookkeeping", () => {
    expect(TASK_UPDATE_TOOL.description).toContain("if you track this step as a task");
  });

  it("keeps memory a zero-argument body tool documented for the root role only", () => {
    expect((MEMORY_TOOL.parameters as any).properties).toEqual({});
    expect((MEMORY_TOOL.parameters as any).required).toEqual([]);
    expect(MEMORY_TOOL.description).toContain("no arguments");
    expect(MEMORY_TOOL.description).toContain("*** Begin Memory");
    // 复写语义必须在描述里就说清：整文件替换、行数与行长上限、低于 AGENTS.md。
    expect(MEMORY_TOOL.description).toContain("replaces the whole file");
    expect(MEMORY_TOOL.description).toContain("below");

    const queen = readFileSync("prompts/templates/queen/tools.md", "utf8");
    expect(queen).toContain("### `memory`");
    expect(queen).toContain("`memory()`");
    expect(queen).toContain("*** Begin Memory");
    expect(queen).toContain("*** End Memory");
    expect(queen).toContain("never append");
    expect(queen).toContain("- git提交信息需单行中文，无空格，精简概括");

    // 子角色没有这个工具，文档里也不许出现（文档 ⊆ 授权之外的正向约束）。
    for (const role of ["worker", "scout", "reviewer", "guard", "merger"]) {
      const text = readFileSync(`prompts/templates/${role}/tools.md`, "utf8");
      expect(text, role).not.toContain("### `memory`");
    }
  });
});
