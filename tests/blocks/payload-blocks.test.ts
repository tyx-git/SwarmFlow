/**
 * 通用裸块层的多工具行为：期望值来自"每个工具只看自己的块、外层块优先、
 * 未闭合不参与绑定"这条契约，不来自实现。edit 单工具语义由 patch-payload 测试守着。
 */

import { describe, expect, it } from "vitest";

import {
  EDIT_PAYLOAD_SPEC,
  MEMORY_PAYLOAD_SPEC,
  PLAN_PAYLOAD_SPEC,
  extractCompletePayloadBlocks,
  findPayloadBlocks,
  findPayloadSpec,
  removePayloadBlocks,
  resolvePayloadFromToolCallLog,
  resolveRoundPayloads,
} from "../../src/blocks/payload-blocks.js";
import {
  createAssistantText,
  createToolCall,
} from "../../src/context/entry/factories.js";
import type { LogEntry } from "../../src/context/entry/types.js";

const PATCH_A = "*** Begin Patch\n*** Add File: a.txt\n+alpha\n*** End Patch";
const PATCH_B = "*** Begin Patch\n*** Add File: b.txt\n+beta\n*** End Patch";
const PLAN_1 = "*** Begin Plan\n# 计划\n- [ ] 步骤\n*** End Plan";
const MEMORY_1 = "*** Begin Memory\n- git提交信息需单行中文，无空格，精简概括\n*** End Memory";

function toolCall(id: string, callId: string, name: string, roundIndex = 0): LogEntry {
  return createToolCall(
    id,
    1,
    roundIndex,
    name,
    { id: callId, name, arguments: {} },
    { toolCallId: callId, toolName: name, agentName: "Primary", contextId: "ctx" },
    "assistant",
  );
}

describe("findPayloadSpec", () => {
  it("只认注册过的裸块工具", () => {
    expect(findPayloadSpec("edit")).toBe(EDIT_PAYLOAD_SPEC);
    expect(findPayloadSpec("present_plan")).toBe(PLAN_PAYLOAD_SPEC);
    expect(findPayloadSpec("memory")).toBe(MEMORY_PAYLOAD_SPEC);
    expect(findPayloadSpec("read_file")).toBeNull();
    expect(findPayloadSpec(undefined)).toBeNull();
  });
});

describe("memory 块", () => {
  it("记忆块里的补丁标记只算正文，不会漏给同轮的 edit 调用", () => {
    const text = [
      "先记下规则：",
      "*** Begin Memory",
      "- 补丁示例长这样：",
      PATCH_A,
      "*** End Memory",
    ].join("\n");

    const payloads = resolveRoundPayloads(
      [
        { id: "memory-1", name: "memory" },
        { id: "edit-1", name: "edit" },
      ],
      text,
    );

    expect(payloads.get("memory-1")).toContain("*** Begin Patch");
    expect(payloads.has("edit-1")).toBe(false);
  });

  it("三种裸块在同一轮里各自按发射顺序绑定", () => {
    const text = [PLAN_1, MEMORY_1, PATCH_A].join("\n");
    const payloads = resolveRoundPayloads(
      [
        { id: "plan-1", name: "present_plan" },
        { id: "memory-1", name: "memory" },
        { id: "edit-1", name: "edit" },
      ],
      text,
    );

    expect(payloads.get("plan-1")).toBe(PLAN_1);
    expect(payloads.get("memory-1")).toBe(MEMORY_1);
    expect(payloads.get("edit-1")).toBe(PATCH_A);
  });

  it("展示层抽走记忆块并连带去掉包裹它的代码围栏", () => {
    const text = ["前", "```", MEMORY_1, "```", "后"].join("\n");
    const blocks = findPayloadBlocks(text, [MEMORY_PAYLOAD_SPEC]);

    expect(blocks).toHaveLength(1);
    expect(removePayloadBlocks(text, blocks)).toBe("前\n后");
  });

  it("未闭合的记忆块不参与绑定（流式正文还不可信）", () => {
    const text = "*** Begin Memory\n- 还没写完";
    expect(resolveRoundPayloads([{ id: "memory-1", name: "memory" }], text).size).toBe(0);
    expect(extractCompletePayloadBlocks(text, MEMORY_PAYLOAD_SPEC)).toEqual([]);
  });
});

describe("findPayloadBlocks 外层优先", () => {
  it("计划块内部的补丁标记算正文，不会被绑给 edit 调用", () => {
    const text = [
      "前言",
      "*** Begin Plan",
      "# 计划",
      "补丁长这样：",
      PATCH_A,
      "以上只是示例",
      "*** End Plan",
      "后记",
    ].join("\n");

    const payloads = resolveRoundPayloads(
      [
        { id: "plan-1", name: "present_plan" },
        { id: "edit-1", name: "edit" },
      ],
      text,
    );

    // 计划块拿到含内层标记的完整正文
    expect(payloads.get("plan-1")).toContain("补丁长这样：");
    expect(payloads.get("plan-1")).toContain("*** Begin Patch");
    // 内层 Begin Patch 没有独立成块，因此 edit 拿不到载荷
    expect(payloads.has("edit-1")).toBe(false);
    expect(extractCompletePayloadBlocks(text, EDIT_PAYLOAD_SPEC)).toEqual([]);
  });

  it("补丁块内部的计划标记同样算正文", () => {
    const text = [
      PATCH_A.replace("\n*** End Patch", "\n*** Begin Plan\nnested\n*** End Plan\n*** End Patch"),
    ].join("\n");

    const payloads = resolveRoundPayloads(
      [
        { id: "edit-1", name: "edit" },
        { id: "plan-1", name: "present_plan" },
      ],
      text,
    );

    expect(payloads.get("edit-1")).toContain("*** Begin Plan");
    expect(payloads.has("plan-1")).toBe(false);
  });
});

