/**
 * 会话级提示词归拢（压缩续写 + 断点续跑）。
 *
 * 这里集中存放"措辞直接决定续接质量"的提示词模板，便于统一审校与回归：
 * - 压缩：模型正常输出后 / 工具调用后触发压缩时的续写提示（COMPACT_PROMPT_*）。
 * - 续跑：会话重启后由 task_resume 注入的断点续跑提示（buildContinuationPrompt）。
 * - 手动压缩：用户在手动压缩时附加的补充指令包装（appendManualInstruction）。
 *
 * 由 Session 使用：压缩见 _runCompactPhase / runManualCompact，续跑见
 * task_resume 的对账续跑入口。修改措辞时注意保持压缩提示中
 * "系统提示与任务清单会被自动重注入"的描述与运行时实际行为一致。
 */

import type { Task, TaskResumeHint } from "../lib/task-store.js";

// -- Compact Prompt: 正常输出场景 --
/**
 * 用于模型正常输出后触发压缩的提示。
 * 目标：生成一个 briefing，使新实例能够无缝接续工作。
 */
export const COMPACT_PROMPT_OUTPUT = `Condense this conversation into a continuation prompt — imagine you're writing a briefing for a fresh instance of yourself who must seamlessly pick up where we left off, with zero access to the original conversation.

**What the new instance will already have:** your system prompt and persistent memory (global MEMORY.md and project AGENTS.md) are automatically re-injected after compact. The session task list — ids, statuses, owners, dependency edges, and interruption hints — is re-injected as well. Do not duplicate any of their contents in the continuation prompt: do not restate task ids or statuses, and focus on what they cannot convey: current progress, session-specific context, and in-flight work state.

Preserve the current assignment verbatim: allowed paths, acceptance checks, stop conditions, and the required handoff format.

Your summary should capture everything that matters and nothing that doesn't. Use whatever structure best fits the actual content — there is no fixed template. But as you write, pressure-test yourself against these questions:

- **What are we trying to do?** The user's or parent agent's intent, goals, and any constraints or preferences they've expressed — stated or implied.
- **What do we know now that we didn't at the start?** Key discoveries, failed approaches, edge cases encountered, decisions made and *why*.
- **Where exactly are we?** What's done, what's in progress, what's next. Be specific enough that work won't be repeated or skipped.
- **What has been run, with which commands and observed results, and what remains unverified?** Capture validation state, not just conclusions.
- **What artifacts exist?** Files read, created, or modified — with enough context about each to be actionable (not just a path list).
- **What tone/style/working relationship has been established?** (For an interactive root session only.) If the user has shown preferences for how they like to collaborate, note them.
- **What explicit rules has the user stated?** Direct instructions about how to work, what not to do, approval requirements, or behavioral constraints the user has explicitly communicated (e.g., "don't modify code until I approve", "always run tests before committing"). Preserve these verbatim — they are binding rules, not suggestions. If recorded designs or earlier instructions conflict, the user's latest requirement takes precedence.

**Preserve decision-relevant facts generously.** The continuation prompt is the sole bridge between this conversation and the next — anything omitted is permanently lost to the new instance. Include partial findings, open questions, and relevant file paths with enough context to act on them. Cite paths and short excerpts; never paste full files, diffs, or command logs. A briefing that preserves the facts without reproducing the transcript is better than either a terse summary or a copy of the conversation.

Write in natural prose. Use structure where it aids clarity, not for its own sake.`;

// -- Compact Prompt: 工具调用场景 --
/**
 * 用于工具调用后触发压缩的提示。
 * 明确告知模型工具结果已在压缩中，不应继续处理。
 */
