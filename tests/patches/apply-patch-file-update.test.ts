import { describe, expect, it } from "vitest";

import { deriveNewContentsFromChunks } from "../../src/patches/apply-patch/file-update.js";
import { parsePatch } from "../../src/patches/apply-patch/parser.js";

function updateChunks(patch: string) {
  const [hunk] = parsePatch(
    `*** Begin Patch\n*** Update File: file.txt\n${patch}\n*** End Patch`,
  );
  if (!hunk || hunk.kind !== "update") throw new Error("expected update hunk");
  return hunk.chunks;
}

describe("apply-patch deriveNewContentsFromChunks", () => {
  it("keeps context lines byte-for-byte and uses the preferred EOL for changed lines", () => {
    const result = deriveNewContentsFromChunks(
      "line1\r\nline2\r\nline3\n",
      "file.txt",
      updateChunks("@@\n line1\n-line2\n+changed\n line3"),
    );
    expect(result.newContents).toBe("line1\r\nchanged\r\nline3\n");
  });

  it("appends added lines at EOF when old_lines is empty", () => {
    const chunks = updateChunks("@@\n+added line 1\n+added line 2");
    const result = deriveNewContentsFromChunks("line1\nline2\n", "file.txt", chunks);
    expect(result.newContents).toBe("line1\nline2\nadded line 1\nadded line 2\n");
    expect(result.originalContents).toBe("line1\nline2\n");
  });

  it("retries without a trailing empty context line at EOF", () => {
    const result = deriveNewContentsFromChunks(
      "a\nb",
      "file.txt",
      updateChunks("@@\n a\n-b\n+c\n "),
    );
    expect(result.newContents).toBe("a\nc\n");
  });

  it("fails with the missing context line in the error message", () => {
    expect(() =>
      deriveNewContentsFromChunks(
        "line1\nline2\n",
        "file.txt",
        updateChunks("@@\n-missing\n+changed"),
      ),
    ).toThrow("Failed to find expected lines in file.txt:\nmissing");
  });

  it("fails when an @@ context anchor cannot be found", () => {
    expect(() =>
      deriveNewContentsFromChunks(
        "line1\nline2\n",
        "file.txt",
        updateChunks("@@ missing anchor\n-line1\n+changed"),
      ),
    ).toThrow("Failed to find context 'missing anchor' in file.txt");
  });

  it("uses the monotonic cursor for repeated old lines", () => {
    const result = deriveNewContentsFromChunks(
      "}\nfirst\n}\nsecond\n",
      "file.txt",
      updateChunks("@@\n }\n-first\n+FIRST\n@@\n }\n-second\n+SECOND"),
    );
    expect(result.newContents).toBe("}\nFIRST\n}\nSECOND\n");
  });
});
