import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SessionStore } from "../../src/config/session-store.js";

/**
 * 会话目录分配的行为契约：
 * - 没有预测也必须能建会话（正常首轮路径）；
 * - 预测只算路径、不建目录，createSession() 兑现同一路径；
 * - 同一 store 连续两次 createSession() 是两个不同会话。
 */
function makeStore(): { store: SessionStore; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "swarmflow-store-home-"));
  const project = mkdtempSync(join(tmpdir(), "swarmflow-store-project-"));
  const store = new SessionStore({ projectPath: project, baseDir: home });
  return {
    store,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    },
  };
}

describe("session directory allocation", () => {
  it("creates a session without a prior prediction", () => {
    const { store, cleanup } = makeStore();
    try {
      expect(store.sessionDir).toBeUndefined();
      const dir = store.createSession();
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(join(dir, "artifacts"))).toBe(true);
      expect(store.sessionDir).toBe(dir);
    } finally {
      cleanup();
    }
  });

  it("predicts without creating and createSession reuses the predicted path", () => {
    const { store, cleanup } = makeStore();
    try {
      const predicted = store.predictNextSessionDir();
      expect(store.predictNextSessionDir()).toBe(predicted);
      expect(existsSync(predicted)).toBe(false);

      expect(store.createSession()).toBe(predicted);
      expect(existsSync(predicted)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("allocates a fresh directory for a second createSession", () => {
    const { store, cleanup } = makeStore();
    try {
      const first = store.createSession();
      const second = store.createSession();
      expect(second).not.toBe(first);
      expect(existsSync(second)).toBe(true);
    } finally {
      cleanup();
    }
  });
});