export const COMPACT_PROMPT_TOOLCALL = `[SYSTEM: COMPACT REQUIRED] The conversation has exceeded the context limit. Do NOT continue the task. Instead, produce a **continuation prompt** — a briefing that will allow a fresh instance of you (with no access to this conversation) to seamlessly resume the work.

You just made a tool call and received its result above. That result is real and should be reflected in your summary, but do not act on it — your only job right now is to write the continuation prompt.

**What the new instance will already have:** your system prompt and persistent memory (global MEMORY.md and project AGENTS.md) are automatically re-injected after compact. The session task list — ids, statuses, owners, dependency edges, and interruption hints — is re-injected as well. Do not duplicate any of their contents in the continuation prompt: do not restate task ids or statuses, and focus on what they cannot convey: current progress, session-specific context, and in-flight work state.

Preserve the current assignment verbatim: allowed paths, acceptance checks, stop conditions, and the required handoff format.

Write in natural prose. Use structure where it aids clarity, not for its own sake. As you write, pressure-test yourself against these questions:

- **What are we trying to do?** The user's or parent agent's intent, goals, constraints, and preferences — stated or implied.
- **What do we know now that we didn't at the start?** Key discoveries, failed approaches, edge cases encountered, decisions made and why.
- **Where exactly did we stop?** Be precise: what was the last tool call, what did it return, and what was supposed to happen next? The new instance must be able to pick up mid-step without repeating or skipping anything.
- **What's done, what's in progress, what remains?** Give a clear picture of overall progress, not just the interrupted step.
- **What has been run, with which commands and observed results, and what remains unverified?** Capture validation state, not just conclusions.
- **What artifacts exist?** Files read, created, or modified — with enough context about each to be actionable.
- **What working style has the user shown?** (For an interactive root session only.) Communication preferences, collaboration patterns, or explicit instructions about how they like to work.
- **What explicit rules has the user stated?** Direct instructions about how to work, what not to do, approval requirements, or behavioral constraints (e.g., "don't modify code until I approve", "always run tests before committing"). Preserve these verbatim — they are binding rules, not suggestions. If recorded designs or earlier instructions conflict, the user's latest requirement takes precedence.

**Preserve decision-relevant facts generously.** The continuation prompt is the sole bridge between this conversation and the next — anything omitted is permanently lost to the new instance. Include partial findings, open questions, and relevant file paths with enough context to act on them. Cite paths and short excerpts; never paste full files, diffs, or command logs. A briefing that preserves the facts without reproducing the transcript is better than either a terse summary or a copy of the conversation.

End the summary with a clear, imperative statement of what the next instance should do first upon resuming.`;

/**
 * 断点续跑提示：必须让子代理先复核"可能只生效一半"的那一步。
 *
 * 生成 task_resume 对账续跑时的直接输入（与 spawn 语义一致）。
 * 提示要点：上次运行被打断的进度、最后一个无结果工具调用的复核要求、
 * 从第一个未完成步骤继续、不重做已完成工作、不修改父会话任务清单。
 */
export function buildContinuationPrompt(task: Task, hint: TaskResumeHint, note?: string): string {
  const parts: string[] = [
    `You are resuming task #${task.id}: "${task.subject}"`,
    `Your previous run on this task was interrupted before this turn completed ` +
      `(recorded progress: ${hint.toolCalls} tool call(s), about ${hint.tokensIn} input tokens).`,
    "If the last tool call in your history has no result, its real-world effect may be partial or unknown: " +
      "re-verify that step before continuing.",
    "Continue from the first incomplete step. Do not redo work that is already finished.",
  ];
  if (task.description.trim().length > 0) parts.push(`Original task description:\n${task.description}`);
  const lastResult = task.metadata["lastResult"];
  if (typeof lastResult === "string" && lastResult.trim().length > 0) {
    const clipped = lastResult.length > 4000 ? `${lastResult.slice(0, 4000)}\n\n[... truncated]` : lastResult;
    parts.push(`What you had reported so far:\n${clipped}`);
  }
  if (note && note.trim().length > 0) parts.push(note);
  parts.push(
    "Complete this task fully. You may track your own substeps with task_create/task_update; " +
      "do not modify the parent session's task list.",
  );
  parts.push("Finish with the structured handoff your role prompt requires.");
  return parts.join("\n\n");
}

/**
 * 在压缩 prompt 基础上追加用户手动指定的补充指令。
 * 用于手动压缩中用户附加的说明。
 */
export function appendManualInstruction(
  basePrompt: string,
  instruction: string | undefined,
  kind: "compact",
): string {
  const trimmed = instruction?.trim();
  if (!trimmed) return basePrompt;
  return `${basePrompt}\n\nAdditional user instruction for this manual ${kind} request:\n${trimmed}`;
}
