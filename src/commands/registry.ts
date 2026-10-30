/** 命令注册表：按名注册/查找/补全，以及命令描述的本地化解析。 */

import { createUiText, hasUiText, type UiLanguage } from "../ui/text.js";

import { type SlashCommand } from "./types.js";

/** 可用时从 language.json 解析已安装命令的描述。 */
export function getLocalizedCommandDescription(
  command: Pick<SlashCommand, "name" | "description">,
  language: UiLanguage,
): string {
  const path = ["Commands", command.name, "description"] as const;
  return hasUiText(language, path) ? createUiText(language).get(path) : command.description;
}

function builtinDescription(name: string): string {
  const path = ["Commands", name, "description"] as const;
  if (!hasUiText("en", path) || !hasUiText("zh", path)) {
    throw new Error(`language.json: missing command description for ${name}`);
  }
  return createUiText("en").get(path);
}

export function registerBuiltin(
  registry: CommandRegistry,
  command: Omit<SlashCommand, "description">,
): void {
  registry.register({ ...command, description: builtinDescription(command.name) });
}

// ------------------------------------------------------------------
// CommandRegistry
// ------------------------------------------------------------------

export class CommandRegistry {
  private _commands = new Map<string, SlashCommand>();

  /* 注册命令。覆盖任何具有相同名称的现有命令。 */
  register(cmd: SlashCommand): void {
    // 暴露 options 的命令默认使用共享的 composer 选择器；
    // 非交互客户端可以显式退出这套默认。
    const picker = cmd.options || cmd.picker
      ? {
        inputArea: true,
        mode: "single" as const,
        ...cmd.picker,
      }
      : undefined;
    this._commands.set(cmd.name, {
      ...cmd,
      picker,
    });
  }

  /* 按命令的确切名称删除命令。如果存在则返回true。 */
  unregister(name: string): boolean {
    return this._commands.delete(name);
  }

  /* 按命令的确切名称或别名查找命令。 */
  lookup(name: string): SlashCommand | undefined {
    return this._commands.get(name);
  }

  /* 返回按名称字母顺序排序的所有注册命令。 */
  getAll(): SlashCommand[] {
    return Array.from(this._commands.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /* 返回以给定前缀开头的命令名（用于完成）。 */
  getCompletions(prefix: string): string[] {
    const results: string[] = [];
    for (const name of Array.from(this._commands.keys())) {
      if (name.startsWith(prefix)) {
        results.push(name);
      }
    }
    return results.sort();
  }
}

// ------------------------------------------------------------------
// 内置命令处理程序
// ------------------------------------------------------------------
