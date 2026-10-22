/** /language 界面语言设置。 */

import { basename, join } from "node:path";

import { loadGlobalSettings } from "../../config/settings/io.js";

import {
  createUiText,
  normalizeUiLanguage,
  UI_LANGUAGES,
  type UiLanguage,
} from "../../ui/text.js";

import { persistSettingsPatch } from "../settings-patch.js";
import { type CommandContext, type CommandOption, type CommandOptionsContext } from "../types.js";

/** 语言在文案表里的名字（中文/英文各自母语显示）。 */
function languageNameKey(lang: UiLanguage): string {
  return lang === "en" ? "languageNameEn" : "languageNameZh";
}

/** 语言选项（/language 选择器）。 */
export function languageOptions(_ctx: CommandOptionsContext): CommandOption[] {
  const t = createUiText();
  const current = normalizeUiLanguage(loadGlobalSettings().ui_language);
  return UI_LANGUAGES.map((lang) => {
    const name = t.get(["Common", languageNameKey(lang)]);
    return { label: lang === current ? `${name}  (current)` : name, value: lang };
  });
}

export async function cmdLanguage(ctx: CommandContext, args: string): Promise<void> {
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
      commandName: "/language",
      commandArgs: choice,
    });
    if (hookResult.decision === "deny") {
      ctx.showMessage(hookResult.denyReason ?? "Command denied by hook.");
      return;
    }
  }

  if (!choice && ctx.promptCommandPicker) {
    const picked = await ctx.promptCommandPicker(
      languageOptions({ session: ctx.session, store: ctx.store }),
    );
    if (!picked) return;
    choice = picked.value;
  }

  // "中文" / "英文" / "chinese" / "english" 之类的写法也接受
  const normalizedChoice = normalizeUiLanguage(choice);
  const known = UI_LANGUAGES.includes(normalizedChoice)
    && (choice === normalizedChoice
        || choice === "zh" || choice === "cn" || choice === "chinese"
        || choice === "en" || choice === "english");

  if (known) {
    persistSettingsPatch({ ui_language: normalizedChoice }, ctx.swarmflowHomeDir);
    // 魔术消息- TUI拦截后直接切换文案表，无需重启。
    ctx.showMessage(`__ui_language__:${normalizedChoice}`);
    hint(t.get(["Commands", "/language", "hint"], { language: t.get(["Common", languageNameKey(normalizedChoice)]) }));
    return;
  }

  const current = normalizeUiLanguage(loadGlobalSettings().ui_language);
  ctx.showMessage(
    t.get(["Commands", "/language", "current"], { language: t.get(["Common", languageNameKey(current)]) })
      + "\n"
      + t.get(["Commands", "/language", "usage"], { languages: UI_LANGUAGES.join(" | ") }),
  );
}

// ------------------------------------------------------------------
// /rename -设置自定义会话标题
// ------------------------------------------------------------------
