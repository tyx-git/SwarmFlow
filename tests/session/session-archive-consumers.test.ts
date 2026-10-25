/**
 * 红测：全量 meta 归档后，两个消费方仍必须工作。
 *
 * 已确认的目标形态（用户选择）：压缩归档把 display + meta 全部搬进
 * archive/window-<n>.json.gz，内存条目只剩枚举字段。随之而来的契约：
 *   1. 只看文件的 rewind 仍能拿到 meta.toolMetadata.fileMutation
 *      （现状从内存 meta 读取：src/session/rewind/engine.ts:397-409）；
 *   2. turn 列表仍能从归档恢复 turnKind/preview
 *      （现状从内存 meta/display 读取：src/session/log.ts:231-239）。
 *
 * 实现前本文件应失败：归档内容会被测试手工写成"未来格式"
 * （带 display/meta），随后把内存条目清空，模拟归档后的真实状态。
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPatch } from "diff";

import { writeArchiveEnvelopeForMigration } from "../../src/config/archive.js";

import { ToolResult } from "../../src/providers/response.js";
import type { LogEntry } from "../../src/context/entry/types.js";
import { makeScriptedSession, testToolDef, type SessionHarness } from "../helpers/session-harness.js";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function writeFutureArchiveAndStrip(
  sessionDir: string,
  entries: LogEntry[],
  fileName = "window-cp-0.jsonl.gz",
): void {
  mkdirSync(join(sessionDir, "archive"), { recursive: true });
  const payload = entries.map((entry) => ({
    id: entry.id,
    content: entry.content,
    display: entry.display,
    meta: entry.meta,
  }));

  const turns = entries
    .filter((entry) => entry.type === "input_received" || entry.type === "turn_start")
    .map((entry) => {
      const meta = entry.meta as Record<string, unknown>;
      const rawKind = entry.type === "input_received" ? meta["inputKind"] : meta["turnKind"];
      const preview = entry.type === "input_received"
        ? String(entry.display).replace(/\s+/g, " ").trim().slice(0, 240)
        : "";
      return {
        id: entry.id,
        type: entry.type,
        turnIndex: entry.turnIndex,
        ...(typeof rawKind === "string" ? { turnKind: rawKind } : {}),
        ...(preview ? { preview } : {}),
      };
    });
  const mutations = entries.flatMap((entry) => {
    if (entry.type !== "tool_result") return [];
    const meta = entry.meta as Record<string, unknown>;
    const toolMeta = meta["toolMetadata"] as Record<string, unknown> | undefined;
    const fm = toolMeta?.["fileMutation"] as { path?: unknown; additions?: unknown; deletions?: unknown } | undefined;
    if (!fm || typeof fm.path !== "string") return [];
    return [{
      id: entry.id,
      turnIndex: entry.turnIndex,
      path: fm.path,
      additions: typeof fm.additions === "number" ? fm.additions : 0,
      deletions: typeof fm.deletions === "number" ? fm.deletions : 0,
    }];
  });
  const checkpointId = fileName.replace(/^window-/, "").replace(/\.jsonl\.gz$/, "");
  writeArchiveEnvelopeForMigration(sessionDir, checkpointId, fileName, payload, {
    turns,
    mutations,
    entryIds: payload.map((entry) => entry.id),
  });

  for (const entry of entries) {
    entry.content = null;
    entry.display = "";
    entry.meta = {};
    entry.archived = true;
  }
}

describe("归档后的 rewind 与 turn 列表", () => {
  it("file-only rewind 仍能从归档拿到 fileMutation.reversePatch", async () => {
    let h: SessionHarness;
    let expectedPatch = "";
    let mutatedPath = "";

    h = makeScriptedSession({
      rounds: [
        { toolCalls: [{ id: "call-1", name: "probe_write", arguments: {} }] },
        { text: "done" },
      ],
      toolExecutorOverrides: {
        probe_write: () => {
          const filePath = join(h.projectRoot, "probe.txt");
          const before = "one\ntwo\nthree\n";
          const after = "one\nTWO\nthree\n";
          writeFileSync(filePath, after, "utf-8");
          const reversePatch = createPatch(filePath, after, before);
          expectedPatch = reversePatch;
          mutatedPath = filePath;
          return new ToolResult({
            content: "OK: edited probe.txt",
            metadata: {
              fileMutation: {
                path: filePath,
                kind: "modified",
                reversePatch,
                postImageSha: sha256(after),
                additions: 1,
                deletions: 1,
              },
            },
          });
        },
      },
    });
    h.session.permissionMode = "yolo";

    try {
      await h.session.turn("edit probe.txt");

      const log = h.session.log as LogEntry[];
      const resultEntry = log.find(
        (entry) => entry.type === "tool_result"
          && !entry.discarded
          && entry.meta["toolCallId"] === "call-1",
      );
      expect(resultEntry, "工具结果条目缺失").toBeDefined();
      expect(expectedPatch.length).toBeGreaterThan(0);

      const sessionDir = h.internals._store.sessionDir as string;
      writeFutureArchiveAndStrip(sessionDir, [resultEntry!]);

      const plan = await h.session.planRewind(1);
      const applied = plan.applicable.find((item) => item.path === mutatedPath);
      expect(applied, "归档后 rewind 计划里丢失了该文件（应改为从归档读取 fileMutation）").toBeDefined();
      expect(applied!.mutations[0]!.reversePatch).toBe(expectedPatch);

      // 回退菜单只读轻量 mutation 摘要：不加载 reversePatch 也要能统计。
      const target = h.session.getRewindTargets().find((turn) => turn.turnIndex === 1);
      expect(target?.fileCount).toBe(1);
      expect(target?.additions).toBe(1);
      expect(target?.deletions).toBe(1);
    } finally {
      h.dispose();
    }
  });

  it("externalizes tool result images before appending and resolves them for the next request", async () => {
    const base64 = Buffer.from("tool-result-image").toString("base64");
    const h = makeScriptedSession({
      tools: [testToolDef("image_tool")],
      rounds: [
        { toolCalls: [{ id: "call-image", name: "image_tool", arguments: {} }] },
        { text: "done" },
      ],
      toolExecutorOverrides: {
        image_tool: () => new ToolResult({
          content: "image attached",
          contentBlocks: [
            { type: "text", text: "caption" },
            { type: "image", media_type: "image/png", data: base64 },
          ],
        }),
      },
    });
    h.session.permissionMode = "yolo";

    try {
      await h.session.turn("inspect the tool result");

      const resultEntry = (h.session.log as LogEntry[]).find(
        (entry) => entry.type === "tool_result" && entry.meta["toolCallId"] === "call-image",
      );
      expect(resultEntry).toBeDefined();
      const metadata = resultEntry!.meta["toolMetadata"] as Record<string, unknown>;
      const blocks = metadata["_contentBlocks"] as Array<Record<string, unknown>>;
      expect(blocks[1]).toMatchObject({ type: "image_ref", media_type: "image/png" });
      expect(JSON.stringify(resultEntry)).not.toContain(base64);

      const sessionDir = h.internals._store.sessionDir as string;
      const imagePath = join(sessionDir, blocks[1]!["path"] as string);
      expect(existsSync(imagePath)).toBe(true);
      expect(readFileSync(imagePath).toString("base64")).toBe(base64);

      const toolMessage = h.provider.calls[1]?.find((message) => message["role"] === "tool_result");
      expect(toolMessage?.["content"]).toEqual([
        { type: "text", text: "caption" },
        { type: "image", media_type: "image/png", data: base64 },
      ]);
    } finally {
      h.dispose();
    }
  });

  it("listTurns 仍能给出归档条目的 turnKind/preview", async () => {
    const h = makeScriptedSession({ rounds: [{ text: "reply one" }] });
    try {
      await h.session.turn("第一次输入");
      const log = h.session.log as LogEntry[];
      const inputEntry = log.find(
        (entry) => entry.type === "input_received" && !entry.discarded,
      );
      expect(inputEntry, "input_received 条目缺失").toBeDefined();

      const originalPreview = String(inputEntry!.display).replace(/\s+/g, " ").trim().slice(0, 240);
      expect(originalPreview.length).toBeGreaterThan(0);

      const sessionDir = h.internals._store.sessionDir as string;
      writeFutureArchiveAndStrip(sessionDir, [inputEntry!]);

      const turns = h.session.listTurns();
      const restored = turns.find(
        (turn) => turn.turnIndex === 1 && turn.preview === originalPreview,
      );
      expect(restored, "归档后 turn 列表丢失了 preview（应改为从归档恢复 turnKind/display）").toBeDefined();
      expect(restored!.turnKind).toBe("user");
    } finally {
      h.dispose();
    }
  });
});
