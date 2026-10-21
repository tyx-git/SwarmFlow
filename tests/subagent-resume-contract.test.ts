/**
 * 契约测试：one-shot 子代理的“不能收 follow-up”与 task_resume 续跑输入必须一致。
 *
 * - 系统层：oneshot.md 必须声明运行时恢复是唯一例外。
 * - 输入层：续跑提示必须以非 follow-up 的显式声明开头。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Task, TaskResumeHint } from "../src/lib/task-store.js";
import { buildContinuationPrompt } from "../src/session/session-prompts.js";

function makeTask(): Task {
  return {
    id: "7",
    subject: "Fix the flaky login test",
    description: "Reproduce first.",
    status: "pending",
    metadata: {},
    blocks: [],
    blockedBy: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeHint(): TaskResumeHint {
  return {
    childId: "worker-1",
    toolCalls: 12,
    tokensIn: 40_000,
    resumable: true,
    reason: "worth_resuming",
  };
}

describe("one-shot resume contract", () => {
  it("starts the resume input by explicitly rejecting follow-up semantics", () => {
    const prompt = buildContinuationPrompt(makeTask(), makeHint());
    expect(prompt.startsWith("This is not a follow-up message.")).toBe(true);
    expect(prompt).toContain('You are resuming task #7: "Fix the flaky login test"');
    expect(prompt).toContain("Finish with the structured handoff your role prompt requires.");
  });

  it("allows runtime resume after interruption in the one-shot lifecycle prompt", () => {
    const oneshot = readFileSync(
      join(process.cwd(), "prompts", "subagent", "oneshot.md"),
      "utf-8",
    );
    expect(oneshot).toContain("only exception is a runtime resume after an interruption");
    expect(oneshot).toContain("continues the same task");
  });
});
