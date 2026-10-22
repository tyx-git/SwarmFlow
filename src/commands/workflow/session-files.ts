/** 计划与评审的工作目录准备及初始文件写入。 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { type CommandContext } from "../types.js";

export function getSessionId(ctx: CommandContext): string {
  const dir = ctx.store?.sessionDir;
  return dir ? basename(dir) : "current";
}

function ensureSwarmflowSessionDir(ctx: CommandContext, section: "plan" | "reviewer"): string {
  const sessionId = getSessionId(ctx);
  const dir = join(process.cwd(), ".swarmflow", sessionId, section);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeInitialPlanFiles(ctx: CommandContext, goal: string): string {
  const dir = ensureSwarmflowSessionDir(ctx, "plan");
  const planPath = join(dir, "plan.md");
  const processPath = join(dir, "process.md");
  const findingPath = join(dir, "finding.md");

  if (!existsSync(planPath)) {
    writeFileSync(planPath, [
      "# Plan",
      "",
      "## Goal",
      goal || "<session goal>",
      "",
      "## Constraints",
      "- Preserve user-confirmed scope unless explicitly revised.",
      "",
      "## Done When",
      "- <completion criterion>",
      "",
      "## Stage 1: Clarify and prepare",
      "- [ ] Clarify ambiguous requirements.",
      "- [ ] Confirm done conditions.",
      "",
      "## Stage 2: Execute",
      "- [ ] Implement approved subtasks.",
      "- [ ] Verify results.",
      "",
    ].join("\n"), "utf-8");
  }

  if (!existsSync(processPath)) {
    writeFileSync(processPath, `# Process\n\n- Created plan files for session ${getSessionId(ctx)}.\n`, "utf-8");
  } else {
    appendFileSync(processPath, `- Re-entered plan mode. Goal: ${goal || "(not specified)"}.\n`, "utf-8");
  }
  writeFileSync(findingPath, "# Current Stage Findings\n\n", "utf-8");
  return dir;
}

export function writeReviewerScaffold(ctx: CommandContext, scope: string): string {
  const dir = ensureSwarmflowSessionDir(ctx, "reviewer");
  writeFileSync(join(dir, "report.md"), [
    "# Reviewer Report",
    "",
    "## Scope",
    scope || "Whole project",
    "",
    "## Summary",
    "Pending reviewer run.",
    "",
    "## Findings",
    "",
    "| Severity | Evidence | Impact | Recommendation |",
    "| --- | --- | --- | --- |",
    "",
  ].join("\n"), "utf-8");

  writeFileSync(join(dir, "todo.md"), [
    "# Plan",
    "",
    "## Goal",
    `Fix findings from reviewer scope: ${scope || "Whole project"}`,
    "",
    "## Constraints",
    "- Transfer this todo into /plan before execution.",
    "",
    "## Done When",
    "- Reviewer findings are resolved and verified.",
    "",
    "## Stage 1: Review findings",
    "- [ ] Fill concrete findings from report.md.",
    "",
  ].join("\n"), "utf-8");
  return dir;
}
