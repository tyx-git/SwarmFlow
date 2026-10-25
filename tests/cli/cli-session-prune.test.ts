/**
 * CLI `sessions prune <id>`：dry-run 与显式清理。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { archiveWindow } from "../../src/config/archive.js";
import { writeLogJsonlSnapshot } from "../../src/config/log-jsonl.js";
import { createLogSessionMeta } from "../../src/config/session-meta.js";
import { projectSlug } from "../../src/config/storage-layout.js";
import {
  createAssistantText,
  createCompactMarker,
  createSystemPrompt,
  createTurnEnd,
  createTurnStart,
  createUserMessage,
} from "../../src/context/entry/factories.js";
import type { LogEntry } from "../../src/context/entry/types.js";
import { main } from "../../src/cli.js";
import { TURN_INDEX_FILENAME } from "../../src/session/turn-index.js";

const PROJECT_PATH = "F:/work/prune-demo";
const SLUG = projectSlug(PROJECT_PATH);
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

let baseDir: string | null = null;
let logSpy: ReturnType<typeof vi.spyOn> | null = null;

function outputText(): string {
  return logSpy?.mock.calls.map((call) => call.join(" ")).join("\n") ?? "";
}

function seed(base: string): { dir: string; before: number } {
  const dir = join(base, "projects", SLUG, SESSION_ID);
  mkdirSync(dir, { recursive: true });
  const entries: LogEntry[] = [
    createSystemPrompt("sys-1", 0, "system"),
    createTurnStart("ts-old", 1),
    createUserMessage("u-old", 1, "old", "old", "ctx-old"),
    createAssistantText("a-old", 1, 0, "old answer", "old answer"),
    createTurnEnd("te-old", 1, "completed"),
    createCompactMarker("cm-live", 2, 0, 100, 0),
    createTurnStart("ts-new", 2),
    createUserMessage("u-new", 2, "new", "new", "ctx-new"),
    createAssistantText("a-new", 2, 0, "new answer", "new answer"),
    createTurnEnd("te-new", 2, "completed"),
  ];
  const ids = archiveWindow(dir, 0, entries, 1, 4);
  for (const id of ids) {
    const entry = entries.find((item) => item.id === id)!;
    entry.archived = true;
    entry.content = null;
  }
  writeLogJsonlSnapshot(dir, createLogSessionMeta({
    sessionId: SESSION_ID,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
    projectPath: PROJECT_PATH,
    modelConfigName: "test-model",
    summary: "prune",
    title: "Prune",
    turnCount: 2,
    compactCount: 1,
    thinkingLevel: "off",
  }), entries);
  writeFileSync(join(dir, TURN_INDEX_FILENAME), "{}\n");
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  writeFileSync(join(dir, "artifacts", "big.bin"), "x".repeat(1000));
  return { dir, before: statSync(join(dir, "log.jsonl")).size };
}

afterEach(() => {
  logSpy?.mockRestore();
  logSpy = null;
  if (baseDir) rmSync(baseDir, { recursive: true, force: true });
  baseDir = null;
});

describe("CLI sessions prune", () => {
  it("dry-run 不写盘；实际 prune 删除前缀并报告丢失 turn", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "swarmflow-cli-prune-"));
    const { dir, before } = seed(baseDir);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await main(["node", "swarmflow", "sessions", "prune", SESSION_ID, "--dry-run", "--work-dir", PROJECT_PATH], { homeDir: baseDir });
    expect(outputText()).toContain("dry-run");
    expect(statSync(join(dir, "log.jsonl")).size).toBe(before);
    expect(existsSync(join(dir, TURN_INDEX_FILENAME))).toBe(true);

    await main(["node", "swarmflow", "sessions", "prune", SESSION_ID, "--max-log-bytes", "1", "--work-dir", PROJECT_PATH], { homeDir: baseDir });
    expect(outputText()).toContain("已清理");
    expect(outputText()).toContain("丢失回退 turn: 1");
    expect(statSync(join(dir, "log.jsonl")).size).toBeLessThan(before);
    expect(existsSync(join(dir, TURN_INDEX_FILENAME))).toBe(false);
    expect(existsSync(join(dir, "archive", "window-0.json.gz"))).toBe(true);
  });
});
