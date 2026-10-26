/**
 * W-2 写前策略（只写完成态、64 KiB 截断、图片外置）与 W-7 迁移契约。
 * 期望值来自写前策略与一次性迁移的格式约定，不来自实现。
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LOG_JSONL_BACKUP_SUFFIX,
  LOG_JSONL_FILENAME,
  loadLogJsonl,
  migrateLogToJsonl,
  readLogHeader,
  readRecords,
} from "../../src/config/log-jsonl.js";
import {
  PERSISTED_TOOL_OUTPUT_MAX_BYTES,
  capPersistedEntry,
  shouldPersistEntry,
} from "../../src/config/log-write-policy.js";
import { loadLegacyLog, saveLog } from "../../src/config/log-serialization.js";
import { createLogSessionMeta } from "../../src/config/session-meta.js";
import {
  createAssistantText,
  createStatus,
  createSystemPrompt,
  createToolResult,
  createTurnStart,
  createUserMessage,
} from "../../src/context/entry/factories.js";
import { forkSessionDirectory } from "../../src/server/session-fork.js";

const tempDirs: string[] = [];

function makeDir(prefix = "swarmflow-jsonl-policy-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function toolResult(content: string, metadata?: Record<string, unknown>) {
  return createToolResult(
    "tr-1",
    1,
    0,
    { toolCallId: "call-1", toolName: "bash", content, toolSummary: "summary" },
    { isError: false, toolMetadata: metadata },
  );
}

describe("shouldPersistEntry", () => {
  it("普通条目写", () => {
    expect(shouldPersistEntry(createAssistantText("asst-1", 1, 0, "hi", "hi"))).toBe(true);
    expect(shouldPersistEntry(createUserMessage("user-1", 1, "hi", "hi"))).toBe(true);
  });

  it("ephemeral 不写", () => {
    const entry = createStatus("status-1", 0, "hint", "status");
    entry.meta["ephemeral"] = true;
    expect(shouldPersistEntry(entry)).toBe(false);
  });

  it("流式/运行中的工具状态先不写", () => {
    const partial = toolResult("partial");
    partial.meta["toolStreamState"] = "partial";
    expect(shouldPersistEntry(partial)).toBe(false);

    const running = toolResult("running");
    running.meta["toolExecState"] = "running";
    expect(shouldPersistEntry(running)).toBe(false);

    const notStarted = toolResult("not started");
    notStarted.meta["toolExecState"] = "not_started";
    expect(shouldPersistEntry(notStarted)).toBe(false);
  });

  it("completed / failed 的工具结果写", () => {
    const completed = toolResult("done");
    completed.meta["toolExecState"] = "completed";
    expect(shouldPersistEntry(completed)).toBe(true);

    const failed = toolResult("failed");
    failed.meta["toolExecState"] = "failed";
    expect(shouldPersistEntry(failed)).toBe(true);
  });
});

describe("capPersistedEntry：64 KiB 工具输出", () => {
  it("恰好 64 KiB 不改写", () => {
    const content = "x".repeat(PERSISTED_TOOL_OUTPUT_MAX_BYTES);
    const entry = toolResult(content);
    const capped = capPersistedEntry(entry, { sessionDir: makeDir() });

    expect(capped).not.toBe(entry);
    expect((capped.content as { content: string }).content).toBe(content);
    expect(entry.content).toEqual({ toolCallId: "call-1", toolName: "bash", content, toolSummary: "summary" });
  });

  it("超过 64 KiB：日志只留截断文本与续读指针，全文落到 artifacts", () => {
    const sessionDir = makeDir();
    const content = `HEAD\n${"y".repeat(PERSISTED_TOOL_OUTPUT_MAX_BYTES)}\nTAIL-MARKER`;
    const entry = toolResult(content);
    const capped = capPersistedEntry(entry, { sessionDir });

    const cappedContent = (capped.content as { content: string }).content;
    expect(cappedContent.length).toBeLessThanOrEqual(PERSISTED_TOOL_OUTPUT_MAX_BYTES + 512);
    expect(cappedContent).toContain("truncated");
    expect(cappedContent).not.toContain("TAIL-MARKER");

    const outputPath = capped.meta["persistedOutputPath"] as string;
    expect(typeof outputPath).toBe("string");
    const absolute = join(sessionDir, outputPath);
    expect(existsSync(absolute)).toBe(true);
    expect(readFileSync(absolute, "utf-8")).toBe(content);

    // 入参不被修改
    expect((entry.content as { content: string }).content).toBe(content);
    expect(entry.meta["persistedOutputPath"]).toBeUndefined();
  });

  it("多模态图片：_contentBlocks 改 image_ref，原 base64 不留在日志", () => {
    const sessionDir = makeDir();
    const base64 = Buffer.from("fake-png-bytes").toString("base64");
    const entry = toolResult("see image", {
      _contentBlocks: [
        { type: "text", text: "caption" },
        { type: "image", media_type: "image/png", data: base64 },
      ],
    });

    const capped = capPersistedEntry(entry, { sessionDir });
    const blocks = (capped.meta["toolMetadata"] as Record<string, unknown>)["_contentBlocks"] as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: "text", text: "caption" });
    expect(blocks[1]).toMatchObject({ type: "image_ref", media_type: "image/png" });
    expect(typeof blocks[1]["path"]).toBe("string");
    expect(JSON.stringify(capped)).not.toContain(base64);

    const imagePath = join(sessionDir, blocks[1]["path"] as string);
    expect(existsSync(imagePath)).toBe(true);
    expect(readFileSync(imagePath).toString("base64")).toBe(base64);
  });
});

describe("迁移 log.json → log.jsonl", () => {
  function seedLegacySession(): { dir: string; title: string } {
    const home = makeDir("swarmflow-jsonl-migrate-");
    const dir = join(home, "session");
    mkdirSync(dir, { recursive: true });
    const title = "Legacy session";
    saveLog(
      dir,
      createLogSessionMeta({
        createdAt: "2026-03-01T10:00:00Z",
        turnCount: 1,
        summary: "summary",
        title,
        modelConfigName: "test-model",
        sessionId: "s-legacy",
      }),
      [
        createSystemPrompt("sys-1", 0, "system"),
        createTurnStart("ts-1", 1),
        createUserMessage("user-1", 1, "hi", "hi", { contextId: "c1" }),
        createAssistantText("asst-1", 1, 0, "hello", "hello"),
      ],
    );
    return { dir, title };
  }

  it("一次性迁移：header + 每条 entry 一条 upsert；备份旧文件；重放等价", () => {
    const { dir, title } = seedLegacySession();
    const legacyFile = join(dir, "log.json");
    const expected = loadLegacyLog(dir);

    const result = migrateLogToJsonl(dir);
    expect(result.migrated).toBe(true);
    expect(result.backupPath).toBe(join(dir, "log.json" + LOG_JSONL_BACKUP_SUFFIX));

    expect(existsSync(join(dir, LOG_JSONL_FILENAME))).toBe(true);
    expect(existsSync(legacyFile)).toBe(false);
    expect(existsSync(result.backupPath!)).toBe(true);

    const header = readLogHeader(dir);
    expect(header.sessionId).toBe("s-legacy");
    expect(header.title).toBe(title);

    const loaded = loadLogJsonl(dir);
    expect(loaded.meta.title).toBe(expected.meta.title);
    expect(loaded.meta.turnCount).toBe(expected.meta.turnCount);
    expect(loaded.entries).toEqual(expected.entries);

    const records = readRecords(dir).records;
    expect(records[0]?.op).toBe("session");
    expect(records.filter((record) => record.op === "upsert")).toHaveLength(expected.entries.length);
  });

  it("重复调用是空操作", () => {
    const { dir } = seedLegacySession();
    expect(migrateLogToJsonl(dir).migrated).toBe(true);
    const before = readFileSync(join(dir, LOG_JSONL_FILENAME));

    const second = migrateLogToJsonl(dir);
    expect(second.migrated).toBe(false);
    expect(readFileSync(join(dir, LOG_JSONL_FILENAME)).equals(before)).toBe(true);
  });

  it("旧文件损坏：抛错且不创建新文件、不改名旧文件", () => {
    // 正例先行：同一实现必须先能成功迁移一份合法旧日志。
    const good = seedLegacySession();
    expect(migrateLogToJsonl(good.dir).migrated).toBe(true);

    const home = makeDir("swarmflow-jsonl-migrate-bad-");
    const dir = join(home, "session");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "log.json"), "{ broken", "utf-8");

    expect(() => migrateLogToJsonl(dir)).toThrow();
    expect(existsSync(join(dir, LOG_JSONL_FILENAME))).toBe(false);
    expect(existsSync(join(dir, "log.json"))).toBe(true);
    expect(readFileSync(join(dir, "log.json"), "utf-8")).toBe("{ broken");
  });

  it("fork 时 meta.json 缺失：从 header 重建完整元数据", () => {
    const { dir } = seedLegacySession();
    migrateLogToJsonl(dir);
    rmSync(join(dir, "meta.json"));
    expect(readLogHeader(dir).turnCount).toBe(1);

    const forked = forkSessionDirectory(dir);
    const meta = JSON.parse(readFileSync(join(forked.sessionDir, "meta.json"), "utf-8"));
    expect(meta.session_id).toBe(forked.sessionId);
    expect(meta.turn_count).toBe(1);
    expect(meta.summary).toBe("summary");
    expect(meta.model_config_name).toBe("test-model");
  });

  it("fork 出来的旧会话也能独立迁移，父会话不受影响", () => {
    const { dir: parent } = seedLegacySession();
    const forked = forkSessionDirectory(parent);

    expect(migrateLogToJsonl(forked.sessionDir).migrated).toBe(true);
    expect(existsSync(join(forked.sessionDir, LOG_JSONL_FILENAME))).toBe(true);
    expect(existsSync(join(parent, "log.json"))).toBe(true);
    expect(existsSync(join(parent, LOG_JSONL_FILENAME))).toBe(false);
  });
});
