/**
 * Pending tool_call scan — regression lock for the shared
 * _firstPendingToolCall helper against the original two-pass reference
 * (collect all result ids, then first unresolved call), including the
 * adversarial shapes: results logged before duplicate-id calls, discarded
 * entries, and compact-marker windows. (A single-pass merge was tried and
 * reverted after benchmarking slower — see scripts/bench-log-hotpaths.ts.)
 */

import { describe, expect, it } from "bun:test";

import type { LogEntry } from "../src/log-entry.js";
import { makeScriptedSession } from "./helpers/session-harness.js";

let seed = 0x517cc1b;
function rng(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
}

function mk(type: LogEntry["type"], id: string, meta: Record<string, unknown> = {}): LogEntry {
  return {
    id,
    type,
    turnIndex: 1,
    timestamp: 1000,
    discarded: false,
    archived: false,
    tuiVisible: true,
    apiRole: null,
    content: { name: "probe", arguments: { n: id } },
    display: id,
    displayKind: null,
    meta,
  } as unknown as LogEntry;
}

/** Reference: the original two-pass implementation, verbatim semantics. */
function refEarliestPendingIdx(log: readonly LogEntry[], windowStart: number): number {
  const resultIds = new Set<string>();
  for (let index = windowStart; index < log.length; index += 1) {
    const entry = log[index]!;
    if (entry.type !== "tool_result") continue;
    if (entry.discarded) continue;
    const id = String((entry.meta as Record<string, unknown>)["toolCallId"] ?? "");
    if (id) resultIds.add(id);
  }
  for (let index = windowStart; index < log.length; index += 1) {
    const entry = log[index]!;
    if (entry.type !== "tool_call") continue;
    if (entry.discarded) continue;
    const toolCallId = String((entry.meta as Record<string, unknown>)["toolCallId"] ?? "");
    if (!toolCallId || resultIds.has(toolCallId)) continue;
    return index;
  }
  return log.length;
}

describe("pending tool_call scan equivalence", () => {
  it("matches the two-pass reference on randomized windows", () => {
    const h = makeScriptedSession({ rounds: [] });
    try {
      const log = h.session.log as LogEntry[];
      const baseLen = log.length;

      for (let trial = 0; trial < 60; trial++) {
        log.length = baseLen;
        h.internals._logStore.invalidateIndexes();
        const size = 20 + Math.floor(rng() * 120);
        let callCounter = 0;
        for (let i = 0; i < size; i++) {
          const r = rng();
          if (r < 0.08) {
            log.push(mk("compact_marker", `t${trial}-cm-${i}`));
          } else if (r < 0.35) {
            // Sometimes duplicate an existing call id.
            const dup = r < 0.12 && callCounter > 0;
            const callId = dup
              ? `t${trial}-call-${Math.floor(rng() * callCounter)}`
              : `t${trial}-call-${callCounter++}`;
            const e = mk("tool_call", `t${trial}-tc-${i}`, { toolCallId: callId, toolName: "probe", agentName: "tester" });
            e.discarded = rng() < 0.15;
            log.push(e);
          } else if (r < 0.6) {
            // Result for a random call id — possibly one that doesn't exist
            // yet (orphan result logged before a later duplicate-id call).
            const callId = `t${trial}-call-${Math.floor(rng() * Math.max(1, callCounter + 2))}`;
            const e = mk("tool_result", `t${trial}-tr-${i}`, { toolCallId: callId });
            e.discarded = rng() < 0.15;
            log.push(e);
          } else {
            log.push(mk("status", `t${trial}-st-${i}`));
          }
        }

        const windowStart = h.internals._activeWindowStartIdx() as number;
        const expected = refEarliestPendingIdx(log, windowStart);
        expect(h.internals._findEarliestPendingToolCallLogIndex()).toBe(expected);

        const next = h.internals._findNextPendingToolCall();
        if (expected === log.length) {
          expect(next).toBeNull();
        } else {
          const entry = log[expected]!;
          expect(next).toMatchObject({
            toolCallId: String((entry.meta as Record<string, unknown>)["toolCallId"]),
            turnIndex: entry.turnIndex,
          });
        }
      }
    } finally {
      h.dispose();
    }
  });

  it("a result logged before a duplicate-id call still resolves it", () => {
    const h = makeScriptedSession({ rounds: [] });
    try {
      const log = h.session.log as LogEntry[];
      log.push(mk("tool_call", "tc-1", { toolCallId: "dup", toolName: "probe" }));
      log.push(mk("tool_result", "tr-1", { toolCallId: "dup" }));
      log.push(mk("tool_call", "tc-2", { toolCallId: "dup", toolName: "probe" }));
      h.internals._logStore.invalidateIndexes();

      // Two-pass semantics: "dup" has a result somewhere → no pending calls.
      expect(h.internals._findNextPendingToolCall()).toBeNull();
      expect(h.internals._findEarliestPendingToolCallLogIndex()).toBe(log.length);
    } finally {
      h.dispose();
    }
  });

  it("a discarded result does not resolve its call", () => {
    const h = makeScriptedSession({ rounds: [] });
    try {
      const log = h.session.log as LogEntry[];
      log.push(mk("tool_call", "tc-1", { toolCallId: "x", toolName: "probe" }));
      const dead = mk("tool_result", "tr-1", { toolCallId: "x" });
      dead.discarded = true;
      log.push(dead);
      h.internals._logStore.invalidateIndexes();

      expect(h.internals._findNextPendingToolCall()).toMatchObject({ toolCallId: "x" });
    } finally {
      h.dispose();
    }
  });
});
