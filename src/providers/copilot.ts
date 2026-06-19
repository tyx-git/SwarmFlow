/**
 * GitHub Copilot 提供者 — 分派器 + 内部实现。
 *
 * 架构：
 *   CopilotProvider（分派器；registry.ts 唯一知道的类）
 *     ├── CopilotAnthropicImpl（继承 AnthropicProvider）
 *     │   通过 Copilot 的 /v1/messages 端点路由 Claude 模型
 *     └── CopilotResponsesImpl（继承 OpenAIResponsesProvider）
 *         通过 Copilot 的 /responses 端点路由 GPT / Codex 模型
 *
 * 短生命周期 Copilot API token 由 copilotTokenManager 管理
 *（内存缓存，约每 25 分钟自动刷新）。每次 sendMessage 调用时，
 * 内部提供者都会使用新 token 和 token 响应中的 Copilot 网关 base URL
 * 重建其底层 SDK 客户端。
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

import type { ModelConfig } from "../config/config.js";
import { copilotTokenManager } from "../auth/github-copilot-token-manager.js";
import {
  BaseProvider,
  type Message,
  type ProviderResponse,
  type SendMessageOptions,
  type ToolDef,
} from "./base.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIResponsesProvider } from "./openai-responses.js";
import {
  buildCopilotRequestHeaders,
  detectAgentInMessages,
  detectVisionInMessages,
} from "./copilot-headers.js";

// =============================================================================
// 模型路由
// =============================================================================

/**
 * 按模型家族路由，而不是使用硬编码 allowlist，这样从 /models 实时获取的新 Copilot
 * 模型无需改代码即可工作：
 *   - Claude 模型 → Anthropic 形状的 /v1/messages
 *   - 其他所有模型（GPT/Codex、Gemini、MAI 等）→ OpenAI 形状的 /responses
 * 过去硬编码集合会与 Copilot 目录漂移，并对有效模型抛出
 * "Unknown Copilot model"（例如 claude-opus-4.7、gpt-5.5）。
 */
function isAnthropicShapedModel(modelId: string): boolean {
  return modelId.startsWith("claude");
}

// =============================================================================
// 辅助函数
// =============================================================================

/** 检测任一 SDK 返回的 401 Unauthorized 错误。 */
function is401Error(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  if (e["status"] === 401 || e["statusCode"] === 401) return true;
  if (typeof e["message"] === "string" && /\b401\b/.test(e["message"] as string)) {
    return true;
  }
  return false;
}

// =============================================================================
// 内部实现：Anthropic 形状（Claude 模型经 Copilot /v1/messages）
// =============================================================================

class CopilotAnthropicImpl extends AnthropicProvider {
  private async _refreshClient(vision: boolean, isAgent: boolean): Promise<void> {
    const apiToken = await copilotTokenManager.getToken();
    const copilotHeaders = buildCopilotRequestHeaders({ vision, isAgent });

    this._client = new Anthropic({
      // 占位符 — 真实认证在下面的 fetch 钩子中注入，
      // 避免 SDK 默认的 x-api-key 头（Copilot 代理会拒绝它）。
      apiKey: "unused-copilot-token-manager-owned",
      baseURL: apiToken.endpointApi,
      // 禁用 SDK 内置重试循环。外层 tool-loop 有自己的 network-retry 层
      //（`src/network-retry.ts`），其作用域正确（排除 400、指数退避、有日志）。
      // SDK 内部第二层隐藏重试会在任何临时 429/5xx/`x-should-retry: true`
      // 上静默放大 Copilot 计费。
      maxRetries: 0,
      fetch: async (input, init) => {
        const freshToken = await copilotTokenManager.getToken();
        const headers = new Headers(init?.headers);
        headers.delete("x-api-key");
        headers.set("authorization", `Bearer ${freshToken.token}`);
        for (const [k, v] of Object.entries(copilotHeaders)) {
          headers.set(k, v);
        }
        return fetch(input, { ...init, headers });
      },
    });
  }

  override async sendMessage(
    messages: Message[],
    tools?: ToolDef[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const vision = detectVisionInMessages(messages);
    const isAgent = detectAgentInMessages(messages);
    await this._refreshClient(vision, isAgent);
    try {
      return await super.sendMessage(messages, tools, options);
    } catch (err) {
      if (is401Error(err)) {
        copilotTokenManager.invalidate();
        await this._refreshClient(vision, isAgent);
        return await super.sendMessage(messages, tools, options);
      }
      throw err;
    }
  }
}

// =============================================================================
// 内部实现：OpenAI Responses 形状（GPT/Codex 模型经 Copilot /responses）
// =============================================================================

class CopilotResponsesImpl extends OpenAIResponsesProvider {
  private async _refreshClient(vision: boolean, isAgent: boolean): Promise<void> {
    const apiToken = await copilotTokenManager.getToken();
    const copilotHeaders = buildCopilotRequestHeaders({ vision, isAgent });

    this._client = new OpenAI({
      // OpenAI SDK 会将 apiKey 转换为 `Authorization: Bearer ${apiKey}`。
      apiKey: apiToken.token,
      baseURL: apiToken.endpointApi,
      defaultHeaders: copilotHeaders,
      // 禁用 SDK 内置重试循环（默认重试 2 次）。见上方 CopilotAnthropicImpl 注释 —
      // SDK 内部第二层重试会在临时错误上静默放大 Copilot 计费。
      maxRetries: 0,
    });
  }

  override async sendMessage(
    messages: Message[],
    tools?: ToolDef[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const vision = detectVisionInMessages(messages);
    const isAgent = detectAgentInMessages(messages);
    await this._refreshClient(vision, isAgent);
    try {
      return await super.sendMessage(messages, tools, options);
    } catch (err) {
      if (is401Error(err)) {
        copilotTokenManager.invalidate();
        await this._refreshClient(vision, isAgent);
        return await super.sendMessage(messages, tools, options);
      }
      throw err;
    }
  }
}

// =============================================================================
// 分派器：唯一暴露给 registry.ts 的类
// =============================================================================

/**
 * GitHub Copilot 提供者分派器。
 *
 * 按 `config.model` 路由：
 *   - Claude 模型 → CopilotAnthropicImpl (/v1/messages)
 *   - GPT / Codex 模型 → CopilotResponsesImpl (/responses)
 *
 * 暴露单个 "copilot" 提供者 ID；Claude vs GPT 的拆分对系统其余部分不可见。
 */
export class CopilotProvider extends BaseProvider {
  override readonly requiresAlternatingRoles: boolean;
  override readonly budgetCalcMode: "subtract_output" | "full_context";

  private _inner: BaseProvider;

  constructor(config: ModelConfig) {
    super();
    const modelId = config.model;

    if (isAnthropicShapedModel(modelId)) {
      this._inner = new CopilotAnthropicImpl(config);
    } else {
      this._inner = new CopilotResponsesImpl(config);
    }

    this.requiresAlternatingRoles = this._inner.requiresAlternatingRoles;
    this.budgetCalcMode = this._inner.budgetCalcMode;
  }

  async sendMessage(
    messages: Message[],
    tools?: ToolDef[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    return this._inner.sendMessage(messages, tools, options);
  }
}
