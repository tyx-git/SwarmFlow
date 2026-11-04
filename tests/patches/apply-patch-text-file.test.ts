import { describe, expect, it } from "vitest";

import { SourceFile } from "../../src/patches/apply-patch/text-file.js";

describe("apply-patch SourceFile", () => {
  it("keeps mixed line endings on untouched lines", () => {
    const file = SourceFile.parse("one\r\ntwo\rthree\nfour\r\n");
    expect(file.lineTexts()).toEqual(["one", "two", "three", "four"]);
    expect(file.intoContents()).toBe("one\r\ntwo\rthree\nfour\r\n");
  });

  it("uses the first ending for inserted lines and preserves context lines", () => {
    const file = SourceFile.parse("one\r\ntwo\rthree\nfour\r\n");
    file.applyReplacements([[2, 1, ["THREE"]]]);
    expect(file.intoContents()).toBe("one\r\ntwo\rTHREE\r\nfour\r\n");
  });

  it("adds a trailing newline to an unterminated last line", () => {
    const file = SourceFile.parse("no newline at end");
    file.applyReplacements([[0, 1, ["first line", "second line"]]]);
    expect(file.intoContents()).toBe("first line\nsecond line\n");
  });

  it("rejects overlapping replacements instead of corrupting the file", () => {
    const file = SourceFile.parse("a\nb\nc\nd\n");
    expect(() => file.applyReplacements([[1, 2, ["B"]], [0, 1, ["A"]]])).toThrow(
      /overlapping replacements/i,
    );
  });
});
