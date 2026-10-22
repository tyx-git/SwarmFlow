/** 只读查看类会话命令：/help /usage /status /clear /memory。 */

import { type CommandContext } from "../types.js";

export async function cmdHelp(ctx: CommandContext, _args: string): Promise<void> {
  // The TUI owns the help overlay and builds it from the same registry. A
  // sentinel keeps command execution independent from the renderer.
  ctx.showMessage("__help_panel__");
}

export async function cmdUsage(ctx: CommandContext, _args: string): Promise<void> {
  ctx.showMessage("__usage_panel__");
}

export async function cmdStatus(ctx: CommandContext, _args: string): Promise<void> {
  ctx.showMessage("__status_panel__");
}

export async function cmdClear(ctx: CommandContext, _args: string): Promise<void> {
  if (ctx.isProcessing?.()) {
    (ctx.showHint ?? ctx.showMessage)("Wait until the assistant finishes.");
    return;
  }
  ctx.autoSave();
  ctx.session.setDisplayCutoff?.();
  ctx.session._resetTransientState?.();
  ctx.resetUiState();
  ctx.requestFullRepaint?.();
  ctx.showMessage("Screen cleared. Conversation state is reset for future turns, while the session record remains on disk.");
}

export async function cmdMemory(ctx: CommandContext, _args: string): Promise<void> {
  ctx.showMessage("__memory_panel__");
}
