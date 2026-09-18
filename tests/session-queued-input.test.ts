import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SessionStore } from "../src/config/persistence.js";
import { projectQueuedInputs, projectToApiMessages, projectToTuiEntries } from "../src/context/log-projection.js";
import { Session } from "../src/session.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeSession(projectRoot: string): Session {
  const primaryAgent = {
    name: "Primary",
    systemPrompt: "You are a test agent.",
    tools: [],
    _provider: {
      budgetCalcMode: "last_call",
      requiresAlternatingRoles: false,
    },
    modelConfig: {
      model: "test-model",
      contextLength: 8192,
      maxTokens: 1024,
      supportsMultimodal: false,
    },
  } as any;

  const store = new SessionStore({ baseDir: projectRoot, projectPath: projectRoot });
  store.createSession();

  return new Session({
    primaryAgent,
    config: {
      mcpServerConfigs: [],
      getModel: () => ({ model: "test" }),
    } as any,
    store,
  });
}

function textResult(text: string, callCount: number): any {
  return {
    text,
    toolHistory: [],
    totalUsage: { inputTokens: 10 * callCount, outputTokens: 1 },
    intermediateText: [],
    lastInputTokens: 10 * callCount,
    reasoningContent: "",
    reasoningState: null,
    lastTotalTokens: 10 * callCount + 1,
    textHandledInLog: false,
    reasoningHandledInLog: false,
    endedWithoutToolCalls: true,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("queued user input", () => {
  it("continues the same work lifecycle after text-only output", async () => {
    const projectRoot = makeTempDir("swarmflow-queued-input-");
    try {
      const session = makeSession(projectRoot);
      let callCount = 0;
      let secondActivationSawQueuedMessage = false;
      let queuedDuringFirstResponse: string[] = [];
      let transcriptUsersDuringFirstResponse: string[] = [];
      let secondDeliveryResult: unknown;
      let thirdDeliveryResult: unknown;

      (session.primaryAgent as any).asyncRunWithMessages = async (
        opts: { getMessages: () => Array<Record<string, unknown>> },
      ) => {
        callCount += 1;
        if (callCount === 1) {
          secondDeliveryResult = session.deliverMessage("user", "second while first is still running");
          thirdDeliveryResult = session.deliverMessage("user", "third while second is queued");
          queuedDuringFirstResponse = projectQueuedInputs([...session.log]).map((entry) => entry.text);
          transcriptUsersDuringFirstResponse = projectToTuiEntries([...session.log])
            .filter((entry) => entry.kind === "user")
            .map((entry) => entry.text);
          return textResult("first response", callCount);
        }

        const messages = opts.getMessages();
        secondActivationSawQueuedMessage = messages.some((message) =>
          message.role === "user" &&
          String(message.content).includes("second while first is still running")
        );
        return textResult("second response", callCount);
      };

      await session.turn("first");

      expect(callCount).toBe(2);
      expect(secondActivationSawQueuedMessage).toBe(true);
      expect(secondDeliveryResult).toEqual({ accepted: true });
      expect(thirdDeliveryResult).toEqual({ accepted: false, reason: "queued_user_input_pending" });
      expect(queuedDuringFirstResponse).toEqual(["second while first is still running"]);
      expect(transcriptUsersDuringFirstResponse).toEqual(["first"]);
      expect(session.log.filter((entry) => entry.type === "input_received")).toHaveLength(2);
      expect(session.log.filter((entry) => entry.type === "work_end")).toHaveLength(1);
      expect(session.log.filter((entry) => entry.type === "assistant_text").map((entry) => entry.meta.providerRoundId))
        .toEqual(["input-1:round-0", "input-2:round-0"]);

      const tui = projectToTuiEntries([...session.log]);
      expect(projectQueuedInputs([...session.log])).toEqual([]);
      expect(tui.filter((entry) => entry.kind === "user").map((entry) => entry.text))
        .toEqual(["first", "second while first is still running"]);

      const api = projectToApiMessages([...session.log]);
      expect(api.map((message) => message.role)).toEqual([
        "system",
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("restores the queued user input only while it is still in the inbox", async () => {
    const projectRoot = makeTempDir("swarmflow-queued-input-restore-");
    try {
      const session = makeSession(projectRoot);
      let callCount = 0;
      let restored: string | null = null;
      let queuedAfterRestore: string[] = [];

      (session.primaryAgent as any).asyncRunWithMessages = async () => {
        callCount += 1;
        if (callCount === 1) {
          expect(session.deliverMessage("user", "edit me before delivery")).toEqual({ accepted: true });
          restored = session.restoreQueuedUserInput();
          queuedAfterRestore = projectQueuedInputs([...session.log]).map((entry) => entry.text);
        }
        return textResult("first response", callCount);
      };

      await session.turn("first");

      expect(callCount).toBe(1);
      expect(restored).toBe("edit me before delivery");
      expect(queuedAfterRestore).toEqual([]);
      expect(projectQueuedInputs([...session.log])).toEqual([]);
      expect(session.restoreQueuedUserInput()).toBeNull();
      expect(session.log.filter((entry) => entry.type === "input_received" && !entry.discarded))
        .toHaveLength(1);
      expect(projectToTuiEntries([...session.log]).filter((entry) => entry.kind === "user").map((entry) => entry.text))
        .toEqual(["first"]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("accepts a user message delivered while idle and auto-resumes it", async () => {
    const projectRoot = makeTempDir("swarmflow-queued-input-idle-");
    try {
      const session = makeSession(projectRoot);
      let callCount = 0;
      let sawIdleDeliveredMessage = false;

      (session.primaryAgent as any).asyncRunWithMessages = async (
        opts: { getMessages: () => Array<Record<string, unknown>> },
      ) => {
        callCount += 1;
        const messages = opts.getMessages();
        sawIdleDeliveredMessage = messages.some((message) =>
          message.role === "user" &&
          String(message.content).includes("idle delivery")
        );
        return textResult("idle response", callCount);
      };

      expect(session.deliverMessage("user", "idle delivery")).toEqual({ accepted: true });
      await waitFor(() => callCount === 1);

      expect(sawIdleDeliveredMessage).toBe(true);
      expect(projectQueuedInputs([...session.log])).toEqual([]);
      expect(projectToTuiEntries([...session.log]).filter((entry) => entry.kind === "user").map((entry) => entry.text))
        .toEqual(["idle delivery"]);
      expect(projectToApiMessages([...session.log]).map((message) => message.role))
        .toEqual(["system", "user", "assistant"]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("flushes older ride-along messages before a new explicit turn starts", async () => {
    const projectRoot = makeTempDir("swarmflow-queued-input-ride-along-order-");
    try {
      const session = makeSession(projectRoot);
      let firstCallMessages: Array<Record<string, unknown>> = [];

      (session.primaryAgent as any).asyncRunWithMessages = async (
        opts: { getMessages: () => Array<Record<string, unknown>> },
      ) => {
        firstCallMessages = opts.getMessages();
        return textResult("response", 1);
      };

      expect((session as any)._deliverMessage({
        type: "system_notice",
        sender: "system",
        content: "older ride-along notice",
        timestamp: Date.now(),
        wake: false,
        tuiVisible: false,
      })).toEqual({ accepted: true });

      await session.turn("later explicit input");

      const userContents = firstCallMessages
        .filter((message) => message.role === "user")
        .map((message) => String(message.content));
      expect(userContents).toHaveLength(2);
      expect(userContents[0]).toContain("older ride-along notice");
      expect(userContents[1]).toContain("later explicit input");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
