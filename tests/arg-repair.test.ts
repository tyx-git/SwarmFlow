import { describe, expect, it } from "vitest";

import {
  repairToStringArray,
  coerceStringArray,
  repairAutolinkPath,
  setArgRepairSink,
  type ArgRepairKind,
} from "../src/tools/arg-repair.js";
import { argRequiredStringArray, argOptionalPath } from "../src/tools/arg-helpers.js";
import { executeTool } from "../src/tools/basic.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("repairToStringArray — the four shape repairs", () => {
  it("parses a stringified JSON array", () => {
    expect(repairToStringArray('["a","b"]')).toEqual({
      value: ["a", "b"],
      kind: "json_string_array",
    });
  });

  it("wraps a bare string into a single-element array", () => {
    expect(repairToStringArray("foo")).toEqual({
      value: ["foo"],
      kind: "bare_string_to_array",
    });
  });

  it("JSON-array parse beats bare-string wrap (ordering invariant)", () => {
    // If the bare-string wrap ran first, this would become ['["a","b"]'].
    const r = repairToStringArray('["a","b"]');
    expect(r?.value).toEqual(["a", "b"]);
    expect(r?.kind).toBe("json_string_array");
  });

  it("treats a non-JSON bracketed string as a bare string, not a crash", () => {
    expect(repairToStringArray("[not json")).toEqual({
      value: ["[not json"],
      kind: "bare_string_to_array",
    });
  });

  it("unwraps an empty object placeholder to an empty array", () => {
    expect(repairToStringArray({})).toEqual({
      value: [],
      kind: "object_placeholder_unwrap",
    });
  });

  it("unwraps an object of string values to its values", () => {
    expect(repairToStringArray({ "0": "x", "1": "y" })).toEqual({
      value: ["x", "y"],
      kind: "object_placeholder_unwrap",
    });
  });

  it("returns null for genuinely unrepairable input", () => {
    expect(repairToStringArray(42)).toBeNull();
    expect(repairToStringArray({ a: 1 })).toBeNull();
    expect(repairToStringArray(null)).toBeNull();
  });

  it("leaves a valid array untouched (caller never calls repair on it)", () => {
    // argRequiredStringArray only repairs on non-array; a valid array passes through.
    expect(argRequiredStringArray("kill_shell", { ids: ["a", "b"] }, "ids")).toEqual(["a", "b"]);
  });

  it("argRequiredStringArray repairs a stringified array end-to-end", () => {
    expect(argRequiredStringArray("kill_shell", { ids: '["a","b"]' }, "ids")).toEqual(["a", "b"]);
  });

  it("argRequiredStringArray repairs a bare string end-to-end", () => {
    expect(argRequiredStringArray("kill_shell", { ids: "shell-1" }, "ids")).toEqual(["shell-1"]);
  });

  it("argRequiredStringArray still errors on unrepairable input", () => {
    const r = argRequiredStringArray("kill_shell", { ids: 5 }, "ids");
    expect(Array.isArray(r)).toBe(false);
    expect((r as { content?: string }).content ?? "").toContain("must be an array of strings");
  });
});

describe("repairAutolinkPath — degenerate markdown auto-link unwrap", () => {
  it("unwraps when link text equals url minus protocol", () => {
    expect(repairAutolinkPath("[notes.md](http://notes.md)")).toEqual({
      value: "notes.md",
      repaired: true,
    });
  });

  it("unwraps when link text equals url exactly (no protocol)", () => {
    expect(repairAutolinkPath("[a/b.txt](a/b.txt)")).toEqual({
      value: "a/b.txt",
      repaired: true,
    });
  });

  it("leaves a genuine markdown link untouched", () => {
    expect(repairAutolinkPath("[click](https://example.com)")).toEqual({
      value: "[click](https://example.com)",
      repaired: false,
    });
  });

  it("leaves a plain path untouched", () => {
    expect(repairAutolinkPath("/Users/x/proj/notes.md")).toEqual({
      value: "/Users/x/proj/notes.md",
      repaired: false,
    });
  });
});

describe("argOptionalPath", () => {
  it("unwraps a degenerate autolink path", () => {
    expect(argOptionalPath("spawn", { template_path: "[a/t.md](http://a/t.md)" }, "template_path")).toBe("a/t.md");
  });
  it("returns undefined for an absent optional path", () => {
    expect(argOptionalPath("spawn", {}, "template_path")).toBeUndefined();
  });
  it("leaves a plain path untouched", () => {
    expect(argOptionalPath("spawn", { template_path: "/x/y.md" }, "template_path")).toBe("/x/y.md");
  });
  it("errors on a non-string path", () => {
    const r = argOptionalPath("spawn", { template_path: 7 }, "template_path");
    expect((r as { content?: string }).content ?? "").toContain("must be a string");
  });
});

describe("telemetry sink", () => {
  it("reports the repair kind on accept, and unsets cleanly", () => {
    const seen: ArgRepairKind[] = [];
    setArgRepairSink(({ kind }) => seen.push(kind));
    try {
      coerceStringArray("kill_shell", "ids", '["a"]');
      coerceStringArray("kill_shell", "ids", "bare");
      expect(seen).toEqual(["json_string_array", "bare_string_to_array"]);
    } finally {
      setArgRepairSink(null);
    }
  });
});

describe("write_file path autolink repair (end-to-end, content untouched)", () => {
  it("creates the unwrapped filename, not the literal autolink", async () => {
    const root = mkdtempSync(join(tmpdir(), "swarmflow-argrepair-"));
    try {
      const res = await executeTool(
        "write_file",
        {
          path: `[${join(root, "out.md")}](http://${join(root, "out.md")})`,
          // content that *looks* like a path autolink must NOT be rewritten
          content: "see [x.md](http://x.md) for details",
        },
        { projectRoot: root },
      );
      expect(res.content).not.toContain("ERROR");
      const written = readFileSync(join(root, "out.md"), "utf8");
      expect(written).toBe("see [x.md](http://x.md) for details");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
