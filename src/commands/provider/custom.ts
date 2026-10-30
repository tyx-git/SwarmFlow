/** 自定义提供商的新增/管理交互流程（含模型批量录入）。 */

import type { ProviderEntry, CustomModelEntry } from "../../config/settings/types.js";

import { loadGlobalSettings } from "../../config/settings/io.js";

import { setDotenvKey } from "../../lifecycle/dotenv.js";
import { fetchModelsFromServer } from "../../models/discovery.js";

import { customProviderEnvVar } from "../../providers/credential-flow.js";

import { type UiText } from "../../ui/text.js";

import {
  fmtTokens,
  normalizeEndpointUrl,
  registerCustomModel,
  resolveUniqueProviderId,
  slugifyProviderId,
  testEndpoint,
} from "./endpoint.js";
import { appendProviderSwitchEcho, providerText } from "./presentation.js";
import {
  type ProviderWireProtocol,
  type StoredProviderProtocol,
  WIRE_PROTOCOL_CHOICES,
  canDiscoverModels,
  storedProtocolFromWire,
  wireProtocolFromStored,
} from "./protocol.js";
import { persistSettingsPatch } from "../settings-patch.js";
import { type CommandContext, type CommandOption } from "../types.js";

/* 提示 token 数：可选建议值 + 常用预设 + 自定义输入。 */
async function promptTokenCount(
  ctx: CommandContext,
  message: string,
  suggested: number | undefined,
  opts: { allowSkip?: boolean },
  t: UiText,
): Promise<number | undefined> {
  const choices: CommandOption[] = [];
  if (suggested && suggested > 0) choices.push({ label: `${fmtTokens(suggested)}  (${t.language === "zh" ? "接口返回" : "reported by endpoint"})`, value: String(suggested) });
  if (opts.allowSkip) choices.push({ label: t.language === "zh" ? "使用默认值（跳过）" : "Use default (skip)", value: "__skip__" });
  for (const v of [8192, 32768, 65536, 131072, 200000, 1_000_000]) {
    if (v !== suggested) choices.push({ label: fmtTokens(v), value: String(v) });
  }
  choices.push({ label: t.get(["Commands", "/provider", "custom", "enterCustom"]), value: "__custom__" });
  const c = await ctx.promptSelect!({ message, options: choices });
  if (!c || c === "__skip__") return undefined;
  if (c === "__custom__") {
    const inp = (await ctx.promptSecret!({ message: t.get(["Commands", "/provider", "custom", "tokenCount"]) }))?.trim();
    const n = parseInt(inp ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  return parseInt(c, 10);
}

/**
 * 发现模型（/v1/models）并循环添加多个模型。返回已添加的模型，
 * 用户取消时返回 null。新增供应商向导与"添加模型"管理操作共用；
 * 每加完一个模型不退出。
 */
async function addModelsInteractive(
  ctx: CommandContext,
  opts: { label: string; baseUrl: string; protocol: string; apiKey?: string; existingIds?: Set<string> },
): Promise<CustomModelEntry[] | null> {
  const { label, baseUrl, protocol, apiKey } = opts;
  const t = providerText(ctx.swarmflowHomeDir);
  let discovered: Array<{ id: string; contextLength?: number }> = [];
  if (canDiscoverModels(protocol)) {
    ctx.showMessage(t.get(["Commands", "/provider", "custom", "scan"], { baseUrl }));
    discovered = await fetchModelsFromServer(baseUrl, 6000, apiKey || "local");
  }
  const added: CustomModelEntry[] = [];
  const addedIds = new Set<string>(opts.existingIds ?? []);
  while (true) {
    const remaining = discovered.filter((d) => !addedIds.has(d.id));
    const choices: CommandOption[] = [];
    for (const d of remaining) {
      choices.push({ label: d.contextLength
        ? `${d.id}  (${fmtTokens(d.contextLength)} ${t.get(["Commands", "/provider", "custom", "contextSuffix"])})`
        : d.id, value: `pick:${d.id}` });
    }
    choices.push({ label: t.get(["Commands", "/provider", "custom", "manualModel"]), value: "__manual__" });
    if (added.length > 0) choices.push({ label: t.get(["Commands", "/provider", "custom", "done"], { count: added.length }), value: "__done__" });
    choices.push({ label: added.length > 0
      ? t.get(["Commands", "/provider", "custom", "cancel"])
      : t.get(["Commands", "/provider", "custom", "cancelShort"]), value: "__cancel__" });
    const choice = await ctx.promptSelect!({
      message: discovered.length
        ? t.get(["Commands", "/provider", "custom", "pickModel"], { label, count: remaining.length })
        : t.get(["Commands", "/provider", "custom", "addModel"], { label }),
      options: choices,
    });
    if (!choice || choice === "__cancel__") return null;
    if (choice === "__done__") return added;
    const modelId = choice === "__manual__"
      ? ((await ctx.promptSecret!({ message: t.get(["Commands", "/provider", "custom", "modelId"], { label }) }))?.trim() ?? "")
      : choice.slice("pick:".length);
    if (!modelId || addedIds.has(modelId)) continue;
    const reportedCtx = discovered.find((d) => d.id === modelId)?.contextLength;
    const ctxLen = await promptTokenCount(
      ctx,
      t.get(["Commands", "/provider", "custom", "contextLength"], { label, model: modelId }),
      reportedCtx,
      { allowSkip: false },
      t,
    );
    if (!ctxLen) { ctx.showMessage(t.get(["Commands", "/provider", "custom", "contextLengthMissing"])); continue; }
    const mmChoice = await ctx.promptSelect!({
      message: t.get(["Commands", "/provider", "custom", "multimodal"], { label, model: modelId }),
      options: [
        { label: t.get(["Commands", "/provider", "custom", "no"]), value: "no" },
        { label: t.get(["Commands", "/provider", "custom", "yes"]), value: "yes" },
      ],
    });
    if (mmChoice === undefined) continue;
    const maxOut = await promptTokenCount(
      ctx,
      t.get(["Commands", "/provider", "custom", "maxOutput"], { label, model: modelId }),
      undefined,
      { allowSkip: true },
      t,
    );
    const entry: CustomModelEntry = { id: modelId, context_length: ctxLen };
    if (mmChoice === "yes") entry.multimodal = true;
    if (maxOut) entry.max_output_tokens = maxOut;
    added.push(entry);
    addedIds.add(modelId);
  }
}

export async function cmdAddCustomProvider(ctx: CommandContext, initialProtocol?: ProviderWireProtocol): Promise<boolean> {
  const t = providerText(ctx.swarmflowHomeDir);
  if (!ctx.promptSecret || !ctx.promptSelect) {
    ctx.showMessage(t.get(["Commands", "/provider", "custom", "notAvailable"]));
    return false;
  }
  const config = ctx.session.config;

  // 1. 显示名称→唯一提供者id
  const label = (await ctx.promptSecret({ message: t.get(["Commands", "/provider", "custom", "displayName"]) }))?.trim();
  if (!label) return false;
  const existingProviders = loadGlobalSettings(ctx.swarmflowHomeDir).providers ?? {};
  const providerId = resolveUniqueProviderId(
    slugifyProviderId(label),
    (id) => Boolean(existingProviders[id])
      || config.modelNames.some((m: string) => m.startsWith(id + ":")),
  );

  // 2. 先确定协议，再按协议解释和规范化用户输入的 URL。
  let protocol: StoredProviderProtocol | undefined;
  if (initialProtocol) {
    protocol = storedProtocolFromWire(initialProtocol);
  } else {
    const picked = await ctx.promptSelect({
      message: t.get(["Commands", "/provider", "custom", "protocol"], { label }),
      options: WIRE_PROTOCOL_CHOICES.map((choice) => ({
        label: t.get(["Commands", "/provider", "protocol", choice.key]),
        value: choice.value,
      })),
    });
    if (!picked) return false;
    protocol = storedProtocolFromWire(picked as ProviderWireProtocol);
  }
  if (!protocol) return false;
  const protocolChoice = WIRE_PROTOCOL_CHOICES.find((choice) => choice.stored === protocol)!;

  // 3. 接口地址：接受完整端点或 base URL，并保存为所选协议需要的 base URL。
  const rawUrl = (await ctx.promptSecret({
    message: t.get(["Commands", "/provider", "custom", "endpoint"], {
      label,
      protocol: t.get(["Commands", "/provider", "protocol", protocolChoice.key]),
    }),
  }))?.trim();
  if (!rawUrl) return false;
  const norm = normalizeEndpointUrl(rawUrl, protocol);
  const baseUrl = norm.baseUrl;
  if (norm.changed) ctx.showMessage(t.get(["Commands", "/provider", "custom", "usingBaseUrl"], { baseUrl }));

  // 4. API密钥（可选）
  const apiKey = (await ctx.promptSecret({ message: t.get(["Commands", "/provider", "custom", "apiKey"], { label }), allowEmpty: true }))?.trim();

  // 5–6. 发现并添加模型（多模型循环，添加一个后不关闭）。
  const added = await addModelsInteractive(ctx, { label, baseUrl, protocol, apiKey });
  if (!added || added.length === 0) return false;

  // 7. 保留到设置。Json +注册在运行时配置
  const entry: ProviderEntry = { custom: true, label, base_url: baseUrl, protocol: protocol as ProviderEntry["protocol"], models: added };
  let apiKeyRef = "local";
  if (apiKey) {
    const envVar = customProviderEnvVar(providerId);
    setDotenvKey(envVar, apiKey, ctx.swarmflowHomeDir);
    entry.api_key = `\${${envVar}}`;
    apiKeyRef = `\${${envVar}}`;
  }
  const cur = loadGlobalSettings(ctx.swarmflowHomeDir);
  persistSettingsPatch({ providers: { ...(cur.providers ?? {}), [providerId]: entry } }, ctx.swarmflowHomeDir);

  for (const m of added) registerCustomModel(config, providerId, baseUrl, protocol, apiKeyRef, m);
  appendProviderSwitchEcho(ctx, t.get(["Commands", "/provider", "custom", "addedProvider"], { label, count: added.length }));
  return true;
}

/* 管理一个现有的自定义提供者：添加/删除模型，删除提供者。 */
export async function cmdManageCustomProvider(ctx: CommandContext, providerId: string): Promise<void> {
  const t = providerText(ctx.swarmflowHomeDir);
  if (!ctx.promptSelect) { ctx.showMessage(t.get(["Commands", "/provider", "custom", "notAvailable"])); return; }
  const config = ctx.session.config;
  const settings = loadGlobalSettings(ctx.swarmflowHomeDir);
  const entry = settings.providers?.[providerId];
  if (!entry) { ctx.showMessage(t.get(["Commands", "/provider", "manage", "notFound"], { provider: providerId })); return; }
  const label = entry.label ?? providerId;
  const models = entry.models ?? [];

  const action = await ctx.promptSelect({
    message: t.get(["Commands", "/provider", "manage", "title"], { label, count: models.length }),
    options: [
      { label: t.get(["Commands", "/provider", "manage", "add"]), value: "add" },
      { label: t.get(["Commands", "/provider", "manage", "edit"]), value: "edit" },
      { label: t.get(["Commands", "/provider", "manage", "remove"]), value: "rm" },
      { label: t.get(["Commands", "/provider", "manage", "delete"]), value: "del" },
      { label: t.get(["Commands", "/provider", "manage", "cancel"]), value: "cancel" },
    ],
  });
  if (!action || action === "cancel") return;

  const protocol = entry.protocol ?? "openai-chat";
  const apiKeyRef = entry.api_key ?? "local";
  const apiKeyForDiscover = apiKeyRef.startsWith("${") ? process.env[apiKeyRef.slice(2, -1)] : apiKeyRef;
  const saveProviders = (next: Record<string, ProviderEntry>) =>
    persistSettingsPatch({ providers: next }, ctx.swarmflowHomeDir);

  if (action === "edit") {
    const protocolChoice = WIRE_PROTOCOL_CHOICES.find((choice) => choice.value === wireProtocolFromStored(protocol))!;
    const newUrl = (await ctx.promptSecret!({
      message: t.get(["Commands", "/provider", "manage", "newEndpoint"], {
        label,
        current: normalizeEndpointUrl(entry.base_url ?? "", protocol).baseUrl,
        protocol: t.get(["Commands", "/provider", "protocol", protocolChoice.key]),
      }),
      allowEmpty: true,
    }))?.trim();
    const newKey = (await ctx.promptSecret!({ message: t.get(["Commands", "/provider", "manage", "newApiKey"], { label }), allowEmpty: true }))?.trim();
    const retainedUrl = newUrl || entry.base_url || "";
    const norm = normalizeEndpointUrl(retainedUrl, protocol);
    const newBaseUrl = norm.baseUrl;
    if (norm.changed) ctx.showMessage(t.get(["Commands", "/provider", "custom", "usingBaseUrl"], { baseUrl: newBaseUrl }));
    let apiKeyField = entry.api_key;
    if (newKey) {
      const envVar = customProviderEnvVar(providerId);
      setDotenvKey(envVar, newKey, ctx.swarmflowHomeDir);
      apiKeyField = `\${${envVar}}`;
    }
    const updated: ProviderEntry = { ...entry, base_url: newBaseUrl, ...(apiKeyField ? { api_key: apiKeyField } : {}) };
    saveProviders({ ...settings.providers, [providerId]: updated });
    const ref = apiKeyField ?? "local";
    for (const m of models) registerCustomModel(config, providerId, newBaseUrl, protocol, ref, m);
    const probeKey = newKey || (apiKeyField?.startsWith("${") ? process.env[apiKeyField.slice(2, -1)] : apiKeyField);
    const probe = await testEndpoint(newBaseUrl, probeKey, protocol, t);
    ctx.showMessage(t.get(["Commands", "/provider", "manage", "updated"], {
      label,
      detail: probe.ok
        ? t.get(["Commands", "/provider", "custom", "endpointReachable"], { detail: probe.detail })
        : t.get(["Commands", "/provider", "custom", "endpointUnavailable"], { detail: probe.detail }),
    }));
    return;
  }

  if (action === "add") {
    const existingIds = new Set(models.map((m) => m.id));
    const baseUrl = normalizeEndpointUrl(entry.base_url ?? "", protocol).baseUrl;
    const newModels = await addModelsInteractive(ctx, {
      label, baseUrl, protocol, apiKey: apiKeyForDiscover, existingIds,
    });
    if (!newModels || newModels.length === 0) return;
    const merged = [...models, ...newModels];
    saveProviders({ ...settings.providers, [providerId]: { ...entry, models: merged } });
    for (const m of newModels) registerCustomModel(config, providerId, baseUrl, protocol, apiKeyRef, m);
    ctx.showMessage(t.get(["Commands", "/provider", "manage", "addResult"], { count: newModels.length, label }));
    return;
  }

  if (action === "rm") {
    if (models.length === 0) { ctx.showMessage(t.get(["Commands", "/provider", "manage", "noneToRemove"])); return; }
    const pick = await ctx.promptSelect({
      message: t.get(["Commands", "/provider", "manage", "removeWhich"], { label }),
      options: models.map((m) => ({ label: m.id, value: m.id })),
    });
    if (!pick) return;
    const kept = models.filter((m) => m.id !== pick);
    if (kept.length === 0) {
      // 删除最后一个模型将删除提供程序
      const next = { ...settings.providers }; delete next[providerId];
      saveProviders(next);
    } else {
      saveProviders({ ...settings.providers, [providerId]: { ...entry, models: kept } });
    }
    config.removeModel?.(`${providerId}:${pick}`);
    ctx.showMessage(t.get(["Commands", "/provider", "manage", "removed"], {
      model: pick,
      extra: kept.length === 0 ? t.get(["Commands", "/provider", "manage", "deletedEmpty"], { label }) : "",
    }) + (t.language === "zh" ? "。" : "."));
    return;
  }

  if (action === "del") {
    const confirm = await ctx.promptSelect({
      message: t.get(["Commands", "/provider", "manage", "deleteConfirm"], { label, count: models.length }),
      options: [
        { label: t.get(["Commands", "/provider", "manage", "yesDelete"]), value: "yes" },
        { label: t.get(["Commands", "/provider", "manage", "noKeep"]), value: "no" },
      ],
    });
    if (confirm !== "yes") return;
    const next = { ...settings.providers }; delete next[providerId];
    saveProviders(next);
    for (const m of models) config.removeModel?.(`${providerId}:${m.id}`);
    ctx.showMessage(t.get(["Commands", "/provider", "manage", "deleted"]));
  }
}

// ------------------------------------------------------------------
// /diff -配置内联写入/编辑diff显示
// ------------------------------------------------------------------
