import { describe, expect, it } from "bun:test";

import {
  buildFileReferenceLabel,
  displayWidthWithNewlines,
  findFileReferenceQuery,
  getDisplaySpanEndingAtOffset,
  getDisplaySpanStartingAtOffset,
  getTextDiffRange,
  serializeVisibleTextWithTokens,
  sliceTextByOffset,
} from "../opentui-src/composer-token-logic.js";

describe("opentui composer tokens", () => {
  it("counts display width with newlines", () => {
    expect(displayWidthWithNewlines("abc")).toBe(3);
    expect(displayWidthWithNewlines("前a\n后")).toBe(6);
    expect(displayWidthWithNewlines("🙂é\t👨‍👩‍👧‍👦")).toBe(7);
  });

  it("detects the inserted paste range", () => {
    const diff = getTextDiffRange("hello world", "hello line1\nline2 world");
    expect(diff).not.toBeNull();
    expect(diff?.insertedText).toBe("line1\nline2 ");
    expect(diff?.startOffset).toBe(displayWidthWithNewlines("hello "));
  });

  it("builds quoted @file labels only when needed", () => {
    expect(buildFileReferenceLabel("README.md")).toBe("@README.md");
    expect(buildFileReferenceLabel("docs/my file.md")).toBe('@"docs/my file.md"');
  });

  it("finds @file query bounds at the cursor", () => {
    const text = "check @src/fi and continue";
    const cursorOffset = displayWidthWithNewlines("check @src/fi");
    const query = findFileReferenceQuery(text, cursorOffset);
    expect(query).toEqual({
      prefix: "src/fi",
      startOffset: displayWidthWithNewlines("check "),
      endOffset: displayWidthWithNewlines("check @src/fi"),
    });
  });

  it("finds @file query bounds after grapheme clusters and tabs", () => {
    expect(findFileReferenceQuery("🙂 @foo", displayWidthWithNewlines("🙂 @foo"))).toEqual({
      prefix: "foo",
      startOffset: 3,
      endOffset: 7,
    });

    expect(findFileReferenceQuery("é @foo", displayWidthWithNewlines("é @foo"))).toEqual({
      prefix: "foo",
      startOffset: 2,
      endOffset: 6,
    });

    expect(findFileReferenceQuery("\t@foo", displayWidthWithNewlines("\t@foo"))).toEqual({
      prefix: "foo",
      startOffset: 2,
      endOffset: 6,
    });
  });

  it("slices text by display-width offsets", () => {
    const text = "前后 test";
    const start = displayWidthWithNewlines("前");
    const end = displayWidthWithNewlines("前后 t");
    expect(sliceTextByOffset(text, start, end)).toBe("后 t");
  });

  it("finds display spans for multibyte characters", () => {
    const text = "你好@a";
    expect(getDisplaySpanEndingAtOffset(text, 4)).toEqual({
      text: "好",
      startOffset: 2,
      endOffset: 4,
    });
    expect(getDisplaySpanStartingAtOffset(text, 0)).toEqual({
      text: "你",
      startOffset: 0,
      endOffset: 2,
    });
  });

  it("finds display spans for grapheme clusters", () => {
    expect(getDisplaySpanEndingAtOffset("👨‍👩‍👧‍👦x", 2)).toEqual({
      text: "👨‍👩‍👧‍👦",
      startOffset: 0,
      endOffset: 2,
    });

    expect(getDisplaySpanStartingAtOffset("éx", 0)).toEqual({
      text: "é",
      startOffset: 0,
      endOffset: 1,
    });
  });

  it("serializes visible token labels back to raw submit text", () => {
    const pasteLabel = "[line1 line2 line3 li... Pasted Text #1 - 20 lines]";
    const visibleText = `@README.md ${pasteLabel} done`;
    const fileStart = 0;
    const fileEnd = displayWidthWithNewlines("@README.md");
    const pasteStart = displayWidthWithNewlines("@README.md ");
    const pasteEnd = pasteStart + displayWidthWithNewlines(pasteLabel);

    expect(serializeVisibleTextWithTokens(visibleText, [
      { start: fileStart, end: fileEnd, submitText: "@README.md" },
      { start: pasteStart, end: pasteEnd, submitText: "line1\nline2\nline3" },
    ])).toBe("@README.md line1\nline2\nline3 done");
  });
});
