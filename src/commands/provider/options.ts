/** /provider 选择器选项构建。 */

import { loadGlobalSettings } from "../../config/settings/io.js";

import { PROVIDER_PRESETS, type ProviderPreset } from "../../providers/presets.js";

import { buildCredentialEndpointTree } from "../../models/picker/credential-tree.js";
import { toCommandPickerOptions } from "../../models/picker/labels.js";
import { hasEnvApiKey, readModelEntries } from "../../models/selection.js";

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

function isCodexLoggedIn(): boolean {
  try {
    const token = readOAuthAccessToken();
    if (!hasOAuthTokens() || !token) return false;
    return !isTokenExpiring(token);
  } catch {
    return false;
  }
}

function isCopilotLoggedIn(): boolean {
  try {
    return hasGitHubTokens();
  } catch {
    return false;
  }
}

/** 配置里已解析出密钥的 provider 集合；与 /model 树的凭据判定同源。 */
function configuredEntryProviders(ctx: CommandOptionsContext): Set<string> {
  const config = (ctx.session as { config?: unknown } | undefined)?.config;
  if (!config) return new Set<string>();
  const ids = new Set<string>();
  for (const entry of readModelEntries(config)) {
    if (entry.provider && entry.hasResolvedApiKey && entry.apiKeyRaw?.trim() !== "") ids.add(entry.provider);
  }
  return ids;
}

/** 当前主模型落在哪个 provider 上；用于把那一行标成“使用中”。 */
function currentProviderId(ctx: CommandOptionsContext): string {
  const provider = ctx.session?.primaryAgent?.modelConfig?.provider;
  return typeof provider === "string" ? provider : "";
}

/**
 * 常用供应商：按品牌家族分节，节内用注册表已有的 `subLabel` 短名。
 *
 * 节标题行同时置 `section` + `disabled`，选择器状态机靠 disabled 跳过它；
 * 只有整节同属一个 `group` id 时才上色标，混牌的独立供应商节留中性色。
 */
function presetPickerOptions(t: UiText, ctx: CommandOptionsContext): CommandOption[] {
  const presets = PROVIDER_PRESETS
    .filter((preset) => !preset.localServer)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (presets.length === 0) {
    return [{ label: t.get(["Commands", "/provider", "noPresets"]), value: "", disabled: true }];
  }

  const standalone = t.get(["Commands", "/provider", "groupStandalone"]);
  const buckets = new Map<string, ProviderPreset[]>();
  for (const preset of presets) {
    const key = preset.groupLabel ?? standalone;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(preset);
    else buckets.set(key, [preset]);
  }

  const familyKeys = [...buckets.keys()]
    .filter((key) => key !== standalone)
    .sort((a, b) => a.localeCompare(b));
  const orderedKeys = buckets.has(standalone) ? [...familyKeys, standalone] : familyKeys;

  const configured = configuredEntryProviders(ctx);
  const liveProvider = currentProviderId(ctx);
  const options: CommandOption[] = [];
  for (const key of orderedKeys) {
    const members = buckets.get(key) ?? [];
    const group = members[0]?.group;
    const sharedGroup = group && members.every((member) => member.group === group) ? group : undefined;
    options.push({
      label: key,
      value: "",
      disabled: true,
      section: true,
      spine: sharedGroup,
      detail: t.get(["Commands", "/provider", "presetCount"], { count: members.length }),
    });
    for (const preset of members) {
      const live = Boolean(liveProvider) && preset.id === liveProvider;
      const ready = live
        || (preset.id === "openai-codex" ? isCodexLoggedIn()
          : preset.id === "copilot" ? isCopilotLoggedIn()
            : hasEnvApiKey(preset.envVar) || configured.has(preset.id));
      options.push({
        label: preset.subLabel ?? preset.name,
        value: preset.id,
        detail: preset.id,
        spine: preset.id,
        status: {
          text: live ? t.get(["Commands", "/provider", "stateLive"])
            : ready ? t.get(["Commands", "/provider", "stateConfigured"])
              : t.get(["Commands", "/provider", "stateMissing"]),
          tone: live ? "live" : ready ? "ok" : "off",
        },
      });
    }
  }
  return options;
}

export function providerOptions(ctx: CommandOptionsContext, homeDir?: string): CommandOption[] {
  const t = providerText(homeDir);
  const codexLoggedIn = isCodexLoggedIn();
  const copilotLoggedIn = isCopilotLoggedIn();
  const presetCount = PROVIDER_PRESETS.filter((preset) => !preset.localServer).length;
  const options: CommandOption[] = [
    {
      label: t.get(["Commands", "/provider", "codexLogin"]),
      value: "__codex__",
      spine: "openai-codex",
      status: {
        text: t.get(["Commands", "/provider", codexLoggedIn ? "stateLoggedIn" : "stateLoggedOut"]),
        tone: codexLoggedIn ? "ok" : "off",
      },
      children: codexOptions(t, codexLoggedIn).map((option) => ({ ...option, value: `codex:${option.value}` })),
    },
    {
      label: t.get(["Commands", "/provider", "copilotLogin"]),
      value: "__copilot__",
      spine: "copilot",
      status: {
        text: t.get(["Commands", "/provider", copilotLoggedIn ? "stateLoggedIn" : "stateLoggedOut"]),
        tone: copilotLoggedIn ? "ok" : "off",
      },
      children: copilotOptions(t, copilotLoggedIn).map((option) => ({ ...option, value: `copilot:${option.value}` })),
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
      detail: t.get(["Commands", "/provider", "presetCount"], { count: presetCount }),
      children: presetPickerOptions(t, ctx),
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
        label: entry.label && entry.label !== id ? `${entry.label} (${id})` : (entry.label || id),
        value: `manage:${id}`,
        detail: t.get(["Commands", "/provider", "modelCount"], { count: entry.models?.length ?? 0 }),
        spine: id,
      })),
    });
  }

  return options;
}

function codexOptions(t: UiText = providerText(), loggedIn = isCodexLoggedIn()): CommandOption[] {
  const options: CommandOption[] = [];
  if (loggedIn) {
    options.push({ label: t.get(["Commands", "/provider", "oauth", "status"]), value: "status" });
    options.push({ label: t.get(["Commands", "/provider", "oauth", "logout"]), value: "logout" });
  } else {
    options.push({ label: t.get(["Commands", "/provider", "oauth", "login"]), value: "login" });
  }
  return options;
}

function copilotOptions(t: UiText = providerText(), loggedIn = isCopilotLoggedIn()): CommandOption[] {
  const options: CommandOption[] = [];
  if (loggedIn) {
    options.push({ label: t.get(["Commands", "/provider", "oauth", "status"]), value: "status" });
    options.push({ label: t.get(["Commands", "/provider", "oauth", "logout"]), value: "logout" });
  } else {
    options.push({ label: t.get(["Commands", "/provider", "oauth", "login"]), value: "login" });
  }
  return options;
}
