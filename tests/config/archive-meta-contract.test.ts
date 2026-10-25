/**
 * 红测：压缩归档必须把 display 与 meta 一起搬进 .json.gz。
 *
 * 现状（src/config/archive.ts:42-50）：归档 payload 只有 {id, content}，
 * 内存里也只清 content。于是 display（assistant_text/reasoning 与 content
 * 是两份独立字符串）、reasoningState/thinkingArtifact、toolStreamSections、
 * fileModifyData.writeLines、toolMetadata（tui_preview / fileMutation /
 * _contentBlocks）在压缩后仍常驻。
 *
 * 目标契约（已与用户确认）：全量 meta 入归档。
 *   1. 窗口关闭时：归档文件写入 content/display/meta，内存只把 content 置空
 *      （最近 3 个窗口 TUI 仍要渲染 display）；
 *   2. 窗口滑出 TUI 折叠边界后：stripArchivedPresentation 清掉 display/meta
 *      （保留 contextId/providerRoundId 两个身份键）；
 *   3. restoreArchiveToEntries 把 content、display、meta 一并恢复。
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  archiveWindow,
  loadArchive,
  restoreArchiveToEntries,
  stripArchivedPresentation,
} from "../../src/config/archive.js";
import { computeCompactFoldBoundary } from "../../src/context/projection/tui.js";
import { SessionLog } from "../../src/session/log.js";
import {
  createAssistantText,
  createCompactMarker,
  createReasoning,
  createToolCall,
  createToolResult,
  createUserMessage,
} from "../../src/context/entry/factories.js";
import type { LogEntry } from "../../src/context/entry/types.js";

let testDir = "";

beforeEach(() => {
  testDir = join(tmpdir(), `archive-meta-${randomUUID().slice(0, 8)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 构造覆盖所有已知大字段的日志窗口。 */
function makeHeavyWindow(): LogEntry[] {
  const thinking = "思考过程".repeat(1024);
  const writeContent = "line content\n".repeat(2000);
  const writeLines = writeContent.split("\n");

  const user = createUserMessage("u-1", 1, "写个大文件", "写个大文件", "ctx-1");
  const assistant = createAssistantText("a-1", 1, 0, thinking, thinking, "ctx-1");
  const reasoning = createReasoning(
    "r-1",
    1,
    0,
    thinking,
    thinking,
    { state: thinking },
    "ctx-1",
  );
  reasoning.meta["thinkingArtifact"] = { blocks: [{ type: "thinking", text: thinking }] };

  const toolCall = createToolCall(
    "tc-1",
    1,
    0,
    "write_file: /p/a.txt",
    {
      id: "call-1",
      name: "write_file",
      arguments: { path: "/p/a.txt", content: writeContent },
      rawArguments: JSON.stringify({ path: "/p/a.txt", content: writeContent }),
    },
    { toolCallId: "call-1", toolName: "write_file", agentName: "Primary", contextId: "ctx-1" },
  );
  toolCall.meta["toolStreamSections"] = [{ key: "content", text: writeContent }];
  toolCall.meta["fileModifyData"] = {
    filePath: "/p/a.txt",
    language: "text",
    mode: "write",
    totalLineCount: writeLines.length,
    hunks: [],
    writeLines,
  };

  const toolResult = createToolResult(
    "tr-1",
    1,
    0,
    { toolCallId: "call-1", toolName: "write_file", content: "OK: wrote /p/a.txt", toolSummary: "wrote file" },
    {
      isError: false,
      contextId: "ctx-1",
      toolMetadata: {
        tui_preview: { kind: "diff", text: `--- a\n+++ b\n${writeContent}`, truncated: false },
        fileModifyData: {
          filePath: "/p/a.txt",
          language: "text",
          mode: "write",
          totalLineCount: writeLines.length,
          hunks: [],
          writeLines,
        },
        fileMutation: {
          path: "/p/a.txt",
          kind: "created",
          reversePatch: `--- a\n+++ b\n@@ -1,${writeLines.length} +0,0 @@\n${writeContent}`,
          postImageSha: "sha-post",
          additions: 0,
          deletions: writeLines.length,
        },
        _contentBlocks: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(4096) } },
        ],
      },
    },
  );
  toolResult.meta["fileMutationReverted"] = true;

  return [user, assistant, reasoning, toolCall, toolResult];
}

