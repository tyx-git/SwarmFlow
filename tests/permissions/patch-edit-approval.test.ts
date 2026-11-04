import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  PermissionAdvisor,
  PermissionRuleStore,
  type PermissionMode,
} from "../../src/permissions/index.js";
import { beforeToolExecute } from "../../src/session/tool-drain.js";
import type { GateDecision } from "../../src/tools/runtime.js";
import type { ToolPreflightContext } from "../../src/agents/tool-loop/types.js";

function posix(value: string): string {
  return value.replace(/\\/g, "/");
}

interface Fixture {
  root: string;
  outside: string;
  secondOutside: string;
  store: PermissionRuleStore;
  advisor: PermissionAdvisor;
}

function makeFixture(mode: PermissionMode = "reversible"): Fixture {
  const root = mkdtempSync(join(tmpdir(), "swarmflow-edit-approval-"));
  const outsideDir = resolve(root, "..", `swarmflow-edit-outside-${randomUUID().slice(0, 8)}`);
  const secondOutsideDir = resolve(root, "..", `swarmflow-edit-other-${randomUUID().slice(0, 8)}`);
  const store = new PermissionRuleStore({
    projectStoreDir: join(root, ".swarmflow"),
    workspaceRoot: root,
  });
  const advisor = new PermissionAdvisor({
    ruleStore: store,
    sessionMode: mode,
    projectRoot: root,
    shellKind: "bash",
  });
  return {
    root,
    outside: join(outsideDir, "outside.txt"),
    secondOutside: join(secondOutsideDir, "second.txt"),
    store,
    advisor,
  };
}

function cleanup(fixture: Fixture): void {
  rmSync(fixture.root, { recursive: true, force: true });
}

async function decide(
  advisor: PermissionAdvisor,
  patchPaths: string[],
  toolName = "edit",
): Promise<GateDecision> {
  return advisor.evaluate({
    agentName: "test",
    toolName,
    toolArgs: {},
    toolCallId: `tc-${randomUUID().slice(0, 8)}`,
    summary: "",
    patchPaths,
  });
}

describe("edit permission policy", () => {
  it("allows workspace edits without an ask", async () => {
    const fixture = makeFixture();
    try {
      const decision = await decide(fixture.advisor, [join(fixture.root, "src", "a.ts")]);
      expect(decision.kind).toBe("allow");
    } finally {
      cleanup(fixture);
    }
  });

  it("asks for external patch paths and lists the files", async () => {
    const fixture = makeFixture();
    try {
      const decision = await decide(fixture.advisor, [
        join(fixture.root, "src", "a.ts"),
        fixture.outside,
      ]);
      expect(decision.kind).toBe("ask");
      if (decision.kind !== "ask") return;
      expect(decision.question).toContain("outside");
      expect(decision.question).toContain("outside.txt");
      expect(decision.offers.every((offer) => offer.type === "external_path")).toBe(true);
    } finally {
      cleanup(fixture);
    }
  });

  it("allows external paths covered by an existing rule", async () => {
    const fixture = makeFixture();
    try {
      fixture.store.addRule({
        type: "external_path",
        action: "allow",
        accessKind: "write_reversible",
        pathPrefix: posix(dirname(fixture.outside)) + "/",
        scope: "session",
      });
      const decision = await decide(fixture.advisor, [fixture.outside]);
      expect(decision.kind).toBe("allow");
    } finally {
      cleanup(fixture);
    }
  });

  it("asks in read_only mode even for workspace edits", async () => {
    const fixture = makeFixture("read_only");
    try {
      const decision = await decide(fixture.advisor, [join(fixture.root, "a.ts")]);
      expect(decision.kind).toBe("ask");
    } finally {
      cleanup(fixture);
    }
  });

  it("skips the external gate in yolo mode", async () => {
    const fixture = makeFixture("yolo");
    try {
      const decision = await decide(fixture.advisor, [fixture.outside]);
      expect(decision.kind).toBe("allow");
    } finally {
      cleanup(fixture);
    }
  });

  it("lists multiple external files in the question", async () => {
    const fixture = makeFixture();
    try {
      const decision = await decide(fixture.advisor, [
        fixture.outside,
        fixture.secondOutside,
      ]);
      expect(decision.kind).toBe("ask");
      if (decision.kind !== "ask") return;
      expect(decision.question).toContain("outside.txt");
      expect(decision.question).toContain("second.txt");
    } finally {
      cleanup(fixture);
    }
  });
});

