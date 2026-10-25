/**
 * FULL_LOG_CONSUMERS 契约：推导/修复类 consumer 必须跳过 stripped archived
 * 冷区，或显式声明自己需要的标量键。用 stripped archived fixture 驱动。
 */
import { describe, expect, it } from "vitest";

import { validateAndRepairLog } from "../../src/config/log-repair.js";
import { archiveWindow } from "../../src/config/archive.js";
import { FULL_LOG_CONSUMERS } from "../../src/config/full-log-consumers.js";
import { SessionLog } from "../../src/session/log.js";
import { aggregateTokenUsage } from "../../src/session/usage-accounting.js";
import { indexChildOutcomesFromLog } from "../../src/session/task-list.js";
import {
  createAgentResult,
  createAssistantText,
  createCompactContext,
  createCompactMarker,
  createInputReceived,
  createSystemPrompt,
  createTokenUpdate,
  createToolCall,
  createUserMessage,
} from "../../src/context/entry/factories.js";
import type { LogEntry } from "../../src/context/entry/types.js";
import { makeScriptedSession } from "../helpers/session-harness.js";

const CONSUMERS = FULL_LOG_CONSUMERS;

function strippedArchivedFixture(): LogEntry[] {
  const archivedCall = createToolCall(
    "tc-1",
    1,
    0,
    "probe",
    { id: "c-1", name: "probe", arguments: {} },
    { toolCallId: "c-1", toolName: "probe", agentName: "Primary", contextId: "ctx-a" },
  );
  archivedCall.content = null;
  archivedCall.archived = true;
  archivedCall.meta = { contextId: "ctx-a" };

  const archivedToken = createTokenUpdate("tok-1", 1, 7000, 0, 0, 7500);
  archivedToken.archived = true;
  archivedToken.meta = {};

  const archivedAgent = createAgentResult(
    "ar-1",
    1,
    "agent-1",
    1,
    "worker",
    "completed",
    "natural",
    100,
    "done",
    "ctx-a",
  );
  archivedAgent.archived = true;
  archivedAgent.meta = {};

  const archivedTurn = createInputReceived("in-1", 1, "i-1", "user", "", null, "ctx-a");
  archivedTurn.archived = true;
  archivedTurn.display = "";
  archivedTurn.meta = { contextId: "ctx-a" };

  return [
    createSystemPrompt("sys-1", "system"),
    archivedToken,
    archivedTurn,
    archivedCall,
    archivedAgent,
    createCompactMarker("cm-1", 2, 0, 7000, 500),
    createCompactContext("cc-1", 2, "briefing", "ctx-b", 0),
    createUserMessage("u-2", 2, "next", "next", "ctx-b"),
    createAssistantText("a-2", 2, 0, "reply", "reply", "ctx-b"),
  ];
}

describe("FULL_LOG_CONSUMERS", () => {
  it("declares skip-or-keys for every registered consumer", () => {
    for (const consumer of CONSUMERS) {
      expect(
        consumer.skipsArchived === true || ("requiredKeys" in consumer && consumer.requiredKeys.length > 0),
        consumer.name,
      ).toBe(true);
    }
  });

  it("summary uses archived turn preview when the active window has no user message", () => {
    const h = makeScriptedSession();
    try {
      const input = createInputReceived(
        "in-archived",
        1,
        "input-1",
        "user",
        "Original archived request",
        "Original archived request",
        "ctx-old",
      );
      const dir = h.internals._store.sessionDir as string;
      archiveWindow(dir, "summary-checkpoint", [input], 0, 0);
      input.content = null;
      input.display = "";
      input.archived = true;
      h.internals._appendEntry(input, false);

      expect(h.session._generateSummary()).toBe("Original archived request");
    } finally {
      h.dispose();
    }
  });

  it("repair does not synthesize results for stripped archived tool calls", () => {
    const { entries, repaired, warnings } = validateAndRepairLog(strippedArchivedFixture());
    expect(repaired).toBe(false);
    expect(warnings).toEqual([]);
    expect(entries.some((entry) => entry.id.startsWith("tr-recovered-"))).toBe(false);
  });

  it("usage aggregation ignores stripped archived token updates", () => {
    const stats = aggregateTokenUsage(strippedArchivedFixture());
    expect(stats.cumulativeInput).toBe(0);
  });

  it("child outcome indexing ignores archived agent_result", () => {
    const indexed = indexChildOutcomesFromLog({ _log: strippedArchivedFixture() } as never);
    expect(indexed.size).toBe(0);
  });

  it("listTurns falls back to the archive turn index", () => {
    const entries = strippedArchivedFixture();
    const log = new SessionLog();
    log.replace(entries);
    const turns = log.listTurns(new Map([[
      "in-1",
      { id: "in-1", type: "input_received", turnIndex: 1, turnKind: "user", preview: "archived preview" },
    ]]));
    expect(turns.some((turn) => turn.preview === "archived preview")).toBe(true);
  });
});
