/** /provider 选择器选项构建。 */

import { loadGlobalSettings } from "../../config/settings/io.js";

import { PROVIDER_PRESETS } from "../../providers/presets.js";

import { buildCredentialEndpointTree } from "../../models/picker/credential-tree.js";
import { toCommandPickerOptions } from "../../models/picker/labels.js";

import { hasOAuthTokens, readOAuthAccessToken } from "../../auth/openai/token-store.js";
import { isTokenExpiring } from "../../auth/openai/jwt.js";
import { hasGitHubTokens } from "../../auth/github-copilot-oauth.js";

import { type UiText } from "../../ui/text.js";

import { providerText } from "./presentation.js";
import { WIRE_PROTOCOL_CHOICES } from "./protocol.js";
import { type CommandOption, type CommandOptionsContext } from "../types.js";

export function keyOptions(ctx: CommandOptionsContext): CommandOption[] {
  return toCommandPickerOptions(
    buildCredentialEndpointTree({ session: ctx.session }),
  ) as CommandOption[];
}

function commonProviderOptions(t: UiText): CommandOption[] {
  const providerPresetOptions = PROVIDER_PRESETS
    .filter((preset) => !preset.localServer)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((preset) => ({
      label: preset.name,
      value: preset.id,
      detail: preset.id,
    }));
  return providerPresetOptions.length > 0
    ? providerPresetOptions
    : [{ label: t.get(["Commands", "/provider", "noPresets"]), value: "", disabled: true }];
}

export function providerOptions(ctx: CommandOptionsContext, homeDir?: string): CommandOption[] {
  const t = providerText(homeDir);
  const options: CommandOption[] = [
    {
      label: t.get(["Commands", "/provider", "codexLogin"]),
      value: "__codex__",
      children: codexOptions(t).map((option) => ({ ...option, value: `codex:${option.value}` })),
    },
    {
      label: t.get(["Commands", "/provider", "copilotLogin"]),
      value: "__copilot__",
      children: copilotOptions(t).map((option) => ({ ...option, value: `copilot:${option.value}` })),
    },
    {
      label: t.get(["Commands", "/provider", "addCustom"]),
      value: "__protocol__",
      children: WIRE_PROTOCOL_CHOICES.map((p) => ({
        label: t.get(["Commands", "/provider", "protocol", p.key]),
        value: `protocol:${p.value}`,
        detail: p.detail,
      })),
    },
    {
      label: t.get(["Commands", "/provider", "common"]),
      value: "__presets__",
      children: commonProviderOptions(t),
    },
    { label: t.get(["Commands", "/provider", "manageKeys"]), value: "__keys__", children: keyOptions(ctx) },
  ];

  const settings = loadGlobalSettings(homeDir);
  const providers = settings.providers ?? {};
  const allProviders = Object.entries(providers)
    .sort(([a], [b]) => a.localeCompare(b));
  if (allProviders.length > 0) {
    options.push({
      label: t.get(["Commands", "/provider", "manageProviders"]),
      value: "__custom__",
      children: allProviders.map(([id, entry]) => ({
        label: entry.label ? `${entry.label} (${id})` : id,
        value: `manage:${id}`,
        detail: t.get(["Commands", "/provider", "modelCount"], { count: entry.models?.length ?? 0 }),
      })),
    });
  }

  return options;
}

function codexOptions(t: UiText = providerText()): CommandOption[] {
  const token = readOAuthAccessToken();
  const loggedIn = hasOAuthTokens() && token && !isTokenExpiring(token);
  const options: CommandOption[] = [];
  if (loggedIn) {
    options.push({ label: t.get(["Commands", "/provider", "oauth", "status"]), value: "status" });
    options.push({ label: t.get(["Commands", "/provider", "oauth", "logout"]), value: "logout" });
  } else {
    options.push({ label: t.get(["Commands", "/provider", "oauth", "login"]), value: "login" });
  }
  return options;
}

function copilotOptions(t: UiText = providerText()): CommandOption[] {
  const options: CommandOption[] = [];
  if (hasGitHubTokens()) {
    options.push({ label: t.get(["Commands", "/provider", "oauth", "status"]), value: "status" });
    options.push({ label: t.get(["Commands", "/provider", "oauth", "logout"]), value: "logout" });
  } else {
    options.push({ label: t.get(["Commands", "/provider", "oauth", "login"]), value: "login" });
  }
  return options;
}
