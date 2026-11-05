import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import type { CommandContext } from "../../src/commands/types.js";
import { getSessionId } from "../../src/commands/workflow/session-files.js";
import { writeApprovedPlan } from "../../src/session/plan-artifact.js";
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

  it("确认门批准时才生成唯一一份 plan.md，路径落在 <session_id>/plan 下", () => {
    const { project, store, cleanup } = makeStore();
    const previousCwd = process.cwd();
    try {
      process.chdir(project);
      const sessionId = getSessionId({ store } as CommandContext);

      const planPath = writeApprovedPlan({
        cwd: project,
        store,
        goal: "ship it",
        planContent: "# 计划\n- [ ] 阶段一",
        progress: "[Current Tasks]\n#1 pending 阶段一",
        approvedAt: "2026-11-05T00:00:00.000Z",
      });

      expect(relative(project, planPath)).toBe(join(".swarmflow", sessionId, "plan", "plan.md"));
      expect(existsSync(planPath)).toBe(true);
      const text = readFileSync(planPath, "utf-8");
      expect(text).toContain("Goal: ship it");
      expect(text).toContain("Approved at: 2026-11-05T00:00:00.000Z");
      expect(text).toContain("- [ ] 阶段一");
      expect(text).toContain("## Progress");
      expect(existsSync(join(project, ".swarmflow", "current"))).toBe(false);
    } finally {
      process.chdir(previousCwd);
      cleanup();
    }
  });

  it("不再产出 process.md 与 finding.md", () => {
    const { project, store, cleanup } = makeStore();
    try {
      const planPath = writeApprovedPlan({
        cwd: project,
        store,
        planContent: "# 计划",
        approvedAt: "2026-11-05T00:00:00.000Z",
      });
      const dir = dirname(planPath);
      expect(existsSync(join(dir, "process.md"))).toBe(false);
      expect(existsSync(join(dir, "finding.md"))).toBe(false);
      // 没有 goal/progress 时不写空小节
      const text = readFileSync(planPath, "utf-8");
      expect(text).toContain("Goal: (not specified)");
      expect(text).not.toContain("## Progress");
    } finally {
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
