/**
 * 工具裸块载荷：把 assistant 正文里的标记块按顺序绑定给零参数工具调用。
 *
 * 通用逻辑（抽块、按工具分组顺序绑定、展示隐藏、日志回取）集中在这里，`edit`、
 * `present_plan` 与 `memory` 共用；再接长文本工具只需往 `PAYLOAD_BLOCK_SPECS` 加一条 spec。
 * 补丁标记常量与行尾归一沿用 `patches/apply-patch/markers.js` 那一份唯一实现
 * （该模块无入站依赖，不会形成环），本文件不复制第二份。
 */

import type { LogEntry } from "../context/entry/types.js";
import {
  BEGIN_PATCH_MARKER,
  END_PATCH_MARKER,
  normalizeBlockLineEndings,
} from "../patches/apply-patch/markers.js";

/** `present_plan` 的计划块标记（`edit` 的标记属于 apply-patch 端口）。 */
export const BEGIN_PLAN_MARKER = "*** Begin Plan";
export const END_PLAN_MARKER = "*** End Plan";

/** `memory` 的全局记忆块标记：正文是整份 MEMORY.md，不是补丁。 */
export const BEGIN_MEMORY_MARKER = "*** Begin Memory";
export const END_MEMORY_MARKER = "*** End Memory";

/** 一个裸块工具：工具名 + 它的标记对。 */
export interface PayloadBlockSpec {
  tool: string;
  begin: string;
  end: string;
}

/** 各裸块工具的 spec；注册表由它们组成，顺序只影响遍历起点，绑定按工具各自计数。 */
export const EDIT_PAYLOAD_SPEC: PayloadBlockSpec = {
  tool: "edit",
  begin: BEGIN_PATCH_MARKER,
  end: END_PATCH_MARKER,
};

export const PLAN_PAYLOAD_SPEC: PayloadBlockSpec = {
  tool: "present_plan",
  begin: BEGIN_PLAN_MARKER,
  end: END_PLAN_MARKER,
};

export const MEMORY_PAYLOAD_SPEC: PayloadBlockSpec = {
  tool: "memory",
  begin: BEGIN_MEMORY_MARKER,
  end: END_MEMORY_MARKER,
};

export const PAYLOAD_BLOCK_SPECS: readonly PayloadBlockSpec[] = [
  EDIT_PAYLOAD_SPEC,
  PLAN_PAYLOAD_SPEC,
  MEMORY_PAYLOAD_SPEC,
];

/** 按工具名取 spec；不是裸块工具时返回 null。 */
export function findPayloadSpec(toolName: unknown): PayloadBlockSpec | null {
  if (typeof toolName !== "string") return null;
  return PAYLOAD_BLOCK_SPECS.find((spec) => spec.tool === toolName) ?? null;
}

export interface PayloadBlock {
  spec: PayloadBlockSpec;
  /** 0-based，包含 begin 行 */
  startLine: number;
  /** 0-based，包含 end 行；未闭合时等于最后一行 */
  endLine: number;
  text: string;
  complete: boolean;
}

/**
 * 单遍扫描抽取所有标记块。两条规则决定行为：
 * - 外层优先：进入一个块后，区间内出现的任何 begin（含别的工具的标记）都算正文；
 * - 未闭合块标 `complete: false` 并停止扫描（流式正文后半段还不可信）。
 */
export function findPayloadBlocks(
  text: string,
  specs: readonly PayloadBlockSpec[] = PAYLOAD_BLOCK_SPECS,
): PayloadBlock[] {
  const lines = normalizeBlockLineEndings(text).split("\n");
  const blocks: PayloadBlock[] = [];

  for (let index = 0; index < lines.length; index++) {
    const spec = specs.find((candidate) => lines[index]!.trim() === candidate.begin);
    if (!spec) continue;

    let end = -1;
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      if (lines[cursor]!.trim() === spec.end) {
        end = cursor;
        break;
      }
    }
    if (end === -1) {
      blocks.push({
        spec,
        startLine: index,
        endLine: lines.length - 1,
        text: lines.slice(index).join("\n"),
        complete: false,
      });
      break;
    }
    blocks.push({
      spec,
      startLine: index,
      endLine: end,
      text: lines.slice(index, end + 1).join("\n"),
      complete: true,
    });
    // 跳到区间末尾：区间内的一切标记都归本块正文。
    index = end;
  }

  return blocks;
}

/** 取某个 spec 的已闭合块正文，按出现顺序。 */
export function extractCompletePayloadBlocks(
  text: string,
  spec: PayloadBlockSpec,
): string[] {
  return findPayloadBlocks(text)
    .filter((block) => block.complete && block.spec === spec)
    .map((block) => block.text);
}

