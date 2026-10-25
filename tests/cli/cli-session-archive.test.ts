/**
 * CLI 入口：`sessions archive <id>` / `sessions restore <id>` 的端到端行为。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildLogHead, entryToSnake } from "../../src/config/log-codec.js";
import { LOG_JSONL_VERSION } from "../../src/config/log-jsonl.js";
import { createLogSessionMeta } from "../../src/config/session-meta.js";
import { projectSlug } from "../../src/config/storage-layout.js";
import { createUserMessage } from "../../src/context/entry/factories.js";
import { main } from "../../src/cli.js";

const PROJECT_PATH = "F:/work/demo";
const SLUG = projectSlug(PROJECT_PATH);
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

let activeBaseDir: string | null = null;
let logSpy: ReturnType<typeof vi.spyOn> | null = null;

function outputText(): string {
  return logSpy?.mock.calls.map((call) => call.join(" ")).join("\n") ?? "";
}

function seedSession(baseDir: string): void {
  const dir = join(baseDir, "projects", SLUG, SESSION_ID);
  mkdirSync(dir, { recursive: true });
  const meta = createLogSessionMeta({
    sessionId: SESSION_ID,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
    projectPath: PROJECT_PATH,
    modelConfigName: "test-model",
    summary: "summary",
    title: "Cold session",
    turnCount: 2,
    compactCount: 0,
    thinkingLevel: "off",
  });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({ session_id: SESSION_ID, title: "Cold session", turn_count: 2, created_at: meta.createdAt }),
  );
  const entry = createUserMessage("e-1", 1, "hello", { role: "user", content: "hello" }, "ctx-1");
  const lines = [
    { v: LOG_JSONL_VERSION, op: "session", seq: 1, ts: "2026-10-23T00:00:00.000Z", session: buildLogHead(meta) },
    { v: LOG_JSONL_VERSION, op: "upsert", seq: 2, ts: "2026-10-23T00:00:01.000Z", entries: [entryToSnake(entry)] },
  ];
  writeFileSync(join(dir, "log.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

afterEach(() => {
  logSpy?.mockRestore();
  logSpy = null;
  if (activeBaseDir) rmSync(activeBaseDir, { recursive: true, force: true });
  activeBaseDir = null;
});

describe("CLI sessions archive / restore", () => {
  it("归档后目录搬走，restore 后原样回来", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "swarmflow-cli-cold-"));
    activeBaseDir = baseDir;
    seedSession(baseDir);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await main(["node", "swarmflow", "sessions", "archive", SESSION_ID, "--work-dir", PROJECT_PATH], { homeDir: baseDir });
    expect(outputText()).toContain("已归档");
    expect(existsSync(join(baseDir, "projects", SLUG, SESSION_ID))).toBe(false);
    expect(existsSync(join(baseDir, "archived_sessions", SLUG, SESSION_ID, "log.jsonl.gz"))).toBe(true);

    await main(["node", "swarmflow", "sessions", "restore", SESSION_ID, "--work-dir", PROJECT_PATH], { homeDir: baseDir });
    expect(outputText()).toContain("已恢复");
    expect(existsSync(join(baseDir, "projects", SLUG, SESSION_ID, "log.jsonl"))).toBe(true);
    expect(existsSync(join(baseDir, "archived_sessions", SLUG, SESSION_ID))).toBe(false);
  });

  it("未知 id 给出错误但不改文件", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "swarmflow-cli-cold-"));
    activeBaseDir = baseDir;
    seedSession(baseDir);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await main(["node", "swarmflow", "sessions", "archive", "11111111-1111-4111-8111-111111111111", "--work-dir", PROJECT_PATH], { homeDir: baseDir });
    expect(outputText()).toContain("找不到");
    expect(existsSync(join(baseDir, "projects", SLUG, SESSION_ID))).toBe(true);
  });
});
