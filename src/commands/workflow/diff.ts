/** /diff 差异展示模式设置。 */

import { persistSettingsPatch } from "../settings-patch.js";
import { type CommandContext } from "../types.js";

export async function cmdDiff(ctx: CommandContext, _args: string): Promise<void> {
  let choice = _args.trim().toLowerCase();
  if (!choice && ctx.promptCommandPicker) {
    const picked = await ctx.promptCommandPicker([
      { label: "Compact", value: "compact" },
      { label: "Full", value: "full" },
    ]);
    const value = picked as unknown;
    choice = typeof value === "string"
      ? value
      : (value as { value?: string } | undefined)?.value ?? "";
  }

  if (choice !== "compact" && choice !== "full") {
    ctx.showMessage("Diff display is currently compact. Use /diff compact or /diff full.");
    return;
  }

  persistSettingsPatch({ diff_display: choice }, ctx.swarmflowHomeDir);
  ctx.showMessage(`__diff_display__:${choice}`);
  (ctx.showHint ?? ctx.showMessage)(`Diff display: ${choice}`);
}

// ------------------------------------------------------------------
// /主题-选择浅色/深色/自动
// ------------------------------------------------------------------
