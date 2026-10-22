/**
 * 参数校验契约：合并前两套实现（返回 ToolResult / 抛 ToolArgValidationError）
 * 与 Session 三个薄委托的全部可观察行为。
 *
 * 本文件先对合并前的实现跑绿，再在两套实现合并到
 * `src/tools/arg-validation.ts` 后原样重跑；断言内容不变。
 */

import { describe, expect, it } from "vitest";

import { ToolResult } from "../../src/providers/response.js";
import { Session } from "../../src/session.js";
import {
  ToolArgValidationError,
  argOptionalInteger,
  argOptionalPath,
  argOptionalString,
  argRequiredString,
  argRequiredStringArray,
  expectArgsObject,
  optionalIntegerArg,
  optionalPathArg,
  optionalPositiveIntegerArg,
  optionalStringArg,
  requiredIntegerArg,
  requiredPathArg,
  requiredStringArg,
  requiredStringList,
  toolArgError,
} from "../../src/tools/arg-validation.js";

function thrown(fn: () => unknown): ToolArgValidationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ToolArgValidationError) return error;
    throw error;
  }
  throw new Error("expected ToolArgValidationError");
}

function resultContent(value: unknown): string {
  expect(value).toBeInstanceOf(ToolResult);
  return (value as ToolResult).content;
}

describe("ToolArgValidationError", () => {
  it("carries name, tool, field and message", () => {
    const error = thrown(() => requiredStringArg("read_file", { path: 1 }, "path"));
    expect(error.name).toBe("ToolArgValidationError");
    expect(error.toolName).toBe("read_file");
    expect(error.field).toBe("path");
    expect(error.message).toBe("'path' must be a string.");
  });
});

describe("expectArgsObject", () => {
  it("returns the same object for a valid args object", () => {
    const args = { a: 1 };
    expect(expectArgsObject("t", args)).toBe(args);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["array", []],
    ["string", "x"],
  ])("rejects %s with the root field", (_label, value) => {
    const error = thrown(() => expectArgsObject("t", value as never));
    expect(error.field).toBe("(root)");
    expect(error.message).toBe("arguments must be an object.");
  });
});

describe("requiredStringArg", () => {
  it("returns the value unchanged, including surrounding whitespace", () => {
    expect(requiredStringArg("t", { k: "  a  " }, "k")).toBe("  a  ");
  });

  it("accepts an empty string unless nonEmpty is set", () => {
    expect(requiredStringArg("t", { k: "" }, "k")).toBe("");
  });

  it.each([
    ["missing", {}],
    ["null", { k: null }],
    ["number", { k: 1 }],
    ["object", { k: {} }],
    ["array", { k: [] }],
  ])("rejects %s as a string", (_label, args) => {
    const error = thrown(() => requiredStringArg("t", args, "k"));
    expect(error.message).toBe("'k' must be a string.");
  });

  it.each([[""], ["   "], ["\n\t"]])("rejects whitespace-only %j when nonEmpty", (value) => {
    const error = thrown(() => requiredStringArg("t", { k: value }, "k", { nonEmpty: true }));
    expect(error.message).toBe("'k' must be a non-empty string.");
  });

  it("enforces maxLen at the boundary", () => {
    expect(requiredStringArg("t", { k: "abc" }, "k", { maxLen: 3 })).toBe("abc");
    const error = thrown(() => requiredStringArg("t", { k: "abcd" }, "k", { maxLen: 3 }));
    expect(error.message).toBe("'k' exceeds max length (3).");
  });

  it("counts maxLen in UTF-16 code units, matching String.length", () => {
    expect(requiredStringArg("t", { k: "😀" }, "k", { maxLen: 2 })).toBe("😀");
    const error = thrown(() => requiredStringArg("t", { k: "😀" }, "k", { maxLen: 1 }));
    expect(error.message).toBe("'k' exceeds max length (1).");
  });
});

