import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, mock, spyOn } from "bun:test";

import { SessionStore } from "../src/persistence.js";
import { Session } from "../src/session.js";
import {
  createAssistantText,
  createInputReceived,
  createSummary,
  createToolResult,
  createUserMessage,
} from "../src/log-entry.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeSession(projectRoot: string): Session {
  const primaryAgent = {
    name: "Primary",
    systemPrompt: "You are a test agent.",
    tools: [],
    modelConfig: {
      name: "test-model",
      provider: "test",
      model: "test-model",
      apiKey: "fake",
      temperature: 0,
      maxTokens: 1024,
      contextLength: 8192,
      supportsMultimodal: false,
      supportsThinking: false,
      thinkingBudget: 0,
      supportsWebSearch: false,
      extra: {},
    },
    _provider: {
      budgetCalcMode: "full_context",
      requiresAlternatingRoles: false,
    },
    replaceModelConfig(newConfig: unknown) {
      this.modelConfig = newConfig as typeof this.modelConfig;
    },
  } as any;

  const store = new SessionStore({ baseDir: projectRoot, projectPath: projectRoot });
  store.createSession();
  const config = {
    mcpServerConfigs: [],
    getModel: () => primaryAgent.modelConfig,
  } as any;

  return new Session({
    primaryAgent,
    config,
    store,
  });
}

describe("manual summarize / compact commands", () => {
  it("picker lists turns only; summaries fold into their assigned turn", () => {
    const projectRoot = makeTempDir("swarmflow-summarize-targets-");
    try {
      const session = makeSession(projectRoot) as any;
      session._turnCount = 2;
      session._log.push(
        createInputReceived("in-001", 1, "in-001", "user", "First request", "First request", "c1"),
        createUserMessage("user-001", 1, "First request", "First request", "c1"),
        createInputReceived("in-002", 2, "in-002", "user", "Second request", "Second request", "c2-user"),
        createUserMessage("user-002", 2, "Second request", "Second request", "c2-user"),
        createAssistantText("asst-001", 2, 0, "Checking files", "Checking files", "c2-tool"),
        createToolResult(
          "tr-001",
          2,
          0,
          { toolCallId: "call-1", toolName: "read_file", content: "file content", toolSummary: "read" },
          { isError: false, contextId: "c2-tool" },
        ),
        createSummary(
          "sum-manual",
          3,
          "Manual summary",
          "Manual summary",
          "sum-manual-ctx",
          ["c1"],
          1,
          { summaryOrigin: "manual", coveredTurnStart: 1, coveredTurnEnd: 1 },
        ),
        createSummary(
          "sum-agent",
          2,
          "Agent summary",
          "Agent summary",
          "sum-agent-ctx",
          ["c2-tool"],
          1,
          { summaryOrigin: "agent", coveredTurnStart: 2, coveredTurnEnd: 2 },
        ),
      );

      // The manual summary swallowed turn 1's user message; with no earlier
      // surviving anchor it falls back to its covered turn, so turn 1 still
      // stands in for it. The agent summary belongs to turn 2 (its anchor).
      const targets = session.getSummarizeTargets();
      expect(targets).toHaveLength(2);
      expect(targets[0]).toMatchObject({ kind: "turn", turnIndex: 1 });
      expect(targets[1]).toMatchObject({ kind: "turn", turnIndex: 2 });
      expect(session.getContextIdsForTurnRange(1, 1)).toEqual(["sum-manual-ctx"]);
      expect(session.getContextIdsForTurnRange(2, 2)).toEqual(["c2-user", "sum-agent-ctx"]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("runManualSummarize injects an exact selected range request", async () => {
    const projectRoot = makeTempDir("swarmflow-manual-summarize-");
    try {
      const session = makeSession(projectRoot) as any;
      session._ensureMcp = mock(async () => {});
      session._runTurnActivationLoop = mock(async () => "ok");
      session._log.push(createUserMessage("user-seed", 0, "seed", "seed", "seed1"));

      const out = await session.runManualSummarize({
        targetContextIds: ["seed1"],
        focusPrompt: "keep deployment notes",
      });

      expect(out).toBe("ok");
      const injected = session._log.findLast((e: any) => e.type === "user_message");
      expect(injected.display).toBe("/summarize keep deployment notes");
      expect(String(injected.content)).toContain("<system-message>");
      expect(String(injected.content)).toContain("</system-message>");
      expect(String(injected.content)).toContain("from=\"seed1\" and to=\"seed1\"");
      expect(String(injected.content)).toContain("Call `summarize_context` exactly once");
      expect(String(injected.content)).toContain("User's additional focus: keep deployment notes");
      expect(String(injected.content).startsWith("/summarize keep deployment notes\n")).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("runManualCompact creates a new turn and passes prompt override into compact", async () => {
    const projectRoot = makeTempDir("swarmflow-manual-compact-");
    try {
      const session = makeSession(projectRoot) as any;
      session._hintState = "level2_sent";
      session._doAutoCompact = mock(async () => {});

      await session.runManualCompact("preserve open debugging threads");

      expect(session._hintState).toBe("none");
      expect(session._doAutoCompact).toHaveBeenCalledTimes(1);
      const prompt = session._doAutoCompact.mock.calls[0][2] as string;
      expect(prompt).toContain("Additional user instruction for this manual compact request:");
      expect(prompt).toContain("preserve open debugging threads");
      const status = session._log.findLast((e: any) => e.type === "status");
      expect(status.display).toBe("[Manual compact requested]");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("blocks manual commands while a background shell is still running", async () => {
    const projectRoot = makeTempDir("swarmflow-manual-blocked-");
    try {
      const session = makeSession(projectRoot) as any;
      session._shellManager._activeShells.set("dev", {
        id: "dev",
        process: null,
        command: "pnpm dev",
        cwd: projectRoot,
        logPath: join(projectRoot, "dev.log"),
        startTime: 0,
        status: "running",
        exitCode: null,
        signal: null,
        readOffset: 0,
        recentOutput: [],
        explicitKill: false,
      });

      await expect(session.runManualSummarize()).rejects.toThrow("background shells are still running");
      await expect(session.runManualCompact()).rejects.toThrow("background shells are still running");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
