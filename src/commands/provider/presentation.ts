/** 提供商命令的文案取词与切换回声提示。 */

import { createUiText, getUiLanguage, type UiText } from "../../ui/text.js";

import { type CommandContext } from "../types.js";

export function providerText(homeDir?: string): UiText {
  return createUiText(getUiLanguage(homeDir));
}

/** 将流程完成文本按切换类命令回显渲染，而不是普通状态消息。 */
export function appendProviderSwitchEcho(ctx: CommandContext, text: string): void {
  if (typeof ctx.session?.appendCommandEcho === "function") {
    ctx.session.appendCommandEcho(text, "switch");
  } else {
    ctx.showMessage(text);
  }
}