describe("archiveWindow：display + meta 随内容一起归档", () => {
  it("只写归档文件，内存变更由网关 archiveEntries 记录", () => {
    const entries = makeHeavyWindow();
    const ids = archiveWindow(testDir, 0, entries, 0, 4);

    expect(ids).toHaveLength(5);
    for (const entry of entries.slice(0, 5)) {
      expect(entry.content).not.toBeNull();
      expect(entry.archived).toBe(false);
    }

    const gateway = new SessionLog();
    gateway.replace(entries);
    gateway.archiveEntries(ids);
    for (const entry of entries.slice(0, 5)) {
      expect(entry.content).toBeNull();
      expect(entry.archived).toBe(true);
    }
  });

  it("归档文件携带 display/meta，滑出折叠边界后清空，restore 后完整还原", () => {
    const entries = makeHeavyWindow();
    const outside = createAssistantText("a-outside", 2, 0, "still here", "still here");
    entries.push(outside);

    const originals = new Map(
      entries.slice(0, 5).map((entry) => [
        entry.id,
        clone({ content: entry.content, display: entry.display, meta: entry.meta }),
      ]),
    );

    const ids = archiveWindow(testDir, 0, entries, 0, 4);
    const gateway = new SessionLog();
    gateway.replace(entries);
    gateway.archiveEntries(ids);
    const archived = loadArchive(testDir, 0);
    const byId = new Map(archived.map((record) => [record.id, record]));

    // 归档文件必须带 display 与 meta（当前只有 id/content）。
    for (const [id, original] of originals) {
      const record = byId.get(id);
      expect(record, `归档记录缺失: ${id}`).toBeDefined();
      expect(record!.display).toEqual(original.display);
      expect(record!.meta).toEqual(original.meta);
    }

    // 窗口刚关闭时只清 content：最近窗口 TUI 仍要渲染 display/meta。
    for (const entry of entries.slice(0, 5)) {
      expect(entry.content).toBeNull();
      expect(entry.archived).toBe(true);
      const original = originals.get(entry.id)!;
      expect(entry.display).toEqual(original.display);
      expect(entry.meta).toEqual(original.meta);
    }

    // 滑出折叠边界后清 presentation，只保留身份键。
    stripArchivedPresentation(entries, 4);
    for (const entry of entries.slice(0, 5)) {
      expect(entry.display).toBe("");
      expect(entry.meta["contextId"]).toBe("ctx-1");
      for (const heavy of [
        "reasoningState",
        "thinkingArtifact",
        "toolStreamSections",
        "fileModifyData",
        "toolMetadata",
      ]) {
        expect(entry.meta[heavy], `未清理的大字段: ${heavy}`).toBeUndefined();
      }
    }
    // 回退标记必须保留，否则旧 mutation 会在下一次计划里重新出现。
    expect(entries[4]!.meta["fileMutationReverted"]).toBe(true);

    // 范围外的条目不受影响。
    expect(outside.content).toBe("still here");
    expect(outside.display).toBe("still here");
    expect(outside.archived).toBe(false);

    // restore 必须一并还原 display/meta，而不是只还原 content。
    restoreArchiveToEntries(entries, archived);
    for (const [id, original] of originals) {
      const entry = entries.find((item) => item.id === id)!;
      expect(entry.content).toEqual(original.content);
      expect(entry.display).toEqual(original.display);
      expect(entry.meta).toEqual(original.meta);
      expect(entry.archived).toBe(false);
    }
  });

  it("只清理 TUI 折叠边界之前的已归档条目（与 projectToTuiEntries 同一阈值）", () => {
    const marker = (i: number) => createCompactMarker(`cm-${i}`, i + 1, i, 100, 20);
    const archivedEntry = (id: string, turn: number): LogEntry => {
      const entry = createAssistantText(id, turn, 0, "text", "text");
      entry.content = null;
      entry.archived = true;
      return entry;
    };
    const log: LogEntry[] = [
      marker(0), archivedEntry("e-1", 1),
      marker(1), archivedEntry("e-2", 2),
      marker(2), archivedEntry("e-3", 3),
      marker(3), archivedEntry("e-4", 4),
    ];

    const { foldEndIdx } = computeCompactFoldBoundary(log);
    expect(foldEndIdx).toBe(2); // 4 个标记、阈值 3 → 折叠到第 2 个标记（索引 2）

    stripArchivedPresentation(log, foldEndIdx);
    expect(log[1]!.display).toBe(""); // e-1 在折叠区内
    expect(log[3]!.display).toBe("text"); // e-2/e-3/e-4 仍会被 TUI 渲染
    expect(log[5]!.display).toBe("text");
    expect(log[7]!.display).toBe("text");
  });
});