describe("optionalStringArg", () => {
  it.each([[null], [undefined]])("returns the fallback for %j", (value) => {
    expect(optionalStringArg("t", { k: value }, "k", "fallback")).toBe("fallback");
  });

  it("returns an empty string rather than the fallback", () => {
    expect(optionalStringArg("t", { k: "" }, "k", "fallback")).toBe("");
  });

  it("returns a provided string unchanged", () => {
    expect(optionalStringArg("t", { k: " v " }, "k", "fallback")).toBe(" v ");
  });

  it("rejects non-string values", () => {
    const error = thrown(() => optionalStringArg("t", { k: 2 }, "k", "fallback"));
    expect(error.message).toBe("'k' must be a string.");
  });
});

describe("requiredPathArg", () => {
  it("unwraps degenerate markdown autolinks", () => {
    expect(requiredPathArg("t", { p: "[notes.md](http://notes.md)" }, "p")).toBe("notes.md");
    expect(requiredPathArg("t", { p: "[a/b.txt](a/b.txt)" }, "p")).toBe("a/b.txt");
  });

  it("leaves genuine markdown links and plain paths untouched", () => {
    expect(requiredPathArg("t", { p: "[click](https://example.com)" }, "p")).toBe(
      "[click](https://example.com)",
    );
    expect(requiredPathArg("t", { p: "/x/y.md" }, "p")).toBe("/x/y.md");
  });

  it("applies nonEmpty and maxLen before unwrapping", () => {
    const empty = thrown(() => requiredPathArg("t", { p: "" }, "p", { nonEmpty: true }));
    expect(empty.message).toBe("'p' must be a non-empty string.");
    const tooLong = thrown(() =>
      requiredPathArg("t", { p: "[a.md](http://a.md)" }, "p", { maxLen: 5 }));
    expect(tooLong.message).toBe("'p' exceeds max length (5).");
  });

  it("rejects non-string values", () => {
    const error = thrown(() => requiredPathArg("t", { p: 7 }, "p"));
    expect(error.message).toBe("'p' must be a string.");
  });
});

describe("optionalPathArg", () => {
  it("returns the fallback for null/undefined", () => {
    expect(optionalPathArg("t", {}, "p", ".")).toBe(".");
    expect(optionalPathArg("t", { p: null }, "p", ".")).toBe(".");
  });

  it("unwraps degenerate autolinks", () => {
    expect(optionalPathArg("t", { p: "[a.md](http://a.md)" }, "p", ".")).toBe("a.md");
  });

  it("leaves genuine links and plain paths untouched", () => {
    expect(optionalPathArg("t", { p: "[click](https://example.com)" }, "p", ".")).toBe(
      "[click](https://example.com)",
    );
    expect(optionalPathArg("t", { p: "/x" }, "p", ".")).toBe("/x");
  });

  it("returns the fallback unchanged instead of coercing it", () => {
    expect(optionalPathArg("t", {}, "p", "[a.md](http://a.md)")).toBe("[a.md](http://a.md)");
  });

  it("rejects non-string values", () => {
    const error = thrown(() => optionalPathArg("t", { p: 3 }, "p", "."));
    expect(error.message).toBe("'p' must be a string.");
  });
});

