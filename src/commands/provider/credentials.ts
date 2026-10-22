/** 提供商 API Key 凭据的选择与写入。 */

import { loadGlobalSettings } from "../../config/settings/io.js";

import { runCredentialManageFlow, type CredentialPromptAdapter } from "../../providers/credential-flow.js";

import { keyOptions } from "./options.js";
import { providerText } from "./presentation.js";
import { type CommandContext } from "../types.js";

export function createCommandPromptAdapter(ctx: CommandContext): CredentialPromptAdapter | null {
  if (!ctx.promptSelect || !ctx.promptSecret) return null;
  return {
    select: (request) => ctx.promptSelect!(request),
    secret: (request) => ctx.promptSecret!(request),
  };
}

/* 在提供程序的键更改后重新解析运行时模型配置。 */
function applyCredentialChange(ctx: CommandContext, providerId: string): void {
  ctx.session.config?.invalidateModelsByProvider?.(providerId);
  if (ctx.session.primaryAgent?.modelConfig?.provider === providerId) {
    ctx.session.reloadCurrentModelConfig?.();
  }
  ctx.autoSave();
}

/**
 * Provider 子流程：替换、删除或导入提供商 API key。
 * OAuth 和本地 provider 由同一个 /provider 入口管理。
 */
export async function cmdKey(ctx: CommandContext, args: string): Promise<void> {
  const t = providerText(ctx.swarmflowHomeDir);
  const adapter = createCommandPromptAdapter(ctx);
  if (!adapter || !ctx.promptCommandPicker) {
    ctx.showMessage(t.get(["Commands", "/provider", "credential", "unavailable"]));
    return;
  }

  let providerId = args.trim();
  if (!providerId) {
    const picked = await ctx.promptCommandPicker(
      keyOptions({ session: ctx.session, store: ctx.store }),
      { title: t.get(["Commands", "/provider", "credential", "title"]) },
    );
    providerId = picked?.value ?? "";
    if (!providerId) {
      ctx.showMessage(t.get(["Commands", "/provider", "credential", "cancel"]));
      return;
    }
  }

  const settings = loadGlobalSettings(ctx.swarmflowHomeDir);
  const label = settings.providers?.[providerId]?.label;

  try {
    const result = await runCredentialManageFlow(providerId, adapter, {
      homeDir: ctx.swarmflowHomeDir,
      label,
    });

    if (result.status === "skipped") {
      ctx.showMessage(t.get(["Commands", "/provider", "credential", "noChanges"]));
      return;
    }

    applyCredentialChange(ctx, providerId);

    if (result.status === "removed") {
      let msg = t.get(["Commands", "/provider", "credential", "removed"], { label: result.label });
      if (result.shellMayResurface) {
        msg += `\n${t.get(["Commands", "/provider", "credential", "removedNote"], { envVar: result.envVar })}`;
      }
      ctx.showMessage(msg);
    } else {
      ctx.showMessage(result.source === "imported"
        ? t.get(["Commands", "/provider", "credential", "imported"], { label: result.label })
        : t.get(["Commands", "/provider", "credential", "updated"], { label: result.label }));
    }
  } catch (e) {
    ctx.showMessage(t.get(["Commands", "/provider", "credential", "failed"], { message: e instanceof Error ? e.message : String(e) }));
  }
}
