import { describe, expect, it } from "vitest";

import { BASIC_TOOLS, BASIC_TOOLS_MAP } from "../../src/tools/definitions.js";
import { TOOL_PACKS } from "../../src/prompts/templates.js";

describe("edit-only tool registry", () => {
  it("exposes edit by default and no longer registers the old writers", () => {
    const names = BASIC_TOOLS.map((tool) => tool.name);
    expect(names).toContain("edit");
    expect(names).not.toContain("edit_file");
    expect(names).not.toContain("write_file");
    expect(Object.keys(BASIC_TOOLS_MAP).sort()).toEqual([...names].sort());
  });

  it("routes the edit tool pack to the new tool", () => {
    expect(TOOL_PACKS.edit).toEqual(["edit"]);
  });
});
