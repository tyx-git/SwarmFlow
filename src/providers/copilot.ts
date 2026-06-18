/**
 * GitHub Copilot provider 鈥?dispatcher + inner implementations.
 *
 * Architecture:
 *   CopilotProvider (dispatcher; the only thing registry.ts knows about)
 *     鈹溾攢 CopilotAnthropicImpl (extends AnthropicProvider)
 *     鈹?   routes Claude models through Copilot's /v1/messages endpoint
 *     鈹斺攢 CopilotResponsesImpl (extends OpenAIResponsesProvider)
 *          routes GPT / Codex models through Copilot's /responses endpoint
 *
 * The short-lived Copilot API token is managed by copilotTokenManager
 * (in-memory cache, auto-refresh every ~25 minutes). On every sendMessage
 * call, the inner provider rebuilds its underlying SDK client with the
 * fresh token and the Copilot gateway base URL from the token response.
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
// Model routing
// =============================================================================

/**
 * Route by model family rather than a hardcoded allowlist, so new Copilot
 * models (fetched live from /models) work without a code change:
 *   - Claude models 鈫?Anthropic-shaped /v1/messages
 *   - everything else (GPT/Codex, Gemini, MAI, 鈥? 鈫?OpenAI-shaped /responses
 * A hardcoded set previously drifted from Copilot's catalog and threw
 * "Unknown Copilot model" for valid models (e.g. claude-opus-4.7, gpt-5.5).
 */
function isAnthropicShapedModel(modelId: string): boolean {
  return modelId.startsWith("claude");
}

// =============================================================================
// Helpers
// =============================================================================

/** Detect 401 Unauthorized errors from either SDK. */
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
// Inner: Anthropic-shaped (Claude models via Copilot /v1/messages)
// =============================================================================

class CopilotAnthropicImpl extends AnthropicProvider {
  private async _refreshClient(vision: boolean, isAgent: boolean): Promise<void> {
    const apiToken = await copilotTokenManager.getToken();
    const copilotHeaders = buildCopilotRequestHeaders({ vision, isAgent });

    this._client = new Anthropic({
      // Placeholder 鈥?real auth is injected in the fetch hook below to avoid
      // the SDK's default x-api-key header, which Copilot's proxy rejects.
      apiKey: "unused-copilot-token-manager-owned",
      baseURL: apiToken.endpointApi,
      // Disable the SDK's built-in retry loop. Our outer tool-loop has its own
      // network-retry layer (`src/network-retry.ts`) which is correctly scoped
      // (excludes 400s, exponential backoff, logged). A second hidden retry
      // layer inside the SDK silently multiplies Copilot billing on any
      // transient 429/5xx/`x-should-retry: true`.
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
// Inner: OpenAI Responses-shaped (GPT/Codex models via Copilot /responses)
// =============================================================================

class CopilotResponsesImpl extends OpenAIResponsesProvider {
  private async _refreshClient(vision: boolean, isAgent: boolean): Promise<void> {
    const apiToken = await copilotTokenManager.getToken();
    const copilotHeaders = buildCopilotRequestHeaders({ vision, isAgent });

    this._client = new OpenAI({
      // OpenAI SDK turns apiKey into `Authorization: Bearer ${apiKey}`.
      apiKey: apiToken.token,
      baseURL: apiToken.endpointApi,
      defaultHeaders: copilotHeaders,
      // Disable the SDK's built-in retry loop (default is 2 retries). See the
      // comment in CopilotAnthropicImpl above 鈥?a second retry layer inside
      // the SDK silently multiplies Copilot billing on transient errors.
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
// Dispatcher: the only class exposed to registry.ts
// =============================================================================

/**
 * GitHub Copilot provider dispatcher.
 *
 * Routes by `config.model`:
 *   - Claude models 鈫?CopilotAnthropicImpl (/v1/messages)
 *   - GPT / Codex models 鈫?CopilotResponsesImpl (/responses)
 *
 * Exposes a single "copilot" provider ID; the Claude vs GPT split is invisible
 * to the rest of the system.
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
