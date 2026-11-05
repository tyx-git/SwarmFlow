/**
 * plan 产物：会话目录名与 `<cwd>/.swarmflow/<session-id>/plan/` 路径的唯一来源，
 * 以及确认门批准时生成 plan.md 的写入器。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/** 生成 plan.md 所需的最小 store 面（真实 SessionStore 与测试替身都满足）。 */
export interface PlanSessionStore {
  sessionDir?: string;
  predictNextSessionDir(): string;
}

/**
 * 会话目录名：已落盘用 store 的目录名，未落盘用预测目录——
 * 否则会退化成所有会话共享的 "current"，把计划文件写两份。
 */
export function sessionDirName(store: PlanSessionStore): string {
  return basename(store.sessionDir ?? store.predictNextSessionDir());
}

/** 会话的 plan / reviewer 工作目录（不创建）。 */
export function swarmflowSessionDir(
  cwd: string,
  sessionName: string,
  section: "plan" | "reviewer",
): string {
  return join(cwd, ".swarmflow", sessionName, section);
}

/** 确保目录存在并返回它。 */
export function ensureSwarmflowSessionDir(
  cwd: string,
  sessionName: string,
  section: "plan" | "reviewer",
): string {
  const dir = swarmflowSessionDir(cwd, sessionName, section);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface ApprovedPlanInput {
  cwd: string;
  store: PlanSessionStore;
  /** 确认门附带的计划正文（present_plan 的裸块载荷，已去掉标记行）。 */
  planContent: string;
  goal?: string;
  /** `formatTaskSnapshot` 产出的进度段；为空时不写 Progress 小节。 */
  progress?: string;
  approvedAt: string;
}

/**
 * 批准瞬间生成唯一一份 plan.md：表头（时刻 + goal + 批准来源）+ 正文 + Progress 快照。
 * 返回写入用的绝对路径——给模型的路径一律绝对，相对会话目录的路径模型解析不了。
 */
export function writeApprovedPlan(input: ApprovedPlanInput): string {
  const dir = ensureSwarmflowSessionDir(input.cwd, sessionDirName(input.store), "plan");
  const planPath = join(dir, "plan.md");
  const lines = [
    "# Plan",
    "",
    `Approved at: ${input.approvedAt}`,
    `Goal: ${input.goal?.trim() ? input.goal.trim() : "(not specified)"}`,
    "Approved by: user confirmation gate (present_plan)",
    "",
    input.planContent.trim(),
  ];
  if (input.progress?.trim()) {
    lines.push("", "## Progress", input.progress.trim());
  }
  writeFileSync(planPath, `${lines.join("\n")}\n`, "utf-8");
  return planPath;
}
