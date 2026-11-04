import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { EDIT_PATCH } from "../../src/tools/definitions.js";
import { makeScriptedSession, type SessionHarness } from "../helpers/session-harness.js";

function editRound(patch: string) {
  return {
    text: patch,
    toolCalls: [{ id: "call-edit", name: "edit", arguments: {} }],
  };
}

async function runEditTurn(h: SessionHarness): Promise<void> {
  await h.session.turn("apply the patch");
  expect(h.session.getPendingAsk()).toBeNull();
}

describe("rewind for edit file mutations", () => {
  it("reverts multiple updated and created files from one edit call", async () => {
    const h = makeScriptedSession({
      rounds: [
        editRound([
          "*** Begin Patch",
          "*** Update File: a.txt",
          "@@",
          "-old-a",
          "+new-a",
          "*** Add File: nested/c.txt",
          "+created",
          "*** End Patch",
        ].join("\n")),
        { text: "done" },
      ],
      tools: [EDIT_PATCH],
    });
    try {
      writeFileSync(join(h.projectRoot, "a.txt"), "old-a\n", "utf8");
      await runEditTurn(h);
      expect(readFileSync(join(h.projectRoot, "a.txt"), "utf8")).toBe("new-a\n");
      expect(existsSync(join(h.projectRoot, "nested", "c.txt"))).toBe(true);

      const plan = await h.session.planRewind(1);
      expect(plan.applicable.map((entry) => entry.path).sort()).toEqual([
        join(h.projectRoot, "a.txt"),
        join(h.projectRoot, "nested", "c.txt"),
      ].sort());

      const result = await h.session.rewindFiles(plan);
      expect(result.error).toBeUndefined();
      expect(readFileSync(join(h.projectRoot, "a.txt"), "utf8")).toBe("old-a\n");
      expect(existsSync(join(h.projectRoot, "nested", "c.txt"))).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it("restores a deleted file and undoes a move", async () => {
    const h = makeScriptedSession({
      rounds: [
        editRound([
          "*** Begin Patch",
          "*** Delete File: deleted.txt",
          "*** Update File: old.txt",
          "*** Move to: moved/new.txt",
          "@@",
          "-old",
          "+moved",
          "*** End Patch",
        ].join("\n")),
        { text: "done" },
      ],
      tools: [EDIT_PATCH],
    });
    try {
      writeFileSync(join(h.projectRoot, "deleted.txt"), "restore me\n", "utf8");
      writeFileSync(join(h.projectRoot, "old.txt"), "old\n", "utf8");

      await runEditTurn(h);
      expect(existsSync(join(h.projectRoot, "deleted.txt"))).toBe(false);
      expect(existsSync(join(h.projectRoot, "old.txt"))).toBe(false);
      expect(readFileSync(join(h.projectRoot, "moved", "new.txt"), "utf8")).toBe("moved\n");

      const plan = await h.session.planRewind(1);
      const result = await h.session.rewindFiles(plan);
      expect(result.error).toBeUndefined();
      expect(readFileSync(join(h.projectRoot, "deleted.txt"), "utf8")).toBe("restore me\n");
      expect(readFileSync(join(h.projectRoot, "old.txt"), "utf8")).toBe("old\n");
      expect(existsSync(join(h.projectRoot, "moved", "new.txt"))).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it("tracks per-file revert state inside a multi-file entry", async () => {
    const h = makeScriptedSession({
      rounds: [
        editRound([
          "*** Begin Patch",
          "*** Add File: one.txt",
          "+one",
          "*** Add File: two.txt",
          "+two",
          "*** End Patch",
        ].join("\n")),
        { text: "done" },
      ],
      tools: [EDIT_PATCH],
    });
    try {
      await runEditTurn(h);
      const firstPlan = await h.session.planRewind(1);
      expect(firstPlan.applicable).toHaveLength(2);

      // 只回退第一条，模拟部分成功/部分冲突后的状态。
      const partialPlan = { ...firstPlan, applicable: [firstPlan.applicable[0]!], warnings: [] };
      const result = await h.session.rewindFiles(partialPlan);
      expect(result.error).toBeUndefined();
      expect(existsSync(join(h.projectRoot, "one.txt"))).toBe(false);
      expect(existsSync(join(h.projectRoot, "two.txt"))).toBe(true);

      const secondPlan = await h.session.planRewind(1);
      expect(secondPlan.applicable.map((entry) => entry.path)).toEqual([
        join(h.projectRoot, "two.txt"),
      ]);
      expect(secondPlan.conflicts.some((entry) => (
        entry.path === join(h.projectRoot, "one.txt")
      ))).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it("marks a deleted file as a conflict when it was recreated externally", async () => {
    const h = makeScriptedSession({
      rounds: [
        editRound([
          "*** Begin Patch",
          "*** Delete File: gone.txt",
          "*** End Patch",
        ].join("\n")),
        { text: "done" },
      ],
      tools: [EDIT_PATCH],
    });
    try {
      mkdirSync(h.projectRoot, { recursive: true });
      writeFileSync(join(h.projectRoot, "gone.txt"), "before\n", "utf8");
      await runEditTurn(h);
      writeFileSync(join(h.projectRoot, "gone.txt"), "external\n", "utf8");

      const plan = await h.session.planRewind(1);
      expect(plan.conflicts).toContainEqual({
        path: join(h.projectRoot, "gone.txt"),
        reason: "file_recreated",
      });
    } finally {
      h.dispose();
    }
  });
});
