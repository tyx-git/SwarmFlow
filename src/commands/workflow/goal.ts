/** 工作流入口命令：/init /plan /goal /fix /ask。 */

import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import { launchDesignHelper } from "../../browser-preview/index.js";

import { type CommandContext } from "../types.js";
import { getSessionId, writeInitialPlanFiles } from "./session-files.js";

export async function cmdInit(ctx: CommandContext, _args: string): Promise<void> {
  const agentsPath = join(process.cwd(), "AGENTS.md");
  if (existsSync(agentsPath)) {
    ctx.showMessage("AGENTS.md already exists at the project root. /init will not overwrite it.");
    return;
  }
  const prompt = [
    "Run initial project exploration for this repository.",
    "Draft a project-level AGENTS.md at the repository root with coding habits, architecture notes, commands, and constraints.",
    "Do not create a global MEMORY.md; global memory is maintained by the user.",
  ].join("\n");
  if (ctx.onInjectedTurnRequested) {
    ctx.onInjectedTurnRequested("/init", prompt);
  } else if (ctx.onTurnRequested) {
    ctx.onTurnRequested(prompt);
  } else {
    ctx.showMessage("No turn runner is available. AGENTS.md draft requires an agent turn.");
  }
}

export async function cmdPlan(ctx: CommandContext, args: string): Promise<void> {
  const goal = args.trim();

  // 触发 CommandExecute hook
  const hookRuntime = ctx.session?.hookRuntime;
  let hookAdditionalContext: string | undefined;
  if (hookRuntime) {
    const hookResult = await hookRuntime.evaluate("CommandExecute", {
      event: "CommandExecute",
      timestamp: Date.now(),
      sessionId: ctx.store?.sessionDir ? basename(ctx.store.sessionDir) : undefined,
      commandName: "/plan",
      commandArgs: goal,
    });
    if (hookResult.decision === "deny") {
      ctx.showMessage(hookResult.denyReason ?? "Command denied by hook.");
      return;
    }
    hookAdditionalContext = hookResult.additionalContext;
  }

  const planDir = writeInitialPlanFiles(ctx, goal);

  // Hook 通过 additionalContext 触发浏览器设计助手
  if (hookAdditionalContext && ctx.promptCommandPicker) {
    ctx.showMessage(hookAdditionalContext);
    const picked = await ctx.promptCommandPicker([
      { label: "Yes — open browser design assistant", value: "yes" },
      { label: "No — skip", value: "no" },
    ]);
    if (picked && picked.value === "yes") {
      try {
        await launchDesignHelper({
          sessionId: getSessionId(ctx),
          goal,
          cwd: process.cwd(),
        });
      } catch (e) {
        ctx.showMessage(`Failed to open design assistant: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  const prompt = [
    "Enter SwarmFlow plan discussion mode.",
    "Clarify ambiguous requirements with the user before making edits.",
    "When ready, write plan.md, process.md, and finding.md under .swarmflow/<session_id>/plan/ using Stage N headings and checkbox subtasks.",
    "Those files are the negotiation artifact for this planning discussion — track execution progress with task_create/task_update, not with the plan file.",
    "Do not execute the plan until the user gives deterministic approval such as 执行, 开始, approve, 确认, or 按计划执行.",
    `Plan files directory: ${planDir}.`,
    goal ? `Initial plan goal: ${goal}` : "Ask the user for the stage goal or requirement.",
  ].join("\n");
  if (ctx.onInjectedTurnRequested) {
    ctx.onInjectedTurnRequested(goal ? `/plan ${goal}` : "/plan", prompt);
  } else if (ctx.onTurnRequested) {
    ctx.onTurnRequested(prompt);
  } else {
    ctx.showMessage("Plan mode requires an agent turn runner in this UI.");
  }
}

export async function cmdGoal(ctx: CommandContext, args: string): Promise<void> {
  const goal = args.trim();
  if (!goal) {
    ctx.showMessage("No session goal is set by this lightweight command yet. Use /goal <objective and done_when> to ask the agent to establish one.");
    return;
  }
  const prompt = [
    "Set or update the current session goal.",
    "Represent it with objective, done_when, constraints, progress, and last_evaluation.",
    "Use completion conditions to decide when the workflow can stop.",
    `User goal: ${goal}`,
  ].join("\n");
  if (ctx.onInjectedTurnRequested) {
    ctx.onInjectedTurnRequested(`/goal ${goal}`, prompt);
  } else if (ctx.onTurnRequested) {
    ctx.onTurnRequested(prompt);
  } else {
    ctx.showMessage(`Session goal: ${goal}`);
  }
}

export async function cmdFix(ctx: CommandContext, args: string): Promise<void> {
  const bug = args.trim();
  if (!bug) {
    ctx.showMessage("Usage: /fix <known existing bug description>");
    return;
  }
  const prompt = [
    "Run a lightweight fix loop for a known existing bug.",
    "Do not create plan files unless the work must escalate to /plan.",
    "Loop: reproduce, locate root cause, fix, verify, and report.",
    `Bug: ${bug}`,
  ].join("\n");
  if (ctx.onInjectedTurnRequested) {
    ctx.onInjectedTurnRequested(`/fix ${bug}`, prompt);
  } else if (ctx.onTurnRequested) {
    ctx.onTurnRequested(prompt);
  } else {
    ctx.showMessage("/fix requires an agent turn runner in this UI.");
  }
}

export async function cmdAsk(ctx: CommandContext, args: string): Promise<void> {
  const question = args.trim();
  if (!question) {
    ctx.showMessage("Usage: /ask <side question>");
    return;
  }
  const prompt = [
    "Answer this as a side question using isolated bypass context.",
    "Do not alter the current goal, plan, or task flow.",
    `Question: ${question}`,
  ].join("\n");
  if (ctx.onInjectedTurnRequested) {
    ctx.onInjectedTurnRequested(`/ask ${question}`, prompt);
  } else if (ctx.onTurnRequested) {
    ctx.onTurnRequested(prompt);
  } else {
    ctx.showMessage("/ask requires an agent turn runner in this UI.");
  }
}