describe("integer validators", () => {
  it("optionalIntegerArg passes integers including zero and negatives", () => {
    expect(optionalIntegerArg("t", {}, "n")).toBeUndefined();
    expect(optionalIntegerArg("t", { n: null }, "n")).toBeUndefined();
    expect(optionalIntegerArg("t", { n: 0 }, "n")).toBe(0);
    expect(optionalIntegerArg("t", { n: -5 }, "n")).toBe(-5);
  });

  it.each([
    ["float", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["string", "3"],
    ["boolean", true],
  ])("optionalIntegerArg rejects %s", (_label, value) => {
    const error = thrown(() => optionalIntegerArg("t", { n: value }, "n"));
    expect(error.message).toBe("'n' must be an integer.");
  });

  it("optionalPositiveIntegerArg accepts 1+ and rejects 0/negative", () => {
    expect(optionalPositiveIntegerArg("t", {}, "n")).toBeUndefined();
    expect(optionalPositiveIntegerArg("t", { n: 1 }, "n")).toBe(1);
    expect(optionalPositiveIntegerArg("t", { n: 12 }, "n")).toBe(12);
    const zero = thrown(() => optionalPositiveIntegerArg("t", { n: 0 }, "n"));
    expect(zero.message).toBe("'n' must be >= 1 (got 0).");
    const negative = thrown(() => optionalPositiveIntegerArg("t", { n: -3 }, "n"));
    expect(negative.message).toBe("'n' must be >= 1 (got -3).");
    const float = thrown(() => optionalPositiveIntegerArg("t", { n: 1.5 }, "n"));
    expect(float.message).toBe("'n' must be an integer.");
  });

  it("requiredIntegerArg distinguishes missing from non-integer", () => {
    const missing = thrown(() => requiredIntegerArg("t", {}, "n"));
    expect(missing.message).toBe("'n' is required.");
    const bad = thrown(() => requiredIntegerArg("t", { n: 2.5 }, "n"));
    expect(bad.message).toBe("'n' must be an integer.");
    expect(requiredIntegerArg("t", { n: 4 }, "n")).toBe(4);
  });
});

describe("requiredStringList", () => {
  it("treats null as an empty list", () => {
    expect(requiredStringList("t", {}, "k")).toEqual([]);
    expect(requiredStringList("t", { k: null }, "k")).toEqual([]);
  });

  it("turns a non-empty string into a single-element list without trimming it", () => {
    expect(requiredStringList("t", { k: " a " }, "k")).toEqual([" a "]);
  });

  it("treats empty and whitespace-only strings as empty lists", () => {
    expect(requiredStringList("t", { k: "" }, "k")).toEqual([]);
    expect(requiredStringList("t", { k: "   " }, "k")).toEqual([]);
  });

  it("filters empty entries from string arrays while preserving originals", () => {
    expect(requiredStringList("t", { k: ["a", "", "  ", " b "] }, "k")).toEqual(["a", " b "]);
  });

  it("rejects mixed arrays and non-string values", () => {
    const mixed = thrown(() => requiredStringList("t", { k: ["a", 1] }, "k"));
    expect(mixed.message).toBe("'k' must be a string or an array of strings.");
    const number = thrown(() => requiredStringList("t", { k: 3 }, "k"));
    expect(number.message).toBe("'k' must be a string or an array of strings.");
  });
});

describe("ToolResult-returning adapters", () => {
  it("toolArgError builds the exact legacy message", () => {
    const result = toolArgError("read_file", "'path' must be a string.");
    expect(result).toBeInstanceOf(ToolResult);
    expect(result.content).toBe("Error: invalid arguments for read_file: 'path' must be a string.");
  });

  it("argOptionalString mirrors optionalStringArg, including null semantics", () => {
    expect(argOptionalString("t", {}, "k")).toBeUndefined();
    expect(argOptionalString("t", { k: null }, "k")).toBeUndefined();
    expect(argOptionalString("t", { k: "" }, "k")).toBe("");
    expect(argOptionalString("t", { k: "v" }, "k")).toBe("v");
    expect(resultContent(argOptionalString("t", { k: 1 }, "k"))).toBe(
      "Error: invalid arguments for t: 'k' must be a string.",
    );
  });

  it("argRequiredString mirrors requiredStringArg", () => {
    expect(argRequiredString("t", { k: " v " }, "k")).toBe(" v ");
    expect(argRequiredString("t", { k: "" }, "k")).toBe("");
    expect(resultContent(argRequiredString("t", {}, "k"))).toBe(
      "Error: invalid arguments for t: 'k' must be a string.",
    );
    expect(resultContent(argRequiredString("t", { k: "  " }, "k", { nonEmpty: true }))).toBe(
      "Error: invalid arguments for t: 'k' must be a non-empty string.",
    );
  });

  it("argRequiredStringArray accepts valid arrays by reference", () => {
    const ids = ["a", "b"];
    expect(argRequiredStringArray("t", { ids }, "ids")).toBe(ids);
    expect(argRequiredStringArray("t", { ids: [] }, "ids")).toEqual([]);
  });

  it("argRequiredStringArray repairs recoverable shapes", () => {
    expect(argRequiredStringArray("t", { ids: '["a","b"]' }, "ids")).toEqual(["a", "b"]);
    expect(argRequiredStringArray("t", { ids: "shell-1" }, "ids")).toEqual(["shell-1"]);
    expect(argRequiredStringArray("t", { ids: {} }, "ids")).toEqual([]);
    expect(argRequiredStringArray("t", { ids: { "0": "x", "1": "y" } }, "ids")).toEqual(["x", "y"]);
  });

  it("argRequiredStringArray rejects unrepairable values with legacy messages", () => {
    expect(resultContent(argRequiredStringArray("t", { ids: 5 }, "ids"))).toBe(
      "Error: invalid arguments for t: 'ids' must be an array of strings.",
    );
    expect(resultContent(argRequiredStringArray("t", { ids: { a: 1 } }, "ids"))).toBe(
      "Error: invalid arguments for t: 'ids' must be an array of strings.",
    );
  });

  it("argRequiredStringArray reports the offending element index", () => {
    expect(resultContent(argRequiredStringArray("t", { ids: ["a", 2] }, "ids"))).toBe(
      "Error: invalid arguments for t: 'ids[1]' must be a string.",
    );
  });

  it("argOptionalPath mirrors the throwing path validator but returns ToolResult", () => {
    expect(argOptionalPath("t", {}, "p")).toBeUndefined();
    expect(argOptionalPath("t", { p: "[a.md](http://a.md)" }, "p")).toBe("a.md");
    expect(argOptionalPath("t", { p: "[click](https://example.com)" }, "p")).toBe(
      "[click](https://example.com)",
    );
    expect(resultContent(argOptionalPath("t", { p: 7 }, "p"))).toBe(
      "Error: invalid arguments for t: 'p' must be a string.",
    );
  });

  it("argOptionalInteger mirrors optionalIntegerArg", () => {
    expect(argOptionalInteger("t", {}, "n")).toBeUndefined();
    expect(argOptionalInteger("t", { n: 0 }, "n")).toBe(0);
    expect(resultContent(argOptionalInteger("t", { n: 1.5 }, "n"))).toBe(
      "Error: invalid arguments for t: 'n' must be an integer.",
    );
  });
});

describe("Session argument-validation delegates (third layer)", () => {
  function fakeSession(): Record<string, unknown> {
    return Object.create(Session.prototype) as Record<string, unknown>;
  }

  it("spawn rejects missing, empty and wrong-typed id before touching state", async () => {
    const spawn = (Session.prototype as any)._execSpawn as (
      this: unknown,
      args: Record<string, unknown>,
    ) => Promise<ToolResult>;

    expect((await spawn.call(fakeSession(), { task: "t", mode: "m", template: "x" })).content).toBe(
      "Error: invalid arguments for spawn: 'id' must be a string.",
    );
    expect((await spawn.call(fakeSession(), { id: "", task: "t", mode: "m", template: "x" })).content).toBe(
      "Error: invalid arguments for spawn: 'id' must be a non-empty string.",
    );
    expect((await spawn.call(fakeSession(), { id: 7, task: "t", mode: "m", template: "x" })).content).toBe(
      "Error: invalid arguments for spawn: 'id' must be a string.",
    );
  });

  it("spawn keeps its template/template_path exclusivity errors", async () => {
    const spawn = (Session.prototype as any)._execSpawn as (
      this: unknown,
      args: Record<string, unknown>,
    ) => Promise<ToolResult>;

    expect((await spawn.call(fakeSession(), { id: "a", task: "t", mode: "m" })).content).toBe(
      "Error: must specify either 'template' or 'template_path'.",
    );
    expect(
      (await spawn.call(fakeSession(), {
        id: "a",
        task: "t",
        mode: "m",
        template: "x",
        template_path: "y",
      })).content,
    ).toBe("Error: cannot specify both 'template' and 'template_path'.");
  });

  it("kill_agent rejects unrepairable ids and keeps the empty-list guard", () => {
    const kill = (Session.prototype as any)._execKillAgent as (
      this: unknown,
      args: Record<string, unknown>,
    ) => ToolResult;

    expect(kill.call(fakeSession(), { ids: 5 }).content).toBe(
      "Error: invalid arguments for kill_agent: 'ids' must be an array of strings.",
    );
    expect(kill.call(fakeSession(), { ids: [] }).content).toBe("No agent IDs specified.");
  });
});
