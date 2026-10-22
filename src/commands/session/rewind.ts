/** /rewind 回退点列表构建与回退执行。 */

import { join } from "node:path";

import { type CommandContext, type CommandOption, type CommandOptionsContext } from "../types.js";

function formatRewindDetail(target: {
  fileCount: number;
  additions: number;
  deletions: number;
  filesReverted: boolean;
}): string {
  if (target.filesReverted) return "Changes reverted";
  if (target.fileCount === 0) return "No code changes";
  const parts: string[] = [];
  if (target.additions > 0) parts.push(`+${target.additions}`);
  if (target.deletions > 0) parts.push(`-${target.deletions}`);
  const n = target.fileCount;
  parts.push(`${n} file${n > 1 ? "s" : ""}`);
  return parts.join(" ");
}

export function rewindOptions(ctx: CommandOptionsContext): CommandOption[] {
  const session = ctx.session;
  const targets = session.getRewindTargets();
  const header: CommandOption = { label: "Message", value: "", detail: "Changes", disabled: true };
  const current: CommandOption = { label: "(Current)", value: "0:cancel", detail: "" };
  if (targets.length === 0) {
    return [
      header,
      current,
      { label: "No previous turns", value: "", detail: "", disabled: true },
    ];
  }

  const options: CommandOption[] = targets.map((t) => {
    const hasLiveMutations = t.fileCount > 0 && !t.filesReverted;
    const children: CommandOption[] = [];

    if (hasLiveMutations) {
      children.push(
        { label: "Restore code and conversation", value: `${t.turnIndex}:both` },
        { label: "Restore conversation", value: `${t.turnIndex}:conversation` },
        { label: "Restore code", value: `${t.turnIndex}:files` },
        { label: "Never mind", value: `${t.turnIndex}:cancel` },
      );
    } else {
      children.push(
        { label: "Restore conversation", value: `${t.turnIndex}:conversation` },
        { label: "Never mind", value: `${t.turnIndex}:cancel` },
      );
    }

    return {
      label: t.preview,
      detail: formatRewindDetail(t),
      value: String(t.turnIndex),
      children,
    };
  });

  return [header, current, ...options];
}

