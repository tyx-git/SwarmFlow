import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { executeTool } from "../../src/tools/dispatch.js";
import { buildToolExecutors } from "../../src/tools/runtime.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const root of cleanup.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "swarmflow-patch-edit-"));
  cleanup.push(root);
  return root;
}

function wrap(body: string): string {
  return `*** Begin Patch\n${body}\n*** End Patch`;
}

async function runPatch(
  root: string,
  patch: string,
  args: Record<string, unknown> = {},
) {
  return executeTool("edit", args, { projectRoot: root, toolPayload: patch });
}

describe("edit patch tool", () => {
  it("creates nested files from an Add File hunk", async () => {
    const root = makeRoot();
    const result = await runPatch(
      root,
      wrap("*** Add File: nested/new.txt\n+hello\n+world"),
    );
    expect(result.content).toBe(
      "Success. Updated the following files:\nA nested/new.txt",
    );
    expect(readFileSync(join(root, "nested", "new.txt"), "utf8")).toBe(
      "hello\nworld\n",
    );
    expect(result.metadata["changedPaths"]).toEqual([
      resolve(root, "nested", "new.txt"),
    ]);
    expect(result.metadata["patchFiles"]).toEqual([
      { kind: "A", path: "nested/new.txt" },
    ]);
    expect(result.metadata["fileModifyDataList"]).toHaveLength(1);
  });

  it("updates a CRLF file while preserving its line endings", async () => {
    const root = makeRoot();
    const file = join(root, "lines.txt");
    writeFileSync(file, "one\r\ntwo\r\nthree\r\n", "utf8");
    const result = await runPatch(
      root,
      wrap("*** Update File: lines.txt\n@@\n one\n-two\n+TWO\n three"),
    );
    expect(readFileSync(file, "utf8")).toBe("one\r\nTWO\r\nthree\r\n");
    expect(result.content).toBe(
      "Success. Updated the following files:\nM lines.txt",
    );
  });

  it("applies Add, Update, and Delete in one patch with an A/M/D summary", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "modify.txt"), "line1\nline2\n", "utf8");
    writeFileSync(join(root, "delete.txt"), "gone\n", "utf8");

    const result = await runPatch(
      root,
      wrap([
        "*** Add File: nested/new.txt",
        "+created",
        "*** Delete File: delete.txt",
        "*** Update File: modify.txt",
        "@@",
        "-line2",
        "+changed",
      ].join("\n")),
    );

    expect(result.content).toBe(
      [
        "Success. Updated the following files:",
        "A nested/new.txt",
        "M modify.txt",
        "D delete.txt",
      ].join("\n"),
    );
    expect(readFileSync(join(root, "nested", "new.txt"), "utf8")).toBe("created\n");
    expect(readFileSync(join(root, "modify.txt"), "utf8")).toBe("line1\nchanged\n");
    expect(existsSync(join(root, "delete.txt"))).toBe(false);
  });

  it("moves a file and rewrites its content", async () => {
    const root = makeRoot();
    mkdirSync(join(root, "old"), { recursive: true });
    writeFileSync(join(root, "old", "name.txt"), "old content\n", "utf8");

    const result = await runPatch(
      root,
      wrap(
        [
          "*** Update File: old/name.txt",
          "*** Move to: renamed/dir/name.txt",
          "@@",
          "-old content",
          "+new content",
        ].join("\n"),
      ),
    );

    expect(existsSync(join(root, "old", "name.txt"))).toBe(false);
    expect(readFileSync(join(root, "renamed", "dir", "name.txt"), "utf8")).toBe(
      "new content\n",
    );
    expect(result.content).toBe(
      "Success. Updated the following files:\nM renamed/dir/name.txt",
    );
    expect(result.metadata["patchFiles"]).toEqual([
      { kind: "M", path: "renamed/dir/name.txt", from: "old/name.txt" },
    ]);
    expect(result.metadata["changedPaths"]).toEqual(expect.arrayContaining([
      resolve(root, "old", "name.txt"),
      resolve(root, "renamed", "dir", "name.txt"),
    ]));
    expect(result.metadata["fileModifyDataList"]).toMatchObject([{
      filePath: resolve(root, "renamed", "dir", "name.txt"),
      mode: "replace",
      hunks: [{ additions: ["new content"] }],
    }]);
  });

  it("keeps earlier files when a later hunk fails, and reports them", async () => {
    const root = makeRoot();
    const result = await runPatch(
      root,
      wrap(
        [
          "*** Add File: created.txt",
          "+hello",
          "*** Update File: missing.txt",
          "@@",
          "-x",
          "+y",
        ].join("\n"),
      ),
    );

    expect(result.content).toContain("Failed to read file to update");
    expect(result.content).toContain("Applied before the failure:");
    expect(result.content).toContain("created.txt");
    expect(result.metadata["patchFiles"]).toEqual([
      { kind: "A", path: "created.txt" },
    ]);
    expect(result.metadata["changedPaths"]).toEqual([
      resolve(root, "created.txt"),
    ]);
    expect(readFileSync(join(root, "created.txt"), "utf8")).toBe("hello\n");
  });

  it("rejects a call without a patch payload", async () => {
    const root = makeRoot();
    const result = await executeTool("edit", {}, { projectRoot: root });
    expect(result.content).toContain("edit requires a patch");
  });

  it("rejects patch arguments instead of reading them from JSON", async () => {
    const root = makeRoot();
    const result = await runPatch(
      root,
      wrap("*** Add File: a.txt\n+hello"),
      { patch: "*** Begin Patch\n*** End Patch" },
    );
    expect(result.content).toContain("edit takes no arguments");
    expect(existsSync(join(root, "a.txt"))).toBe(false);
  });

  it("returns a parse error for a malformed patch", async () => {
    const root = makeRoot();
    const result = await runPatch(root, "not a patch");
    expect(result.content).toBe(
      "ERROR: Invalid patch: The first line of the patch must be '*** Begin Patch'",
    );
  });

  it("refuses paths outside the project root", async () => {
    const root = makeRoot();
    const result = await runPatch(
      root,
      wrap("*** Add File: ../outside.txt\n+nope"),
    );
    expect(result.content).toContain("outside the project root boundary");
    expect(existsSync(join(root, "..", "outside.txt"))).toBe(false);
  });

  it("refuses NUL-containing content", async () => {
    const root = makeRoot();
    const result = await runPatch(
      root,
      wrap("*** Add File: binary.txt\n+abc\0def"),
    );
    expect(result.content).toContain("binary file");
    expect(existsSync(join(root, "binary.txt"))).toBe(false);
  });

  it("refuses a Move target equal to the source", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "same.txt"), "old\n", "utf8");
    const result = await runPatch(
      root,
      wrap(
        [
          "*** Update File: same.txt",
          "*** Move to: same.txt",
          "@@",
          "-old",
          "+new",
        ].join("\n"),
      ),
    );
    expect(result.content).toContain("Move target is the same as source");
    expect(readFileSync(join(root, "same.txt"), "utf8")).toBe("old\n");
  });

  it("notifies onFileWrite once per changed path", async () => {
    const root = makeRoot();
    const touched: string[] = [];
    const executors = buildToolExecutors({
      projectRoot: root,
      getSessionArtifactsDir: () => join(root, ".artifacts"),
      supportsMultimodal: false,
      commExecutors: {},
      onFileWrite: (filePath) => touched.push(filePath),
    });

    const result = await executors["edit"]!({}, {
      toolPayload: wrap("*** Add File: reload.txt\n+hello"),
    });
    expect(typeof result).not.toBe("string");
    expect(touched).toEqual([resolve(root, "reload.txt")]);
  });
});

describe("edit missing update target", () => {
  it("reports the missing path for an Update File hunk", async () => {
    const root = makeRoot();
    const result = await runPatch(
      root,
      wrap("*** Update File: missing.txt\n@@\n-x\n+y"),
    );
    expect(result.content).toContain("Failed to read file to update");
    expect(result.content).toContain("missing.txt");
  });
});
