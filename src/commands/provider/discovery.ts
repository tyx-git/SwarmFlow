/** 本地提供商的模型发现与录入。 */

import type { ProviderEntry } from "../../config/settings/types.js";

import { loadGlobalSettings } from "../../config/settings/io.js";

import { fetchModelsFromServer } from "../../models/discovery.js";

import { findProviderPreset } from "../../providers/presets.js";
import { runtimeModelName } from "../../models/selection.js";

import { persistModelSelection, promptThinkingLevel } from "../model/persistence.js";
import { normalizeEndpointUrl } from "./endpoint.js";
import { providerText } from "./presentation.js";
import { persistSettingsPatch } from "../settings-patch.js";
import { type CommandContext } from "../types.js";

/**
 * Local provider discovery sub-flow for /model.
 * Scans the server, lets user pick a model, registers it, and switches.
 */
export async function cmdModelLocalDiscover(ctx: CommandContext, providerId: string): Promise<void> {
  const t = providerText(ctx.swarmflowHomeDir);
  const session = ctx.session;
  const preset = findProviderPreset(providerId);
  if (!preset?.localServer) {
    ctx.showMessage(t.get(["Commands", "/provider", "local", "notLocal"], { provider: providerId }));
    return;
  }
  if (!ctx.promptSelect) {
    ctx.showMessage(t.get(["Commands", "/provider", "custom", "notAvailable"]));
    return;
  }

  const defaultUrl = preset.defaultBaseUrl ?? "http://localhost:11434/v1";

  // 让用户确认或更改URL
  const urlChoice = await ctx.promptSelect({
    message: t.get(["Commands", "/provider", "local", "serverUrl"], { provider: preset.name }),
    options: [
      { label: t.get(["Commands", "/provider", "local", "useDefault"], { url: defaultUrl }), value: defaultUrl },
      { label: t.get(["Commands", "/provider", "local", "customUrl"]), value: "__custom__" },
    ],
  });
  if (!urlChoice) return;

  let baseUrl = normalizeEndpointUrl(urlChoice, "openai-chat").baseUrl;
  if (urlChoice === "__custom__") {
    const custom = await ctx.promptSecret?.({
        message: t.get(["Commands", "/provider", "local", "enterUrl"], { provider: preset.name }),
    });
    if (!custom?.trim()) return;
    baseUrl = normalizeEndpointUrl(custom, "openai-chat").baseUrl;
  }

  // 发现模型——先不带钥匙试一试，然后再问是否需要
  ctx.showMessage(t.get(["Commands", "/provider", "local", "scan"], { url: baseUrl }));
  let apiKey = "local";
  let discovered = await fetchModelsFromServer(baseUrl, 5000, apiKey);
  if (discovered.length === 0) {
    // 可能是一个验证问题-要求API密钥
    const keyInput = await ctx.promptSecret?.({
      message: t.get(["Commands", "/provider", "local", "apiKey"], { provider: preset.name }),
      allowEmpty: true,
    });
    if (keyInput?.trim()) {
      apiKey = keyInput.trim();
      discovered = await fetchModelsFromServer(baseUrl, 5000, apiKey);
    }
  }
  if (discovered.length === 0) {
    ctx.showMessage(
      t.get(["Commands", "/provider", "local", "noneFound"], { url: baseUrl }),
    );
    return;
  }

  // 让用户选择一个模型
  const modelChoice = await ctx.promptSelect({
    message: t.get(["Commands", "/provider", "local", "found"], { provider: preset.name, count: discovered.length }),
    options: discovered.map((m) => ({
      label: m.contextLength
        ? `${m.id} (${Math.round(m.contextLength / 1024)}K ctx)`
        : m.id,
      value: m.id,
    })),
  });
  if (!modelChoice) return;

  let contextLength = discovered.find((m) => m.id === modelChoice)?.contextLength;
  if (!contextLength) {
    // 大多数本地服务器不会通过/v1/models报告上下文长度。
    // 提示用户指定它（与init向导相同）。
    const ctxChoice = await ctx.promptSelect({
      message: t.get(["Commands", "/provider", "local", "contextUnknown"], { provider: preset.name }),
      options: [
        { label: "8K", value: "8192" },
        { label: "32K", value: "32768" },
        { label: "64K", value: "65536" },
        { label: "128K", value: "131072" },
        { label: t.get(["Commands", "/provider", "local", "enterContext"]), value: "__custom__" },
      ],
    });
    if (!ctxChoice) return;
    if (ctxChoice === "__custom__") {
      const ctxInput = await ctx.promptSecret?.({
        message: t.get(["Commands", "/provider", "local", "contextTokens"], { provider: preset.name }),
      });
      contextLength = parseInt(ctxInput ?? "", 10) || 32768;
    } else {
      contextLength = parseInt(ctxChoice, 10);
    }
  }

  // 在配置中注册模型
  const config = session.config;
  const rtName = runtimeModelName(providerId, modelChoice);
  config.upsertModelRaw(rtName, {
    provider: providerId,
    model: modelChoice,
    api_key: apiKey,
    base_url: baseUrl,
    context_length: contextLength,
    supports_web_search: false,
  });

  // 将本地提供程序配置保存到设置中。Json，以便它在重启中幸存下来
  {
    const existing = loadGlobalSettings(ctx.swarmflowHomeDir);
    const providerEntry: ProviderEntry = {
      base_url: baseUrl,
      model: modelChoice,
      context_length: contextLength,
    };
    if (apiKey !== "local") providerEntry.api_key = apiKey;
    persistSettingsPatch({
      providers: {
        ...(existing.providers ?? {}),
        [providerId]: providerEntry,
      },
    }, ctx.swarmflowHomeDir);
  }

  // 切换到新的模型。
  session.switchModel(rtName);
  session.setPersistedModelSelection?.({
    modelConfigName: rtName,
    modelProvider: providerId,
    modelSelectionKey: modelChoice,
    modelId: modelChoice,
  });

  // 如果新模型支持它，提示思考水平
  await promptThinkingLevel(ctx);
  persistModelSelection(ctx);
  ctx.autoSave();

}

// ------------------------------------------------------------------
// "添加自定义提供商…"-任意多页向导
// OpenAI / anthropic兼容端点与一个或多个模型。
// ------------------------------------------------------------------
