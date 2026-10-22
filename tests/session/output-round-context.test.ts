import { rmSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  createAssistantText,
  createReasoning,
  createUserMessage,
} from "../../src/context/entry/factories.js";
import { makeSession, makeTempDir } from "./minimal-session.js";

describe("output round context", () => {
  it("text-only final rounds keep their own context_id", () => {
    const projectRoot = makeTempDir("swarmflow-p6-round-retag-");
    try {
      const session = makeSession(projectRoot) as any;
      session._turnCount = 1;
      session._log.push(
        createUserMessage("user-001", 1, "hello", "hello", "u1"),
        createReasoning("rsn-001", 1, 0, "thinking", "thinking", undefined, "tmp-round"),
        createAssistantText("asst-001", 1, 0, "answer", "answer", "tmp-round"),
      );

      const resolved = session._resolveOutputRoundContextId(1, 0);
      expect(resolved).toBe("tmp-round");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
