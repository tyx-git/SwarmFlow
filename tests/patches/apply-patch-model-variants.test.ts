/**
 * 模型可能产生的补丁变体：多余空格/tab、CRLF/孤立 CR/重复 CR、
 * hunk 之间的空行、代码围栏与正文散文。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyHunks, createNodePatchIo } from "../../src/patches/apply-patch/apply.js";
import {
  EDIT_PAYLOAD_SPEC,
  extractCompletePayloadBlocks,
  findPayloadBlocks,
  removePayloadBlocks,
  resolveRoundPayloads,
} from "../../src/blocks/payload-blocks.js";
import { parsePatch } from "../../src/patches/apply-patch/parser.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const root of cleanup.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "swarmflow-patch-variants-"));
  cleanup.push(root);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content, "utf8");
  }
  return root;
}

async function apply(patch: string, files: Record<string, string> = {}): Promise<string> {
  const root = makeRoot(files);
  await applyHunks(parsePatch(patch), { cwd: root, io: createNodePatchIo() });
  return root;
}

function read(root: string, name: string): string {
  return readFileSync(join(root, name), "utf8");
}

describe("apply-patch model variants", () => {
  it("normalises CRLF, lone CR, and repeated CR line endings", async () => {
    const lf = await apply(
      "*** Begin Patch\n*** Add File: lf.txt\n+hello\n*** End Patch",
    );
    expect(read(lf, "lf.txt")).toBe("hello\n");

    const crlf = await apply(
      "*** Begin Patch\r\n*** Add File: crlf.txt\r\n+hello\r\n*** End Patch\r\n",
    );
    expect(read(crlf, "crlf.txt")).toBe("hello\n");

    const cr = await apply(
      "*** Begin Patch\r*** Add File: cr.txt\r+hello\r*** End Patch",
    );
    expect(read(cr, "cr.txt")).toBe("hello\n");

    const doubled = await apply(
      "*** Begin Patch\r\r\n*** Add File: doubled.txt\r\r\n+hello\r\r\n*** End Patch\r\r\n",
    );
    expect(read(doubled, "doubled.txt")).toBe("hello\n");
  });

  it("accepts extra spaces/tabs after hunk markers and Move to", async () => {
    const root = await apply(
      [
        "*** Begin Patch",
        "*** Add File:    a.txt",
        "+one",
        "*** Update File:\t  b.txt",
        "*** Move to:   nested/c.txt",
        "@@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n"),
      { "b.txt": "old\n" },
    );

    expect(read(root, "a.txt")).toBe("one\n");
    expect(read(root, "nested/c.txt")).toBe("new\n");
  });

  it("accepts surrounding whitespace on top-level markers", async () => {
    const root = await apply(
      "  *** Begin Patch  \n  *** Add File: a.txt  \n+hello\n  *** End Patch  ",
    );
    expect(read(root, "a.txt")).toBe("hello\n");
  });

  it("drops formatting blank lines between hunks and before End Patch", async () => {
    const root = await apply(
      [
        "*** Begin Patch",
        "",
        "*** Update File: a.txt",
        "",
        "@@",
        "",
        "-old",
        "+new",
        "",
        "*** Update File: b.txt",
        "",
        "@@",
        "-old",
        "+new",
        "",
        "*** End Patch",
      ].join("\n"),
      { "a.txt": "old\n", "b.txt": "old\n" },
    );

    expect(read(root, "a.txt")).toBe("new\n");
    expect(read(root, "b.txt")).toBe("new\n");
  });

  it("keeps an intentional empty context line inside an update chunk", async () => {
    const root = await apply(
      [
        "*** Begin Patch",
        "*** Update File: a.txt",
        "@@",
        " alpha",
        "",
        "-beta",
        "+BETA",
        "*** End Patch",
      ].join("\n"),
      { "a.txt": "alpha\n\nbeta\n" },
    );
    expect(read(root, "a.txt")).toBe("alpha\n\nBETA\n");
  });

  it("keeps a single-space empty context line", async () => {
    const root = await apply(
      [
        "*** Begin Patch",
        "*** Update File: a.txt",
        "@@",
        " alpha",
        " ",
        "-beta",
        "+BETA",
        "*** End Patch",
      ].join("\n"),
      { "a.txt": "alpha\n\nbeta\n" },
    );
    expect(read(root, "a.txt")).toBe("alpha\n\nBETA\n");
  });

  it("preserves multiple spaces in added and context content", async () => {
    const added = await apply(
      "*** Begin Patch\n*** Add File: spaced.txt\n+  lead and trail  \n*** End Patch",
    );
    expect(read(added, "spaced.txt")).toBe("  lead and trail  \n");

    const updated = await apply(
      [
        "*** Begin Patch",
        "*** Update File: a.txt",
        "@@",
        "   indented",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n"),
      { "a.txt": "  indented\nold\n" },
    );
    expect(read(updated, "a.txt")).toBe("  indented\nnew\n");
  });

  it("extracts CR-only fenced patches from assistant prose", async () => {
    const text = [
      "I will apply this:",
      "",
      "```patch",
      "*** Begin Patch",
      "*** Add File: a.txt",
      "+hello",
      "*** End Patch",
      "```",
      "",
      "done",
    ].join("\r");

    const blocks = findPayloadBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.complete).toBe(true);
    expect(blocks[0]!.text).not.toContain("\r");
    expect(extractCompletePayloadBlocks(text, EDIT_PAYLOAD_SPEC)).toEqual([blocks[0]!.text]);

    const payloads = resolveRoundPayloads([{ id: "call-1", name: "edit" }], text);
    const payload = payloads.get("call-1");
    expect(payload).toBeDefined();
    await expect(apply(payload!)).resolves.toBeTypeOf("string");

    const stripped = removePayloadBlocks(text, blocks);
    expect(stripped).toContain("I will apply this:");
    expect(stripped).toContain("done");
    expect(stripped).not.toContain("*** Begin Patch");
    expect(stripped).not.toContain("```");
  });

  it("still rejects a malformed add line", () => {
    expect(() => parsePatch(
      "*** Begin Patch\n*** Add File: a.txt\nnot-a-plus-line\n*** End Patch",
    )).toThrow(/not a valid hunk header/);
  });
});