describe("resolveRoundPayloads 按 spec 独立计数", () => {
  it("同一轮里两个工具的块各自按发射顺序绑定", () => {
    const text = [PLAN_1, PATCH_A, "闲话", PATCH_B].join("\n");
    const payloads = resolveRoundPayloads(
      [
        { id: "plan-1", name: "present_plan" },
        { id: "edit-1", name: "edit" },
        { id: "other-1", name: "read_file" },
        { id: "edit-2", name: "edit" },
      ],
      text,
    );

    expect(payloads.get("plan-1")).toBe(PLAN_1);
    expect(payloads.get("edit-1")).toBe(PATCH_A);
    expect(payloads.get("edit-2")).toBe(PATCH_B);
    expect(payloads.has("other-1")).toBe(false);
  });

  it("整段没有结束标记时不参与绑定（流式未闭合语义）", () => {
    const text = "*** Begin Plan\n# 还没写完";
    expect(resolveRoundPayloads([{ id: "plan-1", name: "present_plan" }], text).size).toBe(0);
    expect(extractCompletePayloadBlocks(text, PLAN_PAYLOAD_SPEC)).toEqual([]);
  });

  it("块体在第一个结束标记处收尾，其间的同类 begin 归正文", () => {
    const withClosed = `*** Begin Plan\n# 还没写完\n${PLAN_1}`;
    const blocks = extractCompletePayloadBlocks(withClosed, PLAN_PAYLOAD_SPEC);
    // 只有一块，且第二个 begin 被算作第一块正文——与 edit 的补丁语义一致
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("# 还没写完");
    expect(blocks[0]).toContain("# 计划");
  });

  it("混合 CRLF 与孤立 CR 的正文仍能抽块（只有一份行尾归一实现）", () => {
    const crlfText = "*** Begin Plan\r\n# 计划\r\n*** End Plan";
    expect(extractCompletePayloadBlocks(crlfText, PLAN_PAYLOAD_SPEC)).toEqual([
      "*** Begin Plan\n# 计划\n*** End Plan",
    ]);

    const loneCrText = "*** Begin Plan\r# 计划\r*** End Plan";
    const blocks = extractCompletePayloadBlocks(loneCrText, PLAN_PAYLOAD_SPEC);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).not.toContain("\r");
  });
});

describe("removePayloadBlocks", () => {
  it("抽走计划块并连带去掉包裹它的代码围栏", () => {
    const text = ["前", "```", PLAN_1, "```", "后"].join("\n");
    const blocks = findPayloadBlocks(text, [PLAN_PAYLOAD_SPEC]);
    expect(blocks).toHaveLength(1);
    expect(removePayloadBlocks(text, blocks)).toBe("前\n后");
  });
});

describe("resolvePayloadFromToolCallLog", () => {
  it("非裸块工具的调用直接回 null，不再硬编码 edit", () => {
    const call = toolCall("tc-1", "call-1", "read_file");
    const log: LogEntry[] = [
      createAssistantText("text-1", 1, 0, PLAN_1, PLAN_1, "ctx"),
      call,
    ];
    expect(resolvePayloadFromToolCallLog(log, call)).toBeNull();
  });

  it("按工具名回取自己的块，多个同工具调用按序取", () => {
    const first = toolCall("tc-1", "call-1", "edit");
    const second = toolCall("tc-2", "call-2", "edit");
    const log: LogEntry[] = [
      createAssistantText("text-1", 1, 0, `${PATCH_A}\n${PATCH_B}`, `${PATCH_A}\n${PATCH_B}`, "ctx"),
      first,
      second,
    ];
    expect(resolvePayloadFromToolCallLog(log, first)).toBe(PATCH_A);
    expect(resolvePayloadFromToolCallLog(log, second)).toBe(PATCH_B);
  });

  it("计划调用拿到计划块，不会误取同轮的补丁块", () => {
    const call = toolCall("tc-plan", "call-plan", "present_plan");
    const log: LogEntry[] = [
      createAssistantText("text-1", 1, 0, `${PLAN_1}\n${PATCH_A}`, `${PLAN_1}\n${PATCH_A}`, "ctx"),
      toolCall("tc-edit", "call-edit", "edit"),
      call,
    ];
    expect(resolvePayloadFromToolCallLog(log, call)).toBe(PLAN_1);
  });
});
