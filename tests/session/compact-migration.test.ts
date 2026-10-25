/**
 * Phase 5 一次性迁移：旧 marker/context + window-N 归档 → checkpoint 格式。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildLogHead, entryToSnake } from "../../src/config/log-codec.js";
import {
  LOG_JSONL_VERSION,
  appendRecords,
  readRecords,
} from "../../src/config/log-jsonl.js";
import { createLogSessionMeta, saveSessionMeta } from "../../src/config/session-meta.js";
import { readGzipJsonlEnvelope, writeGzipJson } from "../../src/config/gzip-json.js";
import { migrateCompactFormat } from "../../src/session/compact-migration.js";
import { applySessionRestore } from "../../src/session/resume.js";
import { makeScriptedSession } from "../helpers/session-harness.js";
import {
  createAssistantText,
  createCompactContext,
  createCompactMarker,
  createSystemPrompt,
  createUserMessage,
} from "../../src/context/entry/factories.js";
import type { LogEntry } from "../../src/context/entry/types.js";

const TS = "2026-10-25T00:00:00.000Z";

function makeMeta() {
  return createLogSessionMeta({
    sessionId: "legacy-compact",
    createdAt: TS,
    updatedAt: TS,
    projectPath: "/work/demo",
    modelConfigName: "test-model",
    summary: "legacy",
    turnCount: 2,
    compactCount: 1,
    thinkingLevel: "off",
    idCounters: { sys: 1, user: 2, asst: 2, cm: 1, cc: 1 },
    workCount: 1,
    tokens: { input: 100, output: 10, cacheRead: 0 },
  });
}

describe("migrate compact format", () => {
  it("upgrades a v4 session without compact records so it remains resumable", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarmflow-compact-migrate-v4-plain-"));
    try {
      const meta = makeMeta();
      const session = { ...buildLogHead(meta), version: 4 } as Record<string, unknown>;
      delete session["compaction_format"];
      const entry = createSystemPrompt("sys-1", "system");
      writeFileSync(join(dir, "log.jsonl"), [
        JSON.stringify({ v: 4, op: "session", seq: 1, ts: TS, session }),
        JSON.stringify({ v: 4, op: "upsert", seq: 2, ts: TS, entries: [entryToSnake(entry)] }),
        "",
      ].join("\n"));

      const result = migrateCompactFormat(dir);
      expect(result).toMatchObject({ migrated: true, checkpoints: 0, archivesMigrated: 0 });
      expect(readRecords(dir).records.every((record) => record.v === LOG_JSONL_VERSION)).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"))["compaction_format"]).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe legacy checkpoint ids before writing an archive", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarmflow-compact-migrate-unsafe-id-"));
    try {
      const meta = makeMeta();
      const marker = createCompactMarker("../escape", 2, 0, 100, 20);
      const context = createCompactContext("cc-1", 2, "briefing", "ctx-b", 0);
      const session = { ...buildLogHead(meta), version: 4 } as Record<string, unknown>;
      delete session["compaction_format"];
      writeFileSync(join(dir, "log.jsonl"), [
        JSON.stringify({ v: 4, op: "session", seq: 1, ts: TS, session }),
        JSON.stringify({ v: 4, op: "upsert", seq: 2, ts: TS, entries: [entryToSnake(marker)] }),
        JSON.stringify({ v: 4, op: "upsert", seq: 3, ts: TS, entries: [entryToSnake(context)] }),
        "",
      ].join("\n"));
      const before = readFileSync(join(dir, "log.jsonl"));

      expect(() => migrateCompactFormat(dir)).toThrow(/checkpoint|id|filename/i);
      expect(readFileSync(join(dir, "log.jsonl")).equals(before)).toBe(true);
      expect(existsSync(join(dir, "escape"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not pair a same-turn context with a different compact index", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarmflow-compact-migrate-mismatch-"));
    try {
      const meta = makeMeta();
      const marker = createCompactMarker("cm-1", 2, 0, 100, 20);
      const context = createCompactContext("cc-1", 2, "wrong briefing", "ctx-b", 1);
      const session = { ...buildLogHead(meta), version: 4 } as Record<string, unknown>;
      delete session["compaction_format"];
      writeFileSync(join(dir, "log.jsonl"), [
        JSON.stringify({ v: 4, op: "session", seq: 1, ts: TS, session }),
        JSON.stringify({ v: 4, op: "upsert", seq: 2, ts: TS, entries: [entryToSnake(marker)] }),
        JSON.stringify({ v: 4, op: "upsert", seq: 3, ts: TS, entries: [entryToSnake(context)] }),
        "",
      ].join("\n"));

      expect(() => migrateCompactFormat(dir)).toThrow(/context|pair/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("converts legacy marker/context and window-N archive, then is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarmflow-compact-migrate-"));
    try {
      const meta = makeMeta();
      const archivedUser = createUserMessage("user-1", 1, "old", "old", "ctx-a");
      archivedUser.archived = true;
      archivedUser.content = null;
      archivedUser.display = "";
      const archivedAssistant = createAssistantText("asst-1", 1, 0, "", "old answer", "ctx-a");
      archivedAssistant.archived = true;
      archivedAssistant.content = null;
      const marker = createCompactMarker("cm-1", 2, 0, 100, 20);
      const context = createCompactContext("cc-1", 2, "briefing", "ctx-b", 0);
      const entries: LogEntry[] = [
        createSystemPrompt("sys-1", "system"),
        archivedUser,
        archivedAssistant,
        marker,
        context,
      ];

      appendRecords(dir, [
        {
          v: LOG_JSONL_VERSION,
          op: "session",
          seq: 1,
          ts: TS,
          session: { ...buildLogHead(meta), version: LOG_JSONL_VERSION },
        },
        ...entries.map((entry, index) => ({
          v: LOG_JSONL_VERSION as typeof LOG_JSONL_VERSION,
          op: "upsert" as const,
          seq: index + 2,
          ts: TS,
          entries: [entryToSnake(entry)],
        })),
      ]);
      saveSessionMeta(dir, meta);

      const oldRecords = readFileSync(join(dir, "log.jsonl"), "utf-8")
        .trimEnd()
        .split("\n")
        .map((line) => {
          const record = JSON.parse(line) as Record<string, unknown>;
          record["v"] = 4;
          if (record["op"] === "session") {
            const session = record["session"] as Record<string, unknown>;
            session["version"] = 4;
          }
          return JSON.stringify(record);
        });
      writeFileSync(join(dir, "log.jsonl"), `${oldRecords.join("\n")}\n`);

      mkdirSync(join(dir, "archive"), { recursive: true });
      writeGzipJson(join(dir, "archive", "window-0.json.gz"), [
        { id: "user-1", content: "old", display: "old", meta: { contextId: "ctx-a" } },
        { id: "asst-1", content: "old answer", display: "old answer", meta: { contextId: "ctx-a" } },
      ]);
      writeGzipJson(join(dir, "archive", "window-0.index.json.gz"), {
        turns: [],
        mutations: [],
        hasPresentation: true,
        entryIds: ["user-1", "asst-1"],
      });

      const result = migrateCompactFormat(dir);
      expect(result.migrated).toBe(true);
      expect(result.checkpoints).toBe(1);
      expect(result.archivesMigrated).toBe(1);
      expect(existsSync(result.backups[0]!)).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"))["compaction_format"]).toBe(2);

      const records = readRecords(dir).records;
      expect(records.every((record) => record.v === LOG_JSONL_VERSION)).toBe(true);
      expect(records.some((record) => record.op === "compact_checkpoint")).toBe(true);
      expect(existsSync(join(dir, "archive", "window-0.json.gz"))).toBe(false);

      const newArchive = readGzipJsonlEnvelope<{ id: string }, { entryIds: string[] }>(
        join(dir, "archive", "window-cm-1.jsonl.gz"),
      );
      expect(newArchive.entries.map((record) => record.id)).toEqual(["user-1", "asst-1"]);
      expect(newArchive.index.entryIds).toEqual(["user-1", "asst-1"]);

      const second = migrateCompactFormat(dir);
      expect(second.migrated).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cleans new archives and preserves the legacy log when a later archive write fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarmflow-compact-migrate-rollback-"));
    try {
      const meta = makeMeta();
      const firstArchived = createUserMessage("user-1", 1, "old one", "old one", "ctx-a");
      firstArchived.archived = true;
      firstArchived.content = null;
      firstArchived.display = "";
      const secondArchived = createAssistantText("asst-2", 2, 0, "", "old two", "ctx-b");
      secondArchived.archived = true;
      secondArchived.content = null;
      const entries: LogEntry[] = [
        createSystemPrompt("sys-1", "system"),
        firstArchived,
        createCompactMarker("cm-1", 1, 0, 100, 20),
        createCompactContext("cc-1", 1, "first briefing", "ctx-c", 0),
        secondArchived,
        createCompactMarker("cm-2", 2, 1, 100, 20),
        createCompactContext("cc-2", 2, "second briefing", "ctx-d", 1),
      ];
      appendRecords(dir, [
        {
          v: LOG_JSONL_VERSION,
          op: "session",
          seq: 1,
          ts: TS,
          session: { ...buildLogHead(meta), version: LOG_JSONL_VERSION },
        },
        ...entries.map((entry, index) => ({
          v: LOG_JSONL_VERSION,
          op: "upsert" as const,
          seq: index + 2,
          ts: TS,
          entries: [entryToSnake(entry)],
        })),
      ]);
      saveSessionMeta(dir, meta);
      mkdirSync(join(dir, "archive"), { recursive: true });
      writeGzipJson(join(dir, "archive", "window-0.json.gz"), [
        { id: "user-1", content: "old one", display: "old one", meta: { contextId: "ctx-a" } },
      ]);
      writeGzipJson(join(dir, "archive", "window-1.json.gz"), [
        { id: "asst-2", content: "old two", display: "old two", meta: { contextId: "ctx-b" } },
      ]);
      mkdirSync(join(dir, "archive", "window-cm-2.jsonl.gz"));
      const before = readFileSync(join(dir, "log.jsonl"));

      expect(() => migrateCompactFormat(dir)).toThrow();
      expect(readFileSync(join(dir, "log.jsonl")).equals(before)).toBe(true);
      expect(existsSync(join(dir, "archive", "window-cm-1.jsonl.gz"))).toBe(false);
      expect(existsSync(join(dir, "archive", "window-0.json.gz"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resume rejects a legacy marker even when its archive window is already missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarmflow-compact-marker-only-"));
    const h = makeScriptedSession();
    try {
      const meta = makeMeta();
      const entries = [
        createSystemPrompt("sys-1", "system"),
        createCompactMarker("cm-1", 2, 0, 100, 20),
      ];
      appendRecords(dir, [
        {
          v: LOG_JSONL_VERSION,
          op: "session",
          seq: 1,
          ts: TS,
          session: { ...buildLogHead(meta), version: LOG_JSONL_VERSION },
        },
        ...entries.map((entry, index) => ({
          v: LOG_JSONL_VERSION as typeof LOG_JSONL_VERSION,
          op: "upsert" as const,
          seq: index + 2,
          ts: TS,
          entries: [entryToSnake(entry)],
        })),
      ]);
      saveSessionMeta(dir, meta);

      const result = applySessionRestore(h.session, h.internals._store, dir);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("E_COMPACT_FORMAT_LEGACY");
    } finally {
      h.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails migration instead of silently dropping an unmatched legacy checkpoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarmflow-compact-unmatched-"));
    try {
      const meta = makeMeta();
      const entries = [
        createSystemPrompt("sys-1", "system"),
        createCompactMarker("cm-1", 2, 0, 100, 20),
      ];
      appendRecords(dir, [
        {
          v: LOG_JSONL_VERSION,
          op: "session",
          seq: 1,
          ts: TS,
          session: { ...buildLogHead(meta), version: LOG_JSONL_VERSION },
        },
        ...entries.map((entry, index) => ({
          v: LOG_JSONL_VERSION as typeof LOG_JSONL_VERSION,
          op: "upsert" as const,
          seq: index + 2,
          ts: TS,
          entries: [entryToSnake(entry)],
        })),
      ]);
      saveSessionMeta(dir, meta);
      const before = readFileSync(join(dir, "log.jsonl"));

      expect(() => migrateCompactFormat(dir)).toThrow(/context|pair/i);
      expect(readFileSync(join(dir, "log.jsonl")).equals(before)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
