/** /provider 命令入口分流。 */

import { cmdKey } from "./credentials.js";
import { cmdAddCustomProvider, cmdManageCustomProvider } from "./custom.js";
import { cmdCodex, cmdCopilot } from "./oauth.js";
import { providerOptions } from "./options.js";
import { providerText } from "./presentation.js";
import { type ProviderWireProtocol } from "./protocol.js";
import { type CommandContext } from "../types.js";

export async function cmdProvider(ctx: CommandContext, args: string): Promise<void> {
  const t = providerText(ctx.swarmflowHomeDir);
  if (!ctx.promptCommandPicker) {
    ctx.showMessage(t.get(["Commands", "/provider", "unavailable"]));
    return;
  }

  let action = args.trim();
  if (!action) {
    const picked = await ctx.promptCommandPicker(
      providerOptions({ session: ctx.session, store: ctx.store }, ctx.swarmflowHomeDir),
      { title: t.get(["Commands", "/provider", "title"]) },
    );
    if (!picked) return;
    action = picked.value;
  }

  if (action === "__add_provider__") {
    await cmdAddCustomProvider(ctx);
    return;
  }

  if (action.startsWith("protocol:")) {
    await cmdAddCustomProvider(ctx, action.slice("protocol:".length) as ProviderWireProtocol);
    return;
  }

  if (action.startsWith("preset:")) {
    await cmdKey(ctx, action.slice("preset:".length));
    return;
  }

  if (action.startsWith("manage:")) {
    await cmdManageCustomProvider(ctx, action.slice("manage:".length));
    return;
  }

  if (action === "__keys__") {
    await cmdKey(ctx, "");
    return;
  }

  if (action === "__codex__") {
    await cmdCodex(ctx, "");
    return;
  }

  if (action === "__copilot__") {
    await cmdCopilot(ctx, "");
    return;
  }

  if (action.startsWith("codex:")) {
    await cmdCodex(ctx, action.slice("codex:".length));
    return;
  }

  if (action.startsWith("copilot:")) {
    await cmdCopilot(ctx, action.slice("copilot:".length));
    return;
  }

  if (action && !action.startsWith("__")) {
    await cmdKey(ctx, action);
    return;
  }

  ctx.showMessage(t.get(["Commands", "/provider", "invalidAction"]));
}
