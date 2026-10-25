/**
 * W-5 冷会话归档：显式命令把会话目录搬到 archived_sessions/ 并 gzip 活动日志；
 * restore 逐字还原并让 --resume 重新可见。不做 zstd、不按时间自动搬迁。
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { buildLogHead, entryToSnake } from "../../src/config/log-codec.js";
import { LOG_JSONL_VERSION } from "../../src/config/log-jsonl.js";
import { loadLog } from "../../src/config/log-serialization.js";
import { createLogSessionMeta } from "../../src/config/session-meta.js";
import { SessionStore } from "../../src/config/session-store.js";
import { projectSlug } from "../../src/config/storage-layout.js";
import { createUserMessage } from "../../src/context/entry/factories.js";
import { findSessionById } from "../../src/session/resume.js";

const PROJECT_PATH = "F:/work/demo";
const SLUG = projectSlug(PROJECT_PATH);
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

const tempDirs: string[] = [];

function makeBaseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarmflow-cold-archive-"));
  tempDirs.push(dir);
  return dir;
}

function makeMeta(id: string) {
  return createLogSessionMeta({
    sessionId: id,
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
}

/** 造一个“完整”会话：活动日志 + meta + archive/sealed/artifacts 各一个文件。 */
function seedSession(baseDir: string, id = SESSION_ID, opts: { legacy?: boolean } = {}): string {
  const dir = join(baseDir, "projects", SLUG, id);
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  mkdirSync(join(dir, "archive"), { recursive: true });
  mkdirSync(join(dir, "sealed"), { recursive: true });
  writeFileSync(join(dir, "artifacts", "note.txt"), "artifact");
  writeFileSync(join(dir, "archive", "keep.txt"), "archive");
  writeFileSync(join(dir, "sealed", "keep.txt"), "sealed");

  const meta = makeMeta(id);
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      session_id: id,
      created_at: meta.createdAt,
      last_active_at: meta.updatedAt,
      project_path: PROJECT_PATH,
      model_config_name: "test-model",
      summary: "summary",
      title: "Cold session",
      turn_count: 2,
      compact_count: 0,
      thinking_level: "off",
    }),
  );

  const entry = createUserMessage("e-1", 1, "hello", { role: "user", content: "hello" }, "ctx-1");
  if (opts.legacy) {
    writeFileSync(
      join(dir, "log.json"),
      JSON.stringify({ ...buildLogHead(meta), entries: [entryToSnake(entry)] }),
    );
  } else {
    const lines = [
      { v: LOG_JSONL_VERSION, op: "session", seq: 1, ts: "2026-10-23T00:00:00.000Z", session: buildLogHead(meta) },
      { v: LOG_JSONL_VERSION, op: "upsert", seq: 2, ts: "2026-10-23T00:00:01.000Z", entries: [entryToSnake(entry)] },
    ];
    writeFileSync(join(dir, "log.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  }
  return dir;
}

function archivedDir(baseDir: string, id = SESSION_ID): string {
  return join(baseDir, "archived_sessions", SLUG, id);
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("W-5 冷会话归档", () => {
  it("归档：目录搬到 archived_sessions，活动日志 gzip，列表隐藏", () => {
    const baseDir = makeBaseDir();
    const sessionDir = seedSession(baseDir);
    const store = new SessionStore({ projectPath: PROJECT_PATH, baseDir });
    const before = readFileSync(join(sessionDir, "log.jsonl"));

    const result = store.archiveSession(SESSION_ID);
    expect(result.ok).toBe(true);

    expect(existsSync(sessionDir)).toBe(false);
    const archived = archivedDir(baseDir);
    expect(existsSync(join(archived, "log.jsonl"))).toBe(false);
    const gz = join(archived, "log.jsonl.gz");
    expect(existsSync(gz)).toBe(true);
    expect(gunzipSync(readFileSync(gz)).equals(before)).toBe(true);

    // 同目录的归档/封存/工件一起搬走，不能只搬日志。
    expect(readFileSync(join(archived, "archive", "keep.txt"), "utf-8")).toBe("archive");
    expect(readFileSync(join(archived, "sealed", "keep.txt"), "utf-8")).toBe("sealed");
    expect(readFileSync(join(archived, "artifacts", "note.txt"), "utf-8")).toBe("artifact");

    const meta = JSON.parse(readFileSync(join(archived, "meta.json"), "utf-8"));
    expect(meta.archived).toBe(true);

    expect(store.listSessions()).toHaveLength(0);
    expect(findSessionById(SESSION_ID, baseDir)).toBeNull();
  });

  it("restore：日志逐字还原，会话重新可见且可加载", () => {
    const baseDir = makeBaseDir();
    const sessionDir = seedSession(baseDir);
    const store = new SessionStore({ projectPath: PROJECT_PATH, baseDir });
    const before = readFileSync(join(sessionDir, "log.jsonl"));

    expect(store.archiveSession(SESSION_ID).ok).toBe(true);
    const result = store.restoreSession(SESSION_ID);
    expect(result.ok).toBe(true);

    expect(existsSync(archivedDir(baseDir))).toBe(false);
    expect(readFileSync(join(sessionDir, "log.jsonl")).equals(before)).toBe(true);
    expect(existsSync(join(sessionDir, "log.jsonl.gz"))).toBe(false);

    const meta = JSON.parse(readFileSync(join(sessionDir, "meta.json"), "utf-8"));
    expect(meta.archived).toBeUndefined();
    expect(readFileSync(join(sessionDir, "sealed", "keep.txt"), "utf-8")).toBe("sealed");

    expect(store.listSessions()).toHaveLength(1);
    expect(findSessionById(SESSION_ID, baseDir)).not.toBeNull();
    const loaded = loadLog(sessionDir);
    expect(loaded.entries.map((entry) => entry.id)).toEqual(["e-1"]);
  });

  it("legacy log.json 也按同名 gzip 归档并逐字还原", () => {
    const baseDir = makeBaseDir();
    const sessionDir = seedSession(baseDir, SESSION_ID, { legacy: true });
    const store = new SessionStore({ projectPath: PROJECT_PATH, baseDir });
    const before = readFileSync(join(sessionDir, "log.json"));

    expect(store.archiveSession(SESSION_ID).ok).toBe(true);
    expect(existsSync(join(archivedDir(baseDir), "log.json"))).toBe(false);
    expect(gunzipSync(readFileSync(join(archivedDir(baseDir), "log.json.gz"))).equals(before)).toBe(true);

    expect(store.restoreSession(SESSION_ID).ok).toBe(true);
    expect(readFileSync(join(sessionDir, "log.json")).equals(before)).toBe(true);
    expect(existsSync(join(sessionDir, "log.json.gz"))).toBe(false);
  });

  it("守卫：非法 id / 未知 id / 重复归档 / 恢复目标已存在 / 活动会话", () => {
    const baseDir = makeBaseDir();
    const sessionDir = seedSession(baseDir);
    const store = new SessionStore({ projectPath: PROJECT_PATH, baseDir });

    expect(store.archiveSession("../../escape")).toMatchObject({ ok: false });
    expect(store.archiveSession("11111111-1111-4111-8111-111111111111")).toMatchObject({ ok: false });
    expect(existsSync(sessionDir)).toBe(true);

    expect(store.archiveSession(SESSION_ID).ok).toBe(true);
    const archived = archivedDir(baseDir);
    expect(store.archiveSession(SESSION_ID)).toMatchObject({ ok: false });
    expect(statSync(archived).isDirectory()).toBe(true);

    // 恢复目标被占：拒绝且不动归档目录。
    mkdirSync(sessionDir, { recursive: true });
    expect(store.restoreSession(SESSION_ID)).toMatchObject({ ok: false });
    expect(existsSync(join(archived, "log.jsonl.gz"))).toBe(true);
    rmSync(sessionDir, { recursive: true, force: true });

    // 活动会话不允许归档。
    const activeId = "33333333-3333-4333-8333-333333333333";
    const activeDir = seedSession(baseDir, activeId);
    store.attachToExistingSession(activeDir);
    expect(store.archiveSession(activeId)).toMatchObject({ ok: false });
    expect(existsSync(activeDir)).toBe(true);
  });
});
