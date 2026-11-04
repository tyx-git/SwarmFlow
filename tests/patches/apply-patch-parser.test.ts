import { describe, expect, it } from "vitest";

import {
  ParseError,
  formatParseError,
  parsePatch,
} from "../../src/patches/apply-patch/parser.js";

describe("apply-patch parser", () => {
  it("parses an add-file hunk and always appends a newline", () => {
    const hunks = parsePatch(
      "*** Begin Patch\n*** Add File: nested/new.txt\n+hello\n+world\n*** End Patch",
    );
    expect(hunks).toEqual([
      { kind: "add", path: "nested/new.txt", contents: "hello\nworld\n" },
    ]);
  });

  it("parses multiple operations in one patch", () => {
    const hunks = parsePatch(
      [
        "*** Begin Patch",
        "*** Add File: nested/new.txt",
        "+created",
        "*** Delete File: delete.txt",
        "*** Update File: modify.txt",
        "@@",
        "-line2",
        "+changed",
        "*** End Patch",
      ].join("\n"),
    );
    expect(hunks.map((h) => h.kind)).toEqual(["add", "delete", "update"]);
    expect(hunks[2]).toMatchObject({
      kind: "update",
      path: "modify.txt",
      movePath: null,
      chunks: [
        {
          changeContext: null,
          oldLines: ["line2"],
          newLines: ["changed"],
          isEndOfFile: false,
        },
      ],
    });
  });

  it("parses @@ context anchors and context lines on both sides", () => {
    const [hunk] = parsePatch(
      [
        "*** Begin Patch",
        "*** Update File: multi.txt",
        "@@ function alpha",
        " context",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n"),
    );
    expect(hunk).toMatchObject({
      kind: "update",
      chunks: [
        {
          changeContext: "function alpha",
          oldLines: ["context", "old"],
          newLines: ["context", "new"],
          contextLineIndices: [[0, 0]],
        },
      ],
    });
  });

  it("parses Move to only before the first chunk", () => {
    const [hunk] = parsePatch(
      [
        "*** Begin Patch",
        "*** Update File: old/name.txt",
        "*** Move to: renamed/dir/name.txt",
        "@@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n"),
    );
    expect(hunk).toMatchObject({
      kind: "update",
      path: "old/name.txt",
      movePath: "renamed/dir/name.txt",
    });
  });

  it("parses an end-of-file anchor", () => {
    const [hunk] = parsePatch(
      [
        "*** Begin Patch",
        "*** Update File: file.txt",
        "@@",
        " first",
        "-second",
        "+second updated",
        "*** End of File",
        "*** End Patch",
      ].join("\n"),
    );
    expect(hunk).toMatchObject({ kind: "update" });
    if (hunk.kind !== "update") throw new Error("expected update hunk");
    expect(hunk.chunks[0]!.isEndOfFile).toBe(true);
  });

  it("accepts whitespace around patch markers and hunk headers", () => {
    const hunks = parsePatch(
      [
        "  *** Begin Patch",
        "  *** Update File: foo.txt",
        "@@",
        "-old",
        "+new",
        "*** End Patch  ",
      ].join("\n"),
    );
    expect(hunks).toHaveLength(1);
  });

  it("rejects a missing begin marker with the codex message", () => {
    try {
      parsePatch("*** Update File: foo.txt\n@@\n-old\n+new\n*** End Patch");
      throw new Error("expected parse failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).kind).toBe("invalid_patch");
      expect(formatParseError(error as ParseError)).toBe(
        "Invalid patch: The first line of the patch must be '*** Begin Patch'",
      );
    }
  });

  it("rejects an empty update hunk at the header line", () => {
    try {
      parsePatch(
        "*** Begin Patch\n*** Update File: foo.txt\n*** End Patch",
      );
      throw new Error("expected parse failure");
    } catch (error) {
      const parseError = error as ParseError;
      expect(parseError.kind).toBe("invalid_hunk");
      expect(parseError.lineNumber).toBe(2);
      expect(formatParseError(parseError)).toBe(
        "Invalid patch hunk on line 2: Update file hunk for path 'foo.txt' is empty",
      );
    }
  });

  it("rejects an update chunk with no lines", () => {
    try {
      parsePatch(
        "*** Begin Patch\n*** Update File: foo.txt\n@@\n*** End Patch",
      );
      throw new Error("expected parse failure");
    } catch (error) {
      const parseError = error as ParseError;
      expect(parseError.kind).toBe("invalid_hunk");
      expect(parseError.message).toBe("Update hunk does not contain any lines");
    }
  });

  it("rejects an invalid hunk header", () => {
    try {
      parsePatch("*** Begin Patch\n*** Frobnicate File: foo\n*** End Patch");
      throw new Error("expected parse failure");
    } catch (error) {
      const parseError = error as ParseError;
      expect(parseError.kind).toBe("invalid_hunk");
      expect(parseError.message).toContain("is not a valid hunk header");
    }
  });
});
