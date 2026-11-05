/** 计划与评审的工作目录准备：目录名与路径统一取自 `session/plan-artifact.ts`。 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { type CommandContext } from "../types.js";
import { ensureSwarmflowSessionDir, sessionDirName } from "../../session/plan-artifact.js";

export function getSessionId(ctx: CommandContext): string {
  const store = ctx.store;
  if (!store) {
    throw new Error("Session storage is unavailable; cannot resolve this session's id.");
  }
  return sessionDirName(store);
}

export function writeReviewerScaffold(ctx: CommandContext, scope: string): string {
  const dir = ensureSwarmflowSessionDir(process.cwd(), getSessionId(ctx), "reviewer");
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
