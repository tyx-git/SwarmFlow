import { describe, expect, it } from "bun:test";

import type { ChildSessionSnapshot } from "../../src/session-tree-types.js";
import type { Session as TuiSession } from "../../src/ui/contracts.js";

import {
  getActiveTranscriptSource,
  shouldSyncTranscript,
  type TranscriptSyncState,
} from "./use-transcript-model.js";

function createSessionMock(overrides: Partial<TuiSession> = {}): TuiSession {
  return {
    turn: async () => "",
    close: async () => {},
    primaryAgent: { name: "tester" },
    _turnCount: 0,
    _compactCount: 0,
    lastInputTokens: 0,
    lastTotalTokens: 0,
    setStore: () => {},
    getPendingAsk: () => null,
    _resetTransientState: () => {},
    _initConversation: () => {},
    ...overrides,
  };
}

function createChildSnapshot(
  overrides: Partial<ChildSessionSnapshot> = {},
): ChildSessionSnapshot {
  return {
    id: "child-1",
    numericId: 1,
    logRevision: 7,
    template: "default",
    mode: "persistent",
    lifecycle: "idle",
    phase: "idle",
    outcome: "none",
    running: false,
    lifetimeToolCallCount: 0,
    lastTotalTokens: 0,
    lastToolCallSummary: "",
    recentEvents: [],
    pendingInboxCount: 0,
    lastActivityAt: 0,
    inputTokens: 0,
    contextBudget: 200000,
    modelConfigName: "test-model",
    modelProvider: "test",
    activeLogEntryId: null,
    turnElapsed: 0,
    cacheReadTokens: 0,
    ...overrides,
  };
}

describe("useTranscriptModel helpers", () => {
  it("uses root revision and root log when no child is selected", () => {
    const rootLog = [{ id: "x" }] as any[];
    const session = createSessionMock({
      log: rootLog,
      getLogRevision: () => 3,
    });

    const source = getActiveTranscriptSource(session, null, []);
    expect(source.sourceKey).toBe("root");
    expect(source.logRevision).toBe(3);
    expect(source.log).toBe(rootLog);
  });

  it("uses child revision and child log when a child session is selected", () => {
    const childLog = [{ id: "child-entry" }] as any[];
    const session = createSessionMock({
      getChildSessionLog: (childId: string) => childId === "child-1" ? childLog : null,
    });
    const childSessions = [createChildSnapshot()];

    const source = getActiveTranscriptSource(session, "child-1", childSessions);
    expect(source.sourceKey).toBe("child:child-1");
    expect(source.logRevision).toBe(7);
    expect(source.log).toBe(childLog);
  });

  it("skips sync only when session, source key, and revision are unchanged", () => {
    const session = createSessionMock();
    const state: TranscriptSyncState = {
      session,
      sourceKey: "root",
      logRevision: 2,
    };

    expect(
      shouldSyncTranscript(state, session, {
        sourceKey: "root",
        logRevision: 2,
        log: [],
      }),
    ).toBe(false);

    expect(
      shouldSyncTranscript(state, session, {
        sourceKey: "root",
        logRevision: 3,
        log: [],
      }),
    ).toBe(true);
  });
});
