/**
 * 红测：log.json 必须落盘为无缩进 JSON。
 *
 * 现状：saveLog 内部是 JSON.stringify(payload, null, 2)
 * （src/config/log-serialization.ts:111）。缩进只服务人眼，却按整份日志
 * 放大落盘体积与 stringify 的瞬时堆峰值。期望：紧凑 JSON，语义不变。
 * 实现前本文件应失败（红在"存在 \n  + 两个空格缩进且不等于紧凑形态"）。
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { saveLog } from "../../src/config/log-serialization.js";
import { createLogSessionMeta } from "../../src/config/session-meta.js";
import { createAssistantText, createUserMessage } from "../../src/context/entry/factories.js";

let testDir = "";

beforeEach(() => {
  testDir = join(tmpdir(), `log-compact-${randomUUID().slice(0, 8)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function sampleMeta() {
  return createLogSessionMeta({
    projectPath: "/test/project",
    modelConfigName: "test-model",
    modelProvider: "openai",
    modelSelectionKey: "gpt-test",
    modelId: "gpt-test",
    summary: "Test session",
    turnCount: 1,
    thinkingLevel: "default",
  });
}

describe("saveLog 落盘形态", () => {
  it("写入紧凑 JSON：没有缩进空白，且与 JSON.parse→stringify 的结果逐字节一致", () => {
    const entries = [
      createUserMessage("user-1", 1, "hello", "hello", "ctx-1"),
      createAssistantText("asst-1", 1, 0, "hi", "hi"),
    ];
    saveLog(testDir, sampleMeta(), entries);

    const raw = readFileSync(join(testDir, "log.json"), "utf-8");

    // 红点 1：当前实现每行都有两空格缩进。
    expect(raw.includes("\n  ")).toBe(false);
    // 红点 2：紧凑形态下文件内容应等于"解析后再序列化"的结果。
    expect(raw).toBe(JSON.stringify(JSON.parse(raw)));

    // 防空洞通过：语义必须完整保留。
    const parsed = JSON.parse(raw) as {
      entries: Array<{ display: string; type: string }>;
    };
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]!.type).toBe("user_message");
    expect(parsed.entries[1]!.display).toBe("hi");
  });
});
