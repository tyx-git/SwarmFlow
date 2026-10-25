/**
 * compact_checkpoint 格式契约：
 * - 一条记录同时携带 marker + context，回放展开为两个条目；
 * - 快照把相邻的 marker/context 折叠成单条 checkpoint 记录；
 * - 有界反向扫描停在 checkpoint，且活动窗口包含 marker + context。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { entryToSnake } from "../../src/config/log-codec.js";
import {
  LOG_JSONL_VERSION,
  appendRecords,
  loadLogJsonl,
  loadModelContext,
  readRecords,
  writeLogJsonlSnapshot,
} from "../../src/config/log-jsonl.js";
import { buildLogHead } from "../../src/config/log-codec.js";
import { createLogSessionMeta, saveSessionMeta } from "../../src/config/session-meta.js";
import {
  createAssistantText,
  createCompactContext,
  createCompactMarker,
  createSystemPrompt,
  createUserMessage,
} from "../../src/context/entry/factories.js";
import type { LogEntry } from "../../src/context/entry/types.js";

const tempDirs: string[] = [];
const TS = "2026-10-25T00:00:00.000Z";

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarmflow-checkpoint-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function makeMeta() {
  return createLogSessionMeta({
    sessionId: "checkpoint-session",
    createdAt: TS,
    updatedAt: TS,
    projectPath: "/work/demo",
    modelConfigName: "test-model",
    summary: "s",
    turnCount: 2,
    compactCount: 1,
    thinkingLevel: "off",
    idCounters: { sys: 1, user: 2, asst: 2, cm: 1, cc: 1 },
    workCount: 1,
    tokens: { input: 100, output: 10, cacheRead: 0 },
  });
}

function makePair(): { marker: LogEntry; context: LogEntry } {
  const marker = createCompactMarker("cm-1", 2, 0, 100, 20);
  marker.meta["checkpointId"] = "cm-1";
  marker.meta["archiveFile"] = "window-cm-1.json.gz";
  marker.meta["archiveIndexFile"] = "window-cm-1.index.json.gz";
  const context = createCompactContext("cc-1", 2, "continuation briefing", "ctx-b", 0);
  context.meta["checkpointId"] = "cm-1";
  return { marker, context };
}

function baseEntries(): LogEntry[] {
  return [
    createSystemPrompt("sys-1", "system"),
    createUserMessage("user-1", 1, "old request", "old request", "ctx-a"),
    createAssistantText("asst-1", 1, 0, "old answer", "old answer"),
  ];
}

describe("compact_checkpoint record", () => {
  it("replays one checkpoint into marker + context", () => {
    const dir = makeDir();
    const meta = makeMeta();
    const { marker, context } = makePair();
    appendRecords(dir, [
      {
        v: LOG_JSONL_VERSION,
        op: "session",
        seq: 1,
        ts: TS,
        session: { ...buildLogHead(meta), version: LOG_JSONL_VERSION },
      },
      {
        v: LOG_JSONL_VERSION,
        op: "compact_checkpoint",
        seq: 2,
        ts: TS,
        checkpointId: "cm-1",
        archiveFile: "window-cm-1.json.gz",
        archiveIndexFile: "window-cm-1.index.json.gz",
        compactIndex: 0,
        scenario: "manual",
        marker: entryToSnake(marker),
        context: entryToSnake(context),
      },
    ] as never);

    const loaded = loadLogJsonl(dir);
    expect(loaded.entries.map((entry) => entry.type)).toEqual(["compact_marker", "compact_context"]);
    expect(loaded.entries[0]!.meta["checkpointId"]).toBe("cm-1");
    expect(String(loaded.entries[1]!.content)).toContain("continuation briefing");
  });

  it("snapshot pairs adjacent marker/context into a single checkpoint record", () => {
    const dir = makeDir();
    const meta = makeMeta();
    const { marker, context } = makePair();
    writeLogJsonlSnapshot(dir, meta, [...baseEntries(), marker, context]);

    const records = readRecords(dir).records;
    expect(records.map((record) => record.op)).toEqual(["session", "upsert", "upsert", "upsert", "compact_checkpoint"]);

    const checkpoint = records[4];
    if (checkpoint.op !== "compact_checkpoint") throw new Error("expected checkpoint");
    expect(checkpoint.checkpointId).toBe("cm-1");
    expect(checkpoint.marker["type"]).toBe("compact_marker");
    expect(checkpoint.context["type"]).toBe("compact_context");
    expect(loadLogJsonl(dir).entries.map((entry) => entry.type)).toEqual([
      "system_prompt",
      "user_message",
      "assistant_text",
      "compact_marker",
      "compact_context",
    ]);
  });

  it("bounded reverse scan stops at checkpoint and keeps both entries", () => {
    const dir = makeDir();
    const meta = makeMeta();
    const { marker, context } = makePair();
    const after = createUserMessage("user-2", 2, "new request", "new request", "ctx-b");
    writeLogJsonlSnapshot(dir, meta, [...baseEntries(), marker, context, after]);
    saveSessionMeta(dir, meta);

    const loaded = loadModelContext(dir);
    expect(loaded.bounded).toBe(true);
    expect(loaded.entries.map((entry) => entry.id)).toEqual(["cm-1", "cc-1", "user-2"]);
  });
});
