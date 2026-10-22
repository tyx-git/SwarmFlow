import { describe, expect, it } from "vitest";

import {
  childRestartState,
  decideChildResume,
  describeResumeReason,
  toResumeHint,
} from "../../src/tasks/reconcile.js";
import type { ChildResumeSignals, ResumeReason } from "../../src/tasks/reconcile.js";

function signals(overrides: Partial<ChildResumeSignals> = {}): ChildResumeSignals {
  return {
    childId: "scout-1",
    logAvailable: true,
    templateAvailable: true,
    sessionAvailable: true,
    outcome: "none",
    taskAgentId: "scout-1",
    toolCalls: 12,
    tokensIn: 40_000,
    ...overrides,
  };
}

describe("decideChildResume", () => {
  it("resumes work that has real investment", () => {
    expect(decideChildResume(signals())).toEqual({ resumable: true, reason: "in_progress_work" });
  });

  it("applies the OR threshold exactly at the boundary", () => {
    expect(decideChildResume(signals({ toolCalls: 9, tokensIn: 29_999 }))).toEqual({ resumable: false, reason: "too_early" });
    expect(decideChildResume(signals({ toolCalls: 10, tokensIn: 0 })).resumable).toBe(true);
    expect(decideChildResume(signals({ toolCalls: 0, tokensIn: 30_000 })).resumable).toBe(true);
  });

  it("does not resume when the child log is unavailable", () => {
    expect(decideChildResume(signals({ logAvailable: false }))).toEqual({ resumable: false, reason: "log_unavailable" });
  });

  it("does not resume when the template cannot be resolved", () => {
    expect(decideChildResume(signals({ templateAvailable: false }))).toEqual({ resumable: false, reason: "template_missing" });
  });

  it("does not resume a child whose session object was already released", () => {
    expect(decideChildResume(signals({ sessionAvailable: false }))).toEqual({ resumable: false, reason: "child_released" });
  });

  it("does not resume a task already taken over by a newer run", () => {
    expect(decideChildResume(signals({ taskAgentId: "worker-2" }))).toEqual({ resumable: false, reason: "superseded" });
  });

  it("does not resume work the user deliberately stopped", () => {
    expect(decideChildResume(signals({ cause: "user_targeted_kill" })).reason).toBe("user_stopped");
    expect(decideChildResume(signals({ cause: "user_mass_interrupt" })).reason).toBe("user_stopped");
  });

  it("does not resume finished or failed children", () => {
    expect(decideChildResume(signals({ outcome: "completed" }))).toEqual({ resumable: false, reason: "already_completed" });
    expect(decideChildResume(signals({ outcome: "error" }))).toEqual({ resumable: false, reason: "failed" });
  });

  it("resumes children interrupted by the parent or by a crash", () => {
    expect(decideChildResume(signals({ outcome: "interrupted", cause: "parent_kill" })).resumable).toBe(true);
    expect(decideChildResume(signals({ outcome: "interrupted", cause: "natural" })).resumable).toBe(true);
  });

  it("exempts persistent children from the threshold", () => {
    const decision = decideChildResume(signals({ mode: "persistent", toolCalls: 0, tokensIn: 0 }));
    expect(decision).toEqual({ resumable: true, reason: "persistent_child" });
    // 排除规则仍然优先于豁免
    expect(decideChildResume(signals({ mode: "persistent", outcome: "completed" })).reason).toBe("already_completed");
    expect(decideChildResume(signals({ mode: "persistent", cause: "user_mass_interrupt" })).reason).toBe("user_stopped");
  });

  it("lets hard gates outrank the threshold", () => {
    const decision = decideChildResume(signals({ logAvailable: false, toolCalls: 999, tokensIn: 999_999 }));
    expect(decision).toEqual({ resumable: false, reason: "log_unavailable" });
  });

  it("resumes an undispatched task (no agentId recorded) when work was done", () => {
    expect(decideChildResume(signals({ taskAgentId: undefined })).resumable).toBe(true);
  });
});

describe("childRestartState", () => {
  it("marks every restarted child as failed while keeping the interrupted semantics", () => {
    expect(childRestartState(true)).toEqual({ lifecycle: "idle", status: "error", outcome: "interrupted", keepSession: true });
    expect(childRestartState(false)).toEqual({ lifecycle: "archived", status: "error", outcome: "interrupted", keepSession: false });
  });

  it("preserves a verdict the child already reached before the restart", () => {
    expect(childRestartState(false, "completed")).toEqual({
      lifecycle: "archived",
      status: "completed",
      outcome: "completed",
      keepSession: false,
    });
    expect(childRestartState(false, "error")).toEqual({
      lifecycle: "archived",
      status: "error",
      outcome: "error",
      keepSession: false,
    });
    // 被重启打断的子才统一落成 fail
    expect(childRestartState(false, "interrupted").status).toBe("error");
    expect(childRestartState(true, "none").lifecycle).toBe("idle");
  });

  it("never writes outcome=error, so a later restart cannot self-lock", () => {
    for (const resumable of [true, false]) {
      expect(childRestartState(resumable).outcome).not.toBe("error");
    }
    // 归一后的状态再次进入判定时，仍然按「被打断」处理，而不是「子自身失败」。
    const normalized = childRestartState(true);
    expect(decideChildResume(signals({ outcome: normalized.outcome })).resumable).toBe(true);
  });
});

describe("toResumeHint", () => {
  it("carries the metrics and the decision into the parent task metadata", () => {
    const s = signals({ toolCalls: 15, tokensIn: 12_345 });
    expect(toResumeHint(s, decideChildResume(s))).toEqual({
      childId: "scout-1",
      toolCalls: 15,
      tokensIn: 12_345,
      resumable: true,
      reason: "in_progress_work",
    });
  });
});

describe("describeResumeReason", () => {
  it("explains every reason", () => {
    const reasons: ResumeReason[] = [
      "in_progress_work",
      "too_early",
      "user_stopped",
      "already_completed",
      "failed",
      "superseded",
      "log_unavailable",
      "template_missing",
      "model_unavailable",
      "child_released",
      "persistent_child",
    ];
    for (const reason of reasons) {
      expect(describeResumeReason(reason).length).toBeGreaterThan(0);
    }
  });
});
