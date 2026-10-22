/** /hooks 钩子列表与启停。 */

import { join } from "node:path";

import { resolveAssetPaths } from "../../config/asset-paths.js";

import { loadHooksFromDir } from "../../hooks/index.js";

import { type CommandContext, type CommandOption, type CommandOptionsContext } from "../types.js";

function loadAllHooksFromDisk(ctx: Pick<CommandContext, "swarmflowHomeDir">): Array<{ name: string; event: string; command: string; args?: string[]; disabled?: boolean; _sourcePath?: string; _scope?: string; matcher?: { toolNames?: string[]; agentIds?: string[] }; failClosed?: boolean }> {
  try {
    const paths = resolveAssetPaths({
      homeDir: ctx.swarmflowHomeDir,
      projectPath: process.cwd(),
    });
    // loadhooksmti按名称进行重复数据删除（项目覆盖全局）
    // 我们希望所有包括禁用，所以我们从磁盘加载raw
    const allHooks: any[] = [];
    for (const { dir, scope } of paths.hookRoots) {
      for (const h of loadHooksFromDir(dir, scope as "project" | "global")) {
        allHooks.push(h);
      }
    }
    // 按名称重复数据删除（后面的作用域覆盖前面的）
    const byName = new Map<string, any>();
    for (const h of allHooks) byName.set(h.name, h);
    return [...byName.values()];
  } catch {
    return [];
  }
}

export function hooksOptions(ctx: CommandOptionsContext): CommandOption[] {
  const allHooks = loadAllHooksFromDisk(ctx);
  if (allHooks.length === 0) {
    return [{ label: "No hooks found", value: "", disabled: true }];
  }

  return allHooks.map((hook) => {
    const scope = hook._scope ?? "unknown";
    const matcherParts: string[] = [];
    if (hook.matcher?.toolNames?.length) matcherParts.push(hook.matcher.toolNames.join(","));
    if (hook.matcher?.agentIds?.length) matcherParts.push(hook.matcher.agentIds.join(","));
    const matcherSuffix = matcherParts.length ? ` [${matcherParts.join("; ")}]` : "";
    const disabledTag = hook.disabled ? " (disabled)" : "";
    return {
      label: `${hook.name}${disabledTag}`,
      detail: `${scope} · ${hook.event}${matcherSuffix}`,
      value: hook._sourcePath ?? hook.name,
    };
  });
}

export async function cmdHooks(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  const hookRuntime = session.hookRuntime;
  const hint = ctx.showHint ?? ctx.showMessage;

  if (!hookRuntime) {
    ctx.showMessage("Hook system not available.");
    return;
  }

  let action = args.trim();

  if (!action && ctx.promptCommandPicker) {
    const picked = await ctx.promptCommandPicker(
      hooksOptions({ session, store: ctx.store }),
      { title: "Hooks" },
    );
    if (!picked) return;
    action = picked.value;
  }

  if (action) {
    hint("/hooks is read-only in the first pass.");
    return;
  }

  const allHooks = loadAllHooksFromDisk(ctx);
  const activeCount = allHooks.filter((h) => !h.disabled).length;
  ctx.showMessage(allHooks.length === 0
    ? "No hooks registered."
    : `${allHooks.length} hook(s), ${activeCount} active. Hook management is read-only from /hooks.`);
}
