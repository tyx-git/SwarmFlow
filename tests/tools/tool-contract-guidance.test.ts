import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { BASIC_TOOLS_MAP } from "../../src/tools/definitions.js";

/**
 * 工具契约与角色文档的一致性：
 * - 数值分页参数在 schema 里就声明 >= 1（模型看得到，不用等运行时拒绝）；
 * - 描述与六份 tools.md 都写明“省略 tail_lines 从第 1 行读”和 old_str 的逐字节要求。
 */
describe("tool schema guidance", () => {
  const readParams = BASIC_TOOLS_MAP["read_file"].parameters as any;
  const editDescription = BASIC_TOOLS_MAP["edit_file"].description ?? "";
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

  it("spells out verbatim byte matching for old_str", () => {
    expect(editDescription).toContain("byte-for-byte");
    expect(editDescription).toContain("re-read that exact range");
  });

  it("keeps the same rules in the role prompts", () => {
    for (const role of ["guard", "merger", "queen", "reviewer", "scout", "worker"]) {
      const text = readFileSync(`prompts/templates/${role}/tools.md`, "utf8");
      expect(text, role).toContain("omit it to read from line 1");
      expect(text, role).toContain("all paging values must be >= 1");
    }
    const worker = readFileSync("prompts/templates/worker/tools.md", "utf8");
    expect(worker).toContain("byte-for-byte");
    expect(worker).toContain("old_str not found");
    expect(worker).toContain("leaves the file untouched");
  });
});
