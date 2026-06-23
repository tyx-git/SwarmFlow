/**
 * 提供者工厂 — 将提供者标识符映射到具体提供者类。
 *
 * 分派是数据驱动的：provider id → providerClass（来自提供者
 * 注册表）→ 构造函数。少数有效的非预设 id（openai-chat，
 * kimi-ai 别名）在此保留显式类映射。
 */

import type { ModelConfig } from "../config/config.js";
import { type ProviderClassKind } from "../models/registry.js";
import { EFFECTIVE_PROVIDER_SPECS } from "../providers/registry-effective.js";
import type { BaseProvider } from "./base.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIResponsesProvider } from "./openai-responses.js";
import { OpenAIChatProvider } from "./openai-chat.js";
import { QwenResponsesProvider } from "./qwen-responses.js";
import { GLMProvider } from "./glm.js";
import { OpenRouterProvider } from "./openrouter.js";
import { CopilotProvider } from "./copilot.js";
import { KimiAnthropicProvider } from "./kimi-anthropic.js";
import { DeepSeekAnthropicProvider } from "./deepseek-anthropic.js";
import { MiniMaxAnthropicProvider } from "./minimax-anthropic.js";
import { XiaomiAnthropicProvider } from "./xiaomi-anthropic.js";
import { GeminiGenerateContentProvider } from "./gemini-generate-content.js";

// 已弃用 — 由 *-anthropic.ts 变体取代。仅为回滚而保留可导入性。
// import { KimiProvider } from "./kimi.js";
// import { MiniMaxProvider } from "./minimax.js";
// import { DeepSeekProvider } from "./deepseek.js";
// import { XiaomiProvider } from "./xiaomi.js";

type ProviderCtor = new (config: ModelConfig) => BaseProvider;

const CTOR_BY_CLASS: Record<ProviderClassKind, ProviderCtor> = {
  "anthropic": AnthropicProvider,
  "openai-responses": OpenAIResponsesProvider,
  "openai-chat": OpenAIChatProvider,
  "qwen-responses": QwenResponsesProvider,
  "glm": GLMProvider,
  "openrouter": OpenRouterProvider,
  "copilot": CopilotProvider,
  "kimi-anthropic": KimiAnthropicProvider,
  "deepseek-anthropic": DeepSeekAnthropicProvider,
  "minimax-anthropic": MiniMaxAnthropicProvider,
  "xiaomi-anthropic": XiaomiAnthropicProvider,
};

/** 非 picker 预设的有效 id 的 provider-class 映射。 */
const EXTRA_PROVIDER_CLASSES: Record<string, ProviderClassKind> = {
  "openai-chat": "openai-chat",
  "kimi-ai": "kimi-anthropic",
};

const PROVIDER_CLASS_BY_ID: Map<string, ProviderClassKind> = (() => {
  const m = new Map<string, ProviderClassKind>(Object.entries(EXTRA_PROVIDER_CLASSES));
  for (const spec of EFFECTIVE_PROVIDER_SPECS) m.set(spec.id, spec.providerClass);
  return m;
})();

export function createProvider(config: ModelConfig): BaseProvider {
  const provider = config.provider.toLowerCase();
  const providerClass = PROVIDER_CLASS_BY_ID.get(provider);
  if (providerClass) {
    return new CTOR_BY_CLASS[providerClass](config);
  }
  // 自定义提供者（任意名称 + base_url）：按线路协议分派，
  // 而不是按已知 id。Anthropic 兼容端点使用 Anthropic 类；
  // 其余都按 OpenAI 兼容 chat 处理。
  if (config.baseUrl) {
    if (config.transportProtocol === "anthropic") return new AnthropicProvider(config);
    if (config.transportProtocol === "responses") return new OpenAIResponsesProvider(config);
    if (config.transportProtocol === "gemini") return new GeminiGenerateContentProvider(config);
    return new OpenAIChatProvider(config);
  }
  const supported = [...PROVIDER_CLASS_BY_ID.keys()].sort().join(", ");
  throw new Error(`Unknown provider '${config.provider}'. Supported: ${supported}`);
}
