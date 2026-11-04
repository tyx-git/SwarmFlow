import { describe, expect, it } from "vitest";

import {
  BASIC_TOOLS,
  BASIC_TOOLS_MAP,
  LEGACY_WRITE_TOOLS,
} from "../../src/tools/definitions.js";
import { TOOL_PACKS } from "../../src/prompts/templates.js";

describe("edit tool exposure", () => {
  it("exposes edit by default and hides the legacy write tools", () => {
    const names = BASIC_TOOLS.map((tool) => tool.name);
    expect(names).toContain("edit");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("edit_file");
  });

  it("keeps legacy tool definitions resolvable for custom agent specs", () => {
    expect(LEGACY_WRITE_TOOLS.map((tool) => tool.name).sort()).toEqual([
      "edit_file",
      "write_file",
    ]);
    expect(BASIC_TOOLS_MAP["edit_file"]).toBeDefined();
    expect(BASIC_TOOLS_MAP["write_file"]).toBeDefined();
  });

  it("routes the edit tool pack to the new tool", () => {
    expect(TOOL_PACKS.edit).toEqual(["edit"]);
  });
});