/**
 * 取块的正文：去掉首尾标记行并修剪多余空白，供渲染与落盘使用。
 * 载荷本身保持原样，这里只产出"给用户看的那段"。
 */
export function payloadBlockBody(blockText: string): string {
  const lines = normalizeBlockLineEndings(blockText).split("\n");
  if (lines.length > 1 && PAYLOAD_BLOCK_SPECS.some((spec) => lines[0]!.trim() === spec.begin)) {
    lines.shift();
  }
  const last = lines.length - 1;
  if (last >= 0 && PAYLOAD_BLOCK_SPECS.some((spec) => lines[last]!.trim() === spec.end)) {
    lines.pop();
  }
  return lines.join("\n").trim();
}

function isFenceLine(line: string | undefined): boolean {
  const trimmed = line?.trim() ?? "";
  return trimmed.startsWith("```") || trimmed.startsWith("~~~");
}

/**
 * 只改展示文本：移除给定的行区间。调用方负责决定哪些块该隐藏
 * （例如仅在同一轮存在对应工具调用时）。
 */
export function removePayloadBlocks(
  text: string,
  blocks: readonly PayloadBlock[],
): string {
  if (blocks.length === 0) return text;
  const lines = normalizeBlockLineEndings(text).split("\n");
  const hidden = new Set<number>();
  for (const block of blocks) {
    for (let index = block.startLine; index <= block.endLine; index++) {
      hidden.add(index);
    }
    // 模型常把正文包在代码围栏里；围栏本身也属于载荷展示，不要留下空壳。
    if (block.startLine > 0 && isFenceLine(lines[block.startLine - 1])) {
      hidden.add(block.startLine - 1);
    }
    if (block.endLine + 1 < lines.length && isFenceLine(lines[block.endLine + 1])) {
      hidden.add(block.endLine + 1);
    }
  }
  return lines.filter((_, index) => !hidden.has(index)).join("\n");
}

export interface RoundToolCall {
  id: string;
  name: string;
}

/**
 * 按出现顺序把完整块分配给对应工具的调用，逐 spec 独立计数。
 * 块不足时，后面的调用得不到载荷，由执行器返回明确错误。
 */
export function resolveRoundPayloads(
  calls: readonly RoundToolCall[],
  roundText: string,
  specs: readonly PayloadBlockSpec[] = PAYLOAD_BLOCK_SPECS,
): Map<string, string> {
  const blocks = findPayloadBlocks(roundText, specs);
  const payloads = new Map<string, string>();
  for (const spec of specs) {
    const specCalls = calls.filter((call) => call.name === spec.tool);
    const specBlocks = blocks
      .filter((block) => block.complete && block.spec === spec)
      .map((block) => block.text);
    const count = Math.min(specCalls.length, specBlocks.length);
    for (let index = 0; index < count; index++) {
      payloads.set(specCalls[index]!.id, specBlocks[index]!);
    }
  }
  return payloads;
}

/**
 * ask 恢复/drain 的兜底：tool_call 没有 executionPayload 时，
 * 使用同 turn/round 的 assistant 文本重新抽块。
 */
export function resolvePayloadFromToolCallLog(
  entries: readonly LogEntry[],
  toolCallEntry: LogEntry,
  specs: readonly PayloadBlockSpec[] = PAYLOAD_BLOCK_SPECS,
): string | null {
  const spec = findPayloadSpec((toolCallEntry.content as { name?: unknown } | null)?.name);
  if (!spec) return null;

  const sameRound = entries.filter((entry) => (
    entry.turnIndex === toolCallEntry.turnIndex
    && entry.roundIndex === toolCallEntry.roundIndex
    && entry.discarded !== true
  ));

  const text = sameRound
    .filter((entry) => entry.type === "assistant_text" && typeof entry.content === "string")
    .map((entry) => entry.content as string)
    .join("");
  const blocks = findPayloadBlocks(text, specs)
    .filter((block) => block.complete && block.spec === spec)
    .map((block) => block.text);
  if (blocks.length === 0) return null;

  const specCalls = sameRound.filter((entry) => {
    if (entry.type !== "tool_call") return false;
    return (entry.content as { name?: unknown } | null)?.name === spec.tool;
  });
  const ordinal = specCalls.findIndex((entry) => entry.id === toolCallEntry.id);
  if (ordinal >= 0 && blocks[ordinal]) return blocks[ordinal]!;
  return blocks.length === 1 ? blocks[0]! : null;
}