export async function cmdRewind(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;

  if (!session.rewindConversation) {
    ctx.showMessage("Rewind is not supported in this session.");
    return;
  }

  // 从直接参数或选择器中解析turnIndex和mode
  let turnIndex: number;
  let mode: "both" | "conversation" | "files" | "cancel";

  const raw = args.trim();
  if (raw) {
    // 直接参数："/rewind 3"（仅限对话）或"/rewind 3:files"（来自picker）
    const colonIdx = raw.indexOf(":");
    if (colonIdx >= 0) {
      turnIndex = parseInt(raw.slice(0, colonIdx), 10);
      mode = raw.slice(colonIdx + 1) as "both" | "conversation" | "files" | "cancel";
    } else {
      turnIndex = parseInt(raw, 10);
      mode = "conversation";
    }
    if (isNaN(turnIndex)) {
      ctx.showMessage(`Invalid turn number: "${raw}"`);
      return;
    }
  } else if (ctx.promptCommandPicker) {
    const picked = await ctx.promptCommandPicker(rewindOptions({ session, store: ctx.store }));
    if (!picked) return;
    const colonIdx = picked.value.indexOf(":");
    if (colonIdx < 0) return;
    turnIndex = parseInt(picked.value.slice(0, colonIdx), 10);
    mode = picked.value.slice(colonIdx + 1) as "both" | "conversation" | "files" | "cancel";
    if (isNaN(turnIndex)) return;
  } else {
    ctx.showMessage("Usage: /rewind <turn_number>");
    return;
  }

  if (mode === "cancel") return;

  if (mode === "conversation") {
    const result = session.rewindConversation(turnIndex);
    if (result.error) {
      ctx.showMessage(`Rewind failed: ${result.error}`);
      return;
    }
    ctx.showMessage(`Rewound conversation to turn ${turnIndex}. Removed ${result.removed} log entries.`);
    ctx.autoSave();
    return;
  }

  // 对于"文件"和"两者"模式，我们需要先计划
  if (!session.planRewind || !session.rewindFiles || !session.rewindBoth) {
    ctx.showMessage("File rewind is not supported in this session.");
    return;
  }

  const plan = await session.planRewind(turnIndex);
  const hasFiles = plan.applicable.length + plan.warnings.length > 0;
  const hasConflicts = plan.conflicts.length > 0;
  const hasBash = plan.bashEntries.length > 0;

  if (!hasFiles && !hasConflicts && !hasBash) {
    if (mode === "both") {
      const result = session.rewindConversation(turnIndex);
      if (result.error) {
        ctx.showMessage(`Rewind failed: ${result.error}`);
        return;
      }
      ctx.showMessage(`Rewound conversation to turn ${turnIndex}. No file changes to revert.`);
    } else {
      ctx.showMessage("No file changes to revert.");
    }
    ctx.autoSave();
    return;
  }

  // 显示文件冲突（计划时，这些不会在执行时更改）
  if (hasConflicts) {
    const conflictList = plan.conflicts.map((c: { path: string; reason: string }) => `  ${c.path} (${c.reason})`).join("\n");
    ctx.showMessage(`Warning: ${plan.conflicts.length} file(s) cannot be auto-reverted:\n${conflictList}`);
  }
  // 注意：bash冲突不会在这里显示——它们会在执行时重新评估
  // 时间，因此计划时间状态可能不能反映最终结果。

  const formatBashResult = (result: { bashReverted?: string[]; bashSkipped?: string[] }): string => {
    const parts: string[] = [];
    if (result.bashReverted && result.bashReverted.length > 0) {
      parts.push(`Reverted ${result.bashReverted.length} shell operation(s):`);
      for (const desc of result.bashReverted) parts.push(`  ✓ ${desc}`);
    }
    if (result.bashSkipped && result.bashSkipped.length > 0) {
      parts.push(`Skipped ${result.bashSkipped.length} shell operation(s):`);
      for (const desc of result.bashSkipped) parts.push(`  ✗ ${desc}`);
    }
    return parts.join("\n");
  };

  if (mode === "files") {
    const result = await session.rewindFiles(plan);
    if (result.error) {
      ctx.showMessage(`File rewind failed: ${result.error}`);
      return;
    }
    const filePart = result.revertedPaths.length > 0
      ? `Reverted ${result.revertedPaths.length} file edit(s).`
      : "No file edits were reverted.";
    const bashPart = formatBashResult(result);
    ctx.showMessage([filePart, bashPart].filter(Boolean).join("\n"));
  } else {
    // 模式=== "both"
    const result = await session.rewindBoth(turnIndex, plan);
    if (result.error) {
      ctx.showMessage(`Rewind failed: ${result.error}`);
      return;
    }
    const filePart = result.revertedPaths.length > 0
      ? `Reverted ${result.revertedPaths.length} file edit(s).`
      : "";
    const convPart = `Removed ${result.removed} log entries.`;
    const bashPart = formatBashResult(result);
    const hasSkipped =
      plan.conflicts.length > 0 ||
      result.conflictPaths.length > 0 ||
      (result.bashSkipped?.length ?? 0) > 0;
    const warnPart = hasSkipped
      ? "Some disk changes could not be reverted. Inspect the working tree before continuing."
      : "";
    ctx.showMessage([`Rewound to turn ${turnIndex}. ${convPart} ${filePart}`.trim(), bashPart, warnPart].filter(Boolean).join("\n"));
  }

  ctx.autoSave();
  try {
    session.finalizeRewindJournal?.();
  } catch (error) {
    ctx.showHint?.(`Rewind recovery journal retained: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ------------------------------------------------------------------
// /钩子命令
// ------------------------------------------------------------------
