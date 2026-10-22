/** /theme 主题模式设置。 */

import { basename, join } from "node:path";

import { loadGlobalSettings } from "../../config/settings/io.js";

import { THEME_MODES, normalizeThemeMode, type ThemeMode } from "../../config/theme.js";

import { createUiText } from "../../ui/text.js";

import { persistSettingsPatch } from "../settings-patch.js";
import { type CommandContext, type CommandOption, type CommandOptionsContext } from "../types.js";

/** 主题模式的显示名（中英文命令面板统一）。 */
function themeLabel(mode: ThemeMode): string {
  switch (mode) {
    case "brief": return "Brief";
    case "dark": return "Dark";
    default: return "Light";
  }
}

/** 是否是受支持的主题模式（用于校验 /theme 参数）。 */
function isThemeMode(value: string): value is ThemeMode {
  return (THEME_MODES as readonly string[]).includes(value);
}

export function themeModeOptions(_ctx: CommandOptionsContext): CommandOption[] {
  const current = normalizeThemeMode(loadGlobalSettings().theme_mode);
  const currentLabel = themeLabel(current);
  return THEME_MODES.map((mode) => ({
    label: mode === current ? `${themeLabel(mode)}${currentLabel ? "  (current)" : ""}` : themeLabel(mode),
    value: mode,
  }));
}

export async function cmdTheme(ctx: CommandContext, args: string): Promise<void> {
  const t = createUiText();
  const hint = ctx.showHint ?? ctx.showMessage;
  let choice = args.trim().toLowerCase();

  // 触发 CommandExecute hook
  const hookRuntime = ctx.session?.hookRuntime;
  if (hookRuntime) {
    const hookResult = await hookRuntime.evaluate("CommandExecute", {
      event: "CommandExecute",
      timestamp: Date.now(),
      sessionId: ctx.store?.sessionDir ? basename(ctx.store.sessionDir) : undefined,
      commandName: "/theme",
      commandArgs: choice,
    });
    if (hookResult.decision === "deny") {
      ctx.showMessage(hookResult.denyReason ?? "Command denied by hook.");
      return;
    }
  }

  if (!choice && ctx.promptCommandPicker) {
    const picked = await ctx.promptCommandPicker(
      themeModeOptions({ session: ctx.session, store: ctx.store }),
    );
    if (!picked) return;
    choice = picked.value;
  }

  if (isThemeMode(choice)) {
    persistSettingsPatch({ theme_mode: choice }, ctx.swarmflowHomeDir);
    // 魔术消息- TUI拦截和更新React状态而不重启。
    ctx.showMessage(`__theme_mode__:${choice}`);
    hint(t.get(["Commands", "/theme", "hint"], { mode: choice }));
    return;
  }

  const current = normalizeThemeMode(loadGlobalSettings().theme_mode);
  ctx.showMessage(
    t.get(["Commands", "/theme", "current"], { mode: current })
      + "\n"
      + t.get(["Commands", "/theme", "usage"], { modes: THEME_MODES.join(" | ") }),
  );
}
