import { describe, expect, it } from "vitest";

import { seekSequence } from "../../src/patches/apply-patch/seek-sequence.js";

describe("apply-patch seekSequence", () => {
  it("finds an exact sequence", () => {
    expect(seekSequence(["foo", "bar", "baz"], ["bar", "baz"], 0, false)).toBe(1);
  });

  it("ignores trailing whitespace on every line", () => {
    expect(seekSequence(["foo   ", "bar\t\t"], ["foo", "bar"], 0, false)).toBe(0);
  });

  it("ignores leading and trailing whitespace on every line", () => {
    expect(seekSequence(["    foo   ", "   bar\t"], ["foo", "bar"], 0, false)).toBe(0);
  });

  it("prefers the first rstrip match over an earlier trim-only match", () => {
    // 下标 0 只有 trim 后相等；下标 1 是 rstrip 匹配，必须先被选中。
    expect(seekSequence(["  foo", "foo "], ["foo"], 0, false)).toBe(1);
  });

  it("normalises common Unicode punctuation as a last resort", () => {
    const lines = ["const label = \u201Cna\u00EFve \u2014 caf\u00E9\u201D;"];
    const pattern = ['const label = "na\u00EFve - caf\u00E9";'];
    expect(seekSequence(lines, pattern, 0, false)).toBe(0);
  });

  it("returns the cursor position for an empty pattern", () => {
    expect(seekSequence(["a", "b"], [], 1, false)).toBe(1);
  });

  it("returns null when the pattern is longer than the input", () => {
    expect(seekSequence(["just one line"], ["too", "many", "lines"], 0, false)).toBeNull();
  });

  it("anchors EOF patterns to the end of the file", () => {
    const lines = ["first", "second"];
    expect(seekSequence(lines, ["first"], 0, true)).toBeNull();
    expect(seekSequence(lines, ["second"], 0, true)).toBe(1);
  });

  it("respects the monotonic cursor for repeated content", () => {
    const lines = ["}", "x", "}", "y"];
    expect(seekSequence(lines, ["}"], 0, false)).toBe(0);
    expect(seekSequence(lines, ["}"], 1, false)).toBe(2);
  });
});
