import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyHunks,
  createNodePatchIo,
  type ApplyPatchFailure,
} from "../../src/patches/apply-patch/apply.js";
import {
  ParseError,
  formatParseError,
  parsePatch,
} from "../../src/patches/apply-patch/parser.js";

const scenariosRoot = join(process.cwd(), "tests", "fixtures", "apply-patch");

const EXPECTED_FAILURES: Record<string, string> = {
  "005_rejects_empty_patch": "No files were modified.",
  "006_rejects_missing_context": "Failed to find expected lines",
  "007_rejects_missing_file_delete": "Failed to delete file",
  "008_rejects_empty_update_hunk": "Update file hunk for path 'foo.txt' is empty",
  "009_requires_existing_file_for_update": "Failed to read file to update",
  "012_delete_directory_fails": "Failed to delete file",
  "013_rejects_invalid_hunk_header": "is not a valid hunk header",
  "015_failure_after_partial_success_leaves_changes": "Failed to read file to update",
};

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scenarioDirs(): string[] {
  return readdirSync(scenariosRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        result[relative(root, abs).replaceAll("\\", "/")] = readFileSync(abs).toString("hex");
      }
    }
  };
  walk(root);
  return result;
}

function makeScenarioRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `swarmflow-patch-${name}-`));
  cleanup.push(root);
  const input = join(scenariosRoot, name, "input");
  if (existsSync(input)) {
    cpSync(input, root, { recursive: true });
  }
  return root;
}

async function runScenario(name: string): Promise<string> {
  const root = makeScenarioRoot(name);
  const patch = readFileSync(join(scenariosRoot, name, "patch.txt"), "utf8");
  let hunks;
  try {
    hunks = parsePatch(patch);
  } catch (error) {
    if (error instanceof ParseError) throw new Error(formatParseError(error));
    throw error;
  }
  const { summary } = await applyHunks(hunks, {
    cwd: root,
    io: createNodePatchIo(),
  });
  return summary;
}

describe("codex apply-patch fixtures", () => {
  for (const name of scenarioDirs()) {
    it(name, async () => {
      const root = makeScenarioRoot(name);
      const patch = readFileSync(join(scenariosRoot, name, "patch.txt"), "utf8");
      let failure: string | null = null;
      try {
        const hunks = parsePatch(patch);
        await applyHunks(hunks, { cwd: root, io: createNodePatchIo() });
      } catch (error) {
        const parseError = error instanceof ParseError
          ? formatParseError(error)
          : (error as ApplyPatchFailure).message;
        failure = parseError!;
      }

      const expected = snapshot(join(scenariosRoot, name, "expected"));
      expect(snapshot(root)).toEqual(expected);

      const expectedFailure = EXPECTED_FAILURES[name];
      if (expectedFailure) {
        expect(failure).not.toBeNull();
        expect(failure).toContain(expectedFailure);
      } else {
        expect(failure).toBeNull();
      }
    });
  }

  it("prints the codex success summary in A/M/D order", async () => {
    const summary = await runScenario("002_multiple_operations");
    expect(summary).toBe(
      [
        "Success. Updated the following files:",
        "A nested/new.txt",
        "M modify.txt",
        "D delete.txt",
        "",
      ].join("\n"),
    );
  });

  it("keeps changes written before a later hunk fails (015)", async () => {
    const root = makeScenarioRoot("015_failure_after_partial_success_leaves_changes");
    const patch = readFileSync(
      join(scenariosRoot, "015_failure_after_partial_success_leaves_changes", "patch.txt"),
      "utf8",
    );
    await expect(
      applyHunks(parsePatch(patch), { cwd: root, io: createNodePatchIo() }),
    ).rejects.toThrow("Failed to read file to update");
    expect(readFileSync(join(root, "created.txt"), "utf8")).toBe("hello\n");
  });

  it("preserves CRLF bytes in 023", async () => {
    const root = makeScenarioRoot("023_preserves_crlf_line_endings");
    const patch = readFileSync(
      join(scenariosRoot, "023_preserves_crlf_line_endings", "patch.txt"),
      "utf8",
    );
    await applyHunks(parsePatch(patch), { cwd: root, io: createNodePatchIo() });
    const files = snapshot(root);
    expect(files["lines.txt"]).toContain("0d0a");
  });
});
