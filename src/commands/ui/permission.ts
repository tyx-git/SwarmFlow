/** /permission 权限模式设置与持久化。 */

import { join } from "node:path";

import { createUiText, getUiLanguage, type UiText } from "../../ui/text.js";

import { persistSettingsPatch } from "../settings-patch.js";
import { type CommandContext, type CommandOption, type CommandOptionsContext } from "../types.js";

const PERMISSION_MODES = ["read_only", "reversible", "yolo"] as const;

function permissionText(homeDir?: string): UiText {
  return createUiText(getUiLanguage(homeDir));
}

function permissionLabel(mode: typeof PERMISSION_MODES[number], t: UiText): string {
  const key = mode === "read_only" ? "readOnly" : mode === "reversible" ? "autoApprove" : "fullAccess";
  return t.get(["Commands", "/permission", key]);
}

function permissionDescription(mode: typeof PERMISSION_MODES[number], t: UiText): string {
  const key = mode === "read_only" ? "readOnlyDescription" : mode === "reversible" ? "autoApproveDescription" : "fullAccessDescription";
  return t.get(["Commands", "/permission", key]);
}

export function permissionOptions(ctx: CommandOptionsContext): CommandOption[] {
  const session = ctx.session;
  const t = permissionText();
  const current = typeof session.permissionMode === "string" ? session.permissionMode : "reversible";
  return PERMISSION_MODES.map((mode) => ({
    label: `${permissionLabel(mode, t)}${mode === current ? ` (${t.get(["Common", "current"])})` : ""} — ${permissionDescription(mode, t)}`,
    value: mode,
  }));
}

export async function cmdPermission(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  const t = permissionText(ctx.swarmflowHomeDir);
  let mode = args.trim().toLowerCase();

  if (!mode) {
    if (ctx.promptCommandPicker) {
      const picked = await ctx.promptCommandPicker(permissionOptions({ session, store: ctx.store }));
      if (!picked) return;
      mode = picked.value;
    } else {
      const current = session.permissionMode ?? "reversible";
      ctx.showMessage(
        t.get(["Commands", "/permission", "current"], { mode: permissionLabel(current as typeof PERMISSION_MODES[number], t) }) + "\n\n" +
        t.get(["Commands", "/permission", "usage"], { mode: `${permissionLabel("read_only", t)} | ${permissionLabel("reversible", t)} | ${permissionLabel("yolo", t)}` }) + "\n" +
        PERMISSION_MODES.map((m) => `  ${permissionLabel(m, t)} — ${permissionDescription(m, t)}`).join("\n"),
      );
      return;
    }
  }

  if (!PERMISSION_MODES.includes(mode as any)) {
    ctx.showMessage(t.get(["Commands", "/permission", "invalid"], {
      mode,
      modes: PERMISSION_MODES.map((item) => permissionLabel(item, t)).join(", "),
    }));
    return;
  }

  session.permissionMode = mode;
  persistPermissionMode(ctx);
  if (ctx.appendSwitchCommandEcho) {
    ctx.appendSwitchCommandEcho("/permission", mode);
  } else {
    ctx.showMessage(`${t.get(["Commands", "/permission", "echo"])}: ${permissionLabel(mode as typeof PERMISSION_MODES[number], t)}`);
  }
}

function persistPermissionMode(ctx: CommandContext): void {
  try {
    const session = ctx.session;
    if (typeof session.permissionMode !== "string") return;
    persistSettingsPatch({ permission_mode: session.permissionMode }, ctx.swarmflowHomeDir);
  } catch {
    // 忽略持久性失败。
  }
}

// ------------------------------------------------------------------
// /rewind -倒回到前一个回合
// ------------------------------------------------------------------
