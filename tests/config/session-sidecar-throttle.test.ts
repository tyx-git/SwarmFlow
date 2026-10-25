/**
 * P-14 伴生文件节流：meta.json 仅在字段变化时写，project.json 的
 * last_active_at 跨分钟才写；两者都改为紧凑 JSON。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveSessionSidecars } from "../../src/config/log-serialization.js";
import { createLogSessionMeta, type LogSessionMeta } from "../../src/config/session-meta.js";

const tempDirs: string[] = [];
const PINNED_MTIME = new Date("2001-02-03T04:05:06.000Z");

function makeLayout(): { projectDir: string; sessionDir: string } {
  const root = mkdtempSync(join(tmpdir(), "swarmflow-sidecar-"));
  tempDirs.push(root);
  const projectDir = join(root, "projects", "demo");
  const sessionDir = join(projectDir, "sess-1");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(projectDir, "project.json"),
    JSON.stringify({
      original_path: "/work/demo",
      created_at: "2026-10-20T00:00:00.000Z",
      last_active_at: "2000-01-01T00:00:00.000Z",
    }),
  );
  return { projectDir, sessionDir };
}

function makeMeta(): LogSessionMeta {
  return createLogSessionMeta({
    sessionId: "sess-1",
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    projectPath: "/work/demo",
    modelConfigName: "test-model",
    summary: "summary",
    title: "title",
    turnCount: 1,
    compactCount: 0,
    thinkingLevel: "off",
  });
}

function pinMtime(...files: string[]): void {
  for (const file of files) utimesSync(file, PINNED_MTIME, PINNED_MTIME);
}

function isPinned(file: string): boolean {
  return Math.abs(statSync(file).mtimeMs - PINNED_MTIME.getTime()) < 1000;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("P-14 伴生文件节流", () => {
  it("首次保存用紧凑 JSON，保留外部字段", () => {
    const { projectDir, sessionDir } = makeLayout();
    const metaFile = join(sessionDir, "meta.json");
    const projectFile = join(projectDir, "project.json");
    writeFileSync(
      metaFile,
      JSON.stringify({ archived: true, session_id: "sess-1", created_at: "2026-10-20T00:00:00.000Z" }),
    );

    const meta = makeMeta();
    saveSessionSidecars(sessionDir, meta);

    const rawMeta = readFileSync(metaFile, "utf-8");
    const rawProject = readFileSync(projectFile, "utf-8");
    expect(rawMeta).not.toContain("\n");
    expect(rawProject).not.toContain("\n");

    const storedMeta = readJson(metaFile);
    expect(storedMeta["archived"]).toBe(true);
    expect(storedMeta["persistence_policy"]).toBe(3);
    expect(storedMeta["last_active_at"]).toBe(meta.updatedAt);
    expect(readJson(projectFile)["last_active_at"]).toBe(meta.updatedAt);
  });

  it("同一分钟内重复保存不重写 meta.json 与 project.json", () => {
    const { projectDir, sessionDir } = makeLayout();
    const metaFile = join(sessionDir, "meta.json");
    const projectFile = join(projectDir, "project.json");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T10:00:05.000Z"));
    const meta = makeMeta();
    saveSessionSidecars(sessionDir, meta);
    expect(readJson(metaFile)["last_active_at"]).toBe("2026-10-23T10:00:05.000Z");

    pinMtime(metaFile, projectFile);
    vi.setSystemTime(new Date("2026-10-23T10:00:50.000Z"));
    saveSessionSidecars(sessionDir, meta);

    // 文件没被重写：mtime 保持固定值，磁盘上的 last_active_at 仍是首次时间。
    expect(isPinned(metaFile)).toBe(true);
    expect(isPinned(projectFile)).toBe(true);
    expect(readJson(metaFile)["last_active_at"]).toBe("2026-10-23T10:00:05.000Z");
    expect(readJson(projectFile)["last_active_at"]).toBe("2026-10-23T10:00:05.000Z");
    // 内存里的 updatedAt 仍是最新值，只有落盘被节流。
    expect(meta.updatedAt).toBe("2026-10-23T10:00:50.000Z");
  });

  it("字段变化立即落盘，不被时间节流吞掉", () => {
    const { projectDir, sessionDir } = makeLayout();
    const metaFile = join(sessionDir, "meta.json");
    const projectFile = join(projectDir, "project.json");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T10:00:05.000Z"));
    const meta = makeMeta();
    saveSessionSidecars(sessionDir, meta);
    pinMtime(metaFile, projectFile);

    vi.setSystemTime(new Date("2026-10-23T10:00:10.000Z"));
    meta.title = "renamed";
    meta.turnCount = 2;
    saveSessionSidecars(sessionDir, meta);

    expect(isPinned(metaFile)).toBe(false);
    expect(readJson(metaFile)["title"]).toBe("renamed");
    expect(readJson(metaFile)["turn_count"]).toBe(2);
    // 内容未变的 project.json 仍不重写。
    expect(isPinned(projectFile)).toBe(true);
  });

  it("跨越分钟后 last_active_at 才更新", () => {
    const { projectDir, sessionDir } = makeLayout();
    const metaFile = join(sessionDir, "meta.json");
    const projectFile = join(projectDir, "project.json");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T10:00:05.000Z"));
    const meta = makeMeta();
    saveSessionSidecars(sessionDir, meta);

    pinMtime(metaFile, projectFile);
    vi.setSystemTime(new Date("2026-10-23T10:00:59.999Z"));
    saveSessionSidecars(sessionDir, meta);
    expect(isPinned(metaFile)).toBe(true);
    expect(isPinned(projectFile)).toBe(true);

    vi.setSystemTime(new Date("2026-10-23T10:01:00.000Z"));
    saveSessionSidecars(sessionDir, meta);
    expect(isPinned(metaFile)).toBe(false);
    expect(isPinned(projectFile)).toBe(false);
    expect(readJson(metaFile)["last_active_at"]).toBe("2026-10-23T10:01:00.000Z");
    expect(readJson(projectFile)["last_active_at"]).toBe("2026-10-23T10:01:00.000Z");
  });

  it("project.json 缺失时静默跳过，不阻断 meta.json", () => {
    const { projectDir, sessionDir } = makeLayout();
    rmSync(join(projectDir, "project.json"));

    const meta = makeMeta();
    expect(() => saveSessionSidecars(sessionDir, meta)).not.toThrow();
    expect(readJson(join(sessionDir, "meta.json"))["session_id"]).toBe("sess-1");
  });
});
