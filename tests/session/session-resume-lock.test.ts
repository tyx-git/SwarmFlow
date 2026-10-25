/**
 * 重复 resume 同一会话应直接给出“正在被占用”警告。
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../../src/config/session-store.js";
import { writeLogJsonlSnapshot } from "../../src/config/log-jsonl.js";
import { createLogSessionMeta } from "../../src/config/session-meta.js";
import { applySessionRestore } from "../../src/session/resume.js";
import { createUiText } from "../../src/ui/text.js";
import { makeScriptedSession } from "../helpers/session-harness.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarmflow-resume-lock-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("resume 写锁冲突", () => {
  it("同一会话被另一个 store 持有时返回占用警告", () => {
    const baseDir = makeDir();
    const projectRoot = makeDir();
    const sessionDir = makeDir();
    writeLogJsonlSnapshot(sessionDir, createLogSessionMeta({
      sessionId: "locked-session",
      createdAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-21T00:00:00.000Z",
      projectPath: projectRoot,
      modelConfigName: "test",
      summary: "",
      turnCount: 1,
      compactCount: 0,
      thinkingLevel: "off",
    }), []);

    const holder = new SessionStore({ baseDir, projectPath: projectRoot });
    expect(holder.acquireSessionLock(sessionDir).ok).toBe(true);
    const h = makeScriptedSession();
    try {
      const result = applySessionRestore(h.session, h.internals._store, sessionDir);
      expect(result.ok).toBe(false);
      expect([
        createUiText("zh").get(["Error", "sessionBusy"]),
        createUiText("en").get(["Error", "sessionBusy"]),
      ]).toContain(result.error);
    } finally {
      holder.releaseSessionLock(sessionDir);
      h.dispose();
    }
  });
});
