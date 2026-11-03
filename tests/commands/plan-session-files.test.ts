import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import type { CommandContext } from "../../src/commands/types.js";
import { getSessionId, writeInitialPlanFiles } from "../../src/commands/workflow/session-files.js";
import { SessionStore } from "../../src/config/session-store.js";

/**
 * 计划文件的目录只能有一份：<cwd>/.swarmflow/<session_id>/plan。
 * 会话目录尚未落盘时也必须解析出同一个 id，不能退化成共享的 "current"。
 */
function makeStore(): { project: string; store: SessionStore; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "swarmflow-plan-home-"));
  const project = mkdtempSync(join(tmpdir(), "swarmflow-plan-project-"));
  const store = new SessionStore({ projectPath: project, baseDir: home });
  return {
    project,
    store,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    },
  };
}

describe("plan workflow session directory", () => {
  it("uses the predicted session id instead of a shared current directory", () => {
    const { store, cleanup } = makeStore();
    try {
      expect(store.sessionDir).toBeUndefined();
      const sessionId = getSessionId({ store } as CommandContext);
      expect(sessionId).not.toBe("current");
      expect(sessionId).toBe(basename(store.predictNextSessionDir()));
    } finally {
      cleanup();
    }
  });

  it("writes plan files only under <session_id>/plan", () => {
    const { project, store, cleanup } = makeStore();
    const previousCwd = process.cwd();
    try {
      process.chdir(project);
      const sessionId = getSessionId({ store } as CommandContext);
      const dir = writeInitialPlanFiles({ store } as CommandContext, "ship it");

      expect(relative(project, dir)).toBe(join(".swarmflow", sessionId, "plan"));
      expect(existsSync(join(dir, "plan.md"))).toBe(true);
      expect(existsSync(join(project, ".swarmflow", "current"))).toBe(false);
    } finally {
      process.chdir(previousCwd);
      cleanup();
    }
  });

  it("keeps the predicted id aligned with the session directory created later", () => {
    const { store, cleanup } = makeStore();
    try {
      const sessionId = getSessionId({ store } as CommandContext);
      const created = store.createSession();
      expect(basename(created)).toBe(sessionId);
    } finally {
      cleanup();
    }
  });

  it("refuses to guess a shared directory when storage is unavailable", () => {
    expect(() => getSessionId({} as CommandContext)).toThrow(/session storage/i);
  });
});