function fakeHost(root: string, options: {
  insideArtifacts?: (path: string) => boolean;
  onEvaluate?: (ctx: ToolPreflightContext) => void;
} = {}) {
  let evaluateCount = 0;
  return {
    _projectRoot: root,
    _isInsideArtifactsDir: options.insideArtifacts ?? (() => false),
    toolGate: {
      evaluate: async (ctx: ToolPreflightContext) => {
        evaluateCount += 1;
        options.onEvaluate?.(ctx);
        return { kind: "allow" };
      },
    },
    hookRuntime: { hooks: [], evaluate: async () => ({ decision: "allow" }) },
    getEvaluateCount: () => evaluateCount,
  } as never as Parameters<typeof beforeToolExecute>[0] & { getEvaluateCount: () => number };
}

function baseCtx(patchPayload: string): ToolPreflightContext {
  return {
    agentName: "Primary",
    toolName: "edit",
    toolArgs: {},
    toolCallId: "call-edit",
    summary: "edit",
    toolPayload: patchPayload,
  };
}

describe("edit preflight", () => {
  it("parses the patch and hands resolved paths to the gate", async () => {
    const root = mkdtempSync(join(tmpdir(), "swarmflow-edit-preflight-"));
    try {
      let seen: ToolPreflightContext | null = null;
      const host = fakeHost(root, { onEvaluate: (ctx) => { seen = ctx; } });
      const decision = await beforeToolExecute(host, baseCtx(
        "*** Begin Patch\n*** Add File: src/a.ts\n+hello\n*** End Patch",
      ));
      expect(decision).toBeUndefined();
      expect(seen?.patchPaths).toEqual([resolve(root, "src", "a.ts")]);
      expect(host.getEvaluateCount()).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bypasses the gate only when every patch path is inside artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "swarmflow-edit-artifacts-"));
    try {
      const host = fakeHost(root, { insideArtifacts: () => true });
      const decision = await beforeToolExecute(host, baseCtx(
        "*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch",
      ));
      expect(decision).toBeUndefined();
      expect(host.getEvaluateCount()).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not bypass the gate when only some patch paths are in artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "swarmflow-edit-artifacts-mixed-"));
    try {
      const host = fakeHost(root, {
        insideArtifacts: (candidate) => candidate.split(/[\\/]/).includes("artifacts"),
      });
      const decision = await beforeToolExecute(host, baseCtx(
        [
          "*** Begin Patch",
          "*** Add File: artifacts/a.txt",
          "+hello",
          "*** Add File: src/b.txt",
          "+world",
          "*** End Patch",
        ].join("\n"),
      ));
      expect(decision).toBeUndefined();
      expect(host.getEvaluateCount()).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("denies a malformed patch before asking", async () => {
    const root = mkdtempSync(join(tmpdir(), "swarmflow-edit-invalid-"));
    try {
      const host = fakeHost(root);
      const decision = await beforeToolExecute(host, baseCtx("not a patch"));
      expect(decision).toMatchObject({ kind: "deny" });
      expect((decision as { message: string }).message).toContain("Invalid patch");
      expect(host.getEvaluateCount()).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("denies a missing payload", async () => {
    const root = mkdtempSync(join(tmpdir(), "swarmflow-edit-missing-"));
    try {
      const host = fakeHost(root);
      const decision = await beforeToolExecute(host, {
        ...baseCtx(""),
        toolPayload: undefined,
      });
      expect(decision).toMatchObject({ kind: "deny" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
