/**
 * P-5 残留：列表只读 legacy log.json 头部，不解析 entries 正文。
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { SessionStore } from "../../src/config/session-store.js";
import { listSessionsForProject } from "../../src/session/resume.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swarmflow-legacy-list-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function header(summary = "legacy summary"): Record<string, unknown> {
  return {
    version: 3,
    session_id: "legacy-session",
    created_at: "2026-10-20T00:00:00.000Z",
    updated_at: "2026-10-21T00:00:00.000Z",
    summary,
    title: "Legacy",
    turn_count: 2,
    archived: false,
  };
}

/** 合法头部 + 非法 entries 正文：整读会 JSON.parse 失败，只读头部应成功。 */
function writeLegacyWithBrokenBody(dir: string, opts: { summary?: string; pretty?: boolean } = {}): void {
  mkdirSync(dir, { recursive: true });
  const head = header(opts.summary);
  let raw: string;
  if (opts.pretty) {
    raw = `${JSON.stringify(head, null, 2).replace(/\n}$/, "")},\n  "entries": [{"broken":`;
  } else {
    raw = `${JSON.stringify(head).slice(0, -1)},"entries":[{"broken":`;
  }
  writeFileSync(join(dir, "log.json"), raw, "utf-8");
}

function writeJsonlWithBrokenTail(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const record = {
    v: 4,
    op: "session",
    seq: 1,
    ts: "2026-10-20T00:00:00.000Z",
    session: {
      version: 4,
      session_id: "jsonl-session",
      created_at: "2026-10-20T00:00:00.000Z",
      updated_at: "2026-10-21T00:00:00.000Z",
      summary: "jsonl summary",
      title: "Jsonl",
      turn_count: 3,
    },
  };
  writeFileSync(join(dir, "log.jsonl"), `${JSON.stringify(record)}\n{ broken\n`, "utf-8");
}

describe("legacy 列表 header 快路径", () => {
  it("JSONL：坏行不影响列表（只读第一行）", () => {
    const projectDir = makeDir();
    const sessionDir = join(projectDir, randomUUID());
    writeJsonlWithBrokenTail(sessionDir);

    expect(listSessionsForProject(projectDir)[0]).toMatchObject({
      sessionId: "jsonl-session",
      title: "Jsonl",
      turns: 3,
    });
  });

  it("meta.json 损坏时 JSONL 仍只读 header 列出", () => {
    const projectDir = makeDir();
    const sessionDir = join(projectDir, randomUUID());
    writeJsonlWithBrokenTail(sessionDir);
    writeFileSync(join(sessionDir, "meta.json"), "{ broken", "utf-8");

    expect(listSessionsForProject(projectDir)[0]).toMatchObject({
      sessionId: "jsonl-session",
      turns: 3,
    });
  });

  it("meta.json 损坏时 legacy 仍只读 header 列出", () => {
    const projectDir = makeDir();
    const sessionDir = join(projectDir, randomUUID());
    writeLegacyWithBrokenBody(sessionDir);
    writeFileSync(join(sessionDir, "meta.json"), "{ broken", "utf-8");

    expect(listSessionsForProject(projectDir)[0]).toMatchObject({
      sessionId: "legacy-session",
      turns: 2,
    });
  });

  it("listSessionsForProject：头部合法、正文非法仍列出", () => {
    const projectDir = makeDir();
    const sessionDir = join(projectDir, randomUUID());
    writeLegacyWithBrokenBody(sessionDir);

    const sessions = listSessionsForProject(projectDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: "legacy-session",
      title: "Legacy",
      turns: 2,
      summary: "legacy summary",
    });
  });

  it("SessionStore.listSessions：头部合法、正文非法仍列出", () => {
    const baseDir = makeDir();
    const projectRoot = makeDir();
    const store = new SessionStore({ baseDir, projectPath: projectRoot });
    const sessionDir = store.createSession();
    writeLegacyWithBrokenBody(sessionDir);

    expect(store.listSessions()).toHaveLength(1);
    expect(store.listSessions()[0]).toMatchObject({ sessionId: "legacy-session", turns: 2 });
  });

  it("pretty-printed 头部同样只解析到 entries 之前", () => {
    const projectDir = makeDir();
    const sessionDir = join(projectDir, randomUUID());
    writeLegacyWithBrokenBody(sessionDir, { pretty: true });

    expect(listSessionsForProject(projectDir)[0]?.turns).toBe(2);
  });

  it("头部超过 64 KiB 时回退整读，仍能列出", () => {
    const projectDir = makeDir();
    const sessionDir = join(projectDir, randomUUID());
    mkdirSync(sessionDir, { recursive: true });
    const raw = JSON.stringify({ ...header("x".repeat(100_000)), entries: [] });
    writeFileSync(join(sessionDir, "log.json"), raw, "utf-8");

    expect(listSessionsForProject(projectDir)[0]?.turns).toBe(2);
  });
});
