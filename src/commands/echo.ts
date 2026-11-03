/** 用户键入斜杠命令时，主界面回显条目的判定。 */

import { resolveCommandEchoDisplay, type UiLanguage } from "../ui/text.js";

import { type SlashCommand } from "./types.js";

/** 一条要写进主界面的回显；`switch` 是本地化切换文案，`injected` 按原样显示。 */
export interface TypedCommandEcho {
  text: string;
  style: "switch" | "injected";
}

/**
 * 判断键入的命令行是否需要 UI 预回显。
 *
 * 返回 null 表示命令流程自己会写出这条用户行：Provider 这类多步配置流程
 * 在入口按中间参数回显会把参数误称成最终结果，/plan 这类注入回合更是已经把
 * displayText 作为 user_message 落进日志——两处都写就成两行一样的命令。
 */
export function resolveTypedCommandEcho(
  command: Pick<SlashCommand, "selfEcho"> | undefined,
  input: string,
  language: UiLanguage,
): TypedCommandEcho | null {
  if (command?.selfEcho) return null;
  const echo = resolveCommandEchoDisplay(input, language);
  return echo ? { text: echo, style: "switch" } : { text: input, style: "injected" };
}
