/**
 * SessionLog index layer — indexed lookups must be observably identical to
 * the linear scans they replaced, across appends, replace(), rewind-style
 * truncation, and id reuse after truncation.
 */

import { describe, expect, it } from "bun:test";

import type { LogEntry } from "../src/log-entry.js";
import { SessionLog } from "../src/session/session-log.js";

let seed = 0x2f6e2b1;
function rng(): number {
  // Deterministic LCG so failures reproduce.
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
    content: { marker: id },
    display: id,
    displayKind: null,
    meta,
  } as unknown as LogEntry;
}

/** Reference implementations — the scans the index replaced. */
function refFindById(entries: LogEntry[], id: string): LogEntry | undefined {
  return entries.find((e) => e.id === id);
}
function refFindToolCall(entries: LogEntry[], callId: string): LogEntry | undefined {
  return entries.find(
    (e) => e.type === "tool_call" &&
      String((e.meta as Record<string, unknown>)["toolCallId"] ?? "") === callId,
  );
}

function buildRandomLog(log: SessionLog, count: number, idPrefix: string): void {
  for (let i = 0; i < count; i++) {
    const r = rng();
    if (r < 0.2) {
      // Tool call; 25% of these reuse an earlier callId (some providers emit
      // non-unique ids — first-occurrence semantics must hold).
      const reuse = r < 0.05 && i > 10;
      const callId = reuse ? `${idPrefix}-call-${Math.floor(rng() * i)}` : `${idPrefix}-call-${i}`;
      log.append(mk("tool_call", `${idPrefix}-tc-${i}`, { toolCallId: callId, toolName: "probe" }));
    } else if (r < 0.35) {
      log.append(mk("tool_result", `${idPrefix}-tr-${i}`, { toolCallId: `${idPrefix}-call-${Math.floor(rng() * Math.max(1, i))}` }));
    } else if (r < 0.5) {
      const e = mk("assistant_text", `${idPrefix}-at-${i}`);
      e.discarded = rng() < 0.2;
      log.append(e);
    } else {
      log.append(mk("status", `${idPrefix}-st-${i}`));
    }
  }
}

describe("SessionLog index equivalence", () => {
  it("matches the linear scans on a randomized log, including duplicate callIds", () => {
    const log = new SessionLog();
    buildRandomLog(log, 500, "a");
    const entries = log.entries;

    for (const e of entries) {
      expect(log.findEntryById(e.id)).toBe(refFindById(entries, e.id)!);
    }
    expect(log.findEntryById("absent")).toBeUndefined();

    const callIds = new Set<string>();
    for (const e of entries) {
      if (e.type !== "tool_call") continue;
      callIds.add(String((e.meta as Record<string, unknown>)["toolCallId"]));
    }
    expect(callIds.size).toBeGreaterThan(20);
    for (const callId of callIds) {
      expect(log.findToolCallByCallId(callId)).toBe(refFindToolCall(entries, callId)!);
    }
    expect(log.findToolCallByCallId("absent")).toBeUndefined();
    expect(log.findToolCallByCallId("")).toBeUndefined();
  });

  it("picks up appends made after the first lookup (watermark extension)", () => {
    const log = new SessionLog();
    buildRandomLog(log, 50, "b");
    expect(log.findEntryById(log.entries[0].id)).toBe(log.entries[0]);

    log.append(mk("tool_call", "b-late", { toolCallId: "b-late-call" }));
    expect(log.findEntryById("b-late")).toBe(log.entries[log.entries.length - 1]);
    expect(log.findToolCallByCallId("b-late-call")).toBe(log.entries[log.entries.length - 1]);
  });

  it("replace() drops the old index", () => {
    const log = new SessionLog();
    buildRandomLog(log, 50, "c");
    const reusedId = log.entries[0].id;
    const goneId = log.entries[1].id;
    expect(log.findEntryById(reusedId)).toBe(log.entries[0]);

    // New array reuses an id at a different position.
    const fresh = [mk("status", "pad-1"), mk("status", reusedId)];
    log.replace(fresh);
    expect(log.findEntryById(reusedId)).toBe(fresh[1]);
    expect(log.findEntryById(goneId)).toBeUndefined();
  });

  it("survives rewind-style truncation with invalidate, including id reuse", () => {
    const log = new SessionLog();
    buildRandomLog(log, 100, "d");
    const entries = log.entries;
    const survivor = entries[10];
    const truncatedId = entries[80].id;
    expect(log.findEntryById(truncatedId)).toBeDefined();

    entries.length = 50; // rewindConversation mutates the array directly...
    log.invalidateIndexes(); // ...and invalidates, per the contract.

    expect(log.findEntryById(survivor.id)).toBe(survivor);
    expect(log.findEntryById(truncatedId)).toBeUndefined();

    // Post-rewind the allocator re-bases — a truncated id can come back on a
    // brand-new entry.
    const reborn = mk("status", truncatedId);
    log.append(reborn);
    expect(log.findEntryById(truncatedId)).toBe(reborn);
  });

  it("self-heals stale hits even without the invalidate call", () => {
    const log = new SessionLog();
    buildRandomLog(log, 100, "e");
    const entries = log.entries;
    const truncatedId = entries[90].id;
    expect(log.findEntryById(truncatedId)).toBeDefined();

    entries.length = 50; // out-of-band truncation, contract violated on purpose
    expect(log.findEntryById(truncatedId)).toBeUndefined();
    expect(log.findEntryById(entries[5].id)).toBe(entries[5]);
  });

  it("shrink-then-regrow without invalidate still indexes the re-grown span", () => {
    const log = new SessionLog();
    buildRandomLog(log, 100, "f");
    const entries = log.entries;
    expect(log.findEntryById(entries[99].id)).toBe(entries[99]); // watermark = 100

    entries.length = 50; // contract violation: no invalidate, no lookup yet
    // Grow back past the old watermark purely via append().
    const fresh: LogEntry[] = [];
    for (let i = 0; i < 60; i++) {
      const e = mk("status", `f-regrow-${i}`);
      fresh.push(e);
      log.append(e);
    }
    for (const e of fresh) {
      expect(log.findEntryById(e.id)).toBe(e);
    }
    expect(log.findEntryById(entries[5].id)).toBe(entries[5]);
  });
});
