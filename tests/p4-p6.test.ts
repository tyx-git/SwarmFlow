import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { SessionStore } from "../src/persistence.js";
import { Session } from "../src/session.js";
import { executeTool } from "../src/tools/basic.js";
import { ToolResult } from "../src/providers/base.js";
import { createAssistantText, createReasoning, createUserMessage } from "../src/log-entry.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeSession(projectRoot: string): Session {
  const primaryAgent = {
    name: "Primary",
    systemPrompt: "You are a test agent.",
    tools: [],
    modelConfig: {
      model: "test-model",
      contextLength: 8192,
      supportsMultimodal: false,
    },
  } as any;

  const store = new SessionStore({ baseDir: projectRoot, projectPath: projectRoot });
  store.createSession();
  const config = {
    mcpServerConfigs: [],
    getModel: () => ({ model: "test" }),
  } as any;

  return new Session({
    primaryAgent,
    config,
    store,
  });
}

describe("P4 shell governance", () => {
  it("filters inherited environment variables for bash tool", async () => {
    const prev = process.env["AGENTFLOW_TEST_SECRET"];
    process.env["AGENTFLOW_TEST_SECRET"] = "super-secret-value";
    try {
      const result = await executeTool(
        "bash",
        { command: "printf %s \"$AGENTFLOW_TEST_SECRET\"", timeout: 30 },
        { projectRoot: process.cwd() },
      );
      expect(result.content).not.toContain("super-secret-value");
      expect(result.content).toContain("EXIT CODE: 0");
    } finally {
      if (prev === undefined) {
        delete process.env["AGENTFLOW_TEST_SECRET"];
      } else {
        process.env["AGENTFLOW_TEST_SECRET"] = prev;
      }
    }
  });

  it("allows external bash cwd at executor layer", async () => {
    const projectRoot = makeTempDir("swarmflow-p4-bash-proj-");
    const externalRoot = makeTempDir("swarmflow-p4-bash-ext-");
    try {
      const result = await executeTool(
        "bash",
        { command: "pwd", cwd: externalRoot, timeout: 30 },
        { projectRoot },
      );
      expect(result.content).toContain("STDOUT:");
      expect(result.content).toContain(externalRoot);
      expect(result.content).toContain("EXIT CODE: 0");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it("asks before running bash in an external cwd", async () => {
    const projectRoot = makeTempDir("swarmflow-p4-preflight-proj-");
    const externalRoot = makeTempDir("swarmflow-p4-preflight-ext-");
    try {
      const session = makeSession(projectRoot);

      const preflight = await (session as any)._beforeToolExecute({
        agentName: "Primary",
        toolName: "bash",
        toolArgs: { command: "pwd", cwd: externalRoot },
        toolCallId: "tc1",
        summary: "",
      });
      expect(preflight?.kind).toBe("ask");
      expect(preflight?.ask.summary).toContain("bash in external directory");
      expect(preflight?.ask.options).toEqual(["Allow once", "Deny"]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });
});

describe("P6 summarize_context behavior", () => {
  it("summarize_context succeeds and hint state is preserved until next API call", () => {
    const projectRoot = makeTempDir("swarmflow-p6-distill-hint-");
    try {
      const session = makeSession(projectRoot);
      (session as any)._hintState = "level1_sent";
      // Add a LogEntry so the projection has the right conversation
      (session as any)._log.push(
        createAssistantText("asst-001", 1, 0, "hello", "hello", "seed1"),
      );

      const success = (session as any)._execSummarizeContextTool({
        operations: [{ from: "seed1", to: "seed1", content: "compressed" }],
      }) as ToolResult;
      expect(success.content).toContain("1 succeeded");
      // Hint state is NOT reset by summarize_context itself —
      // it's updated by _updateHintStateAfterApiCall based on actual inputTokens
      expect((session as any)._hintState).toBe("level1_sent");

      const fail = (session as any)._execSummarizeContextTool({
        operations: [{ from: "missing", to: "missing", content: "will fail" }],
      }) as ToolResult;
      expect(fail.content).toContain("0 succeeded");
      expect((session as any)._hintState).toBe("level1_sent");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

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
