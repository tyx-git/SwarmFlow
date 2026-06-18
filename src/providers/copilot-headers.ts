/**
 * Shared request header construction for all Copilot provider variants.
 *
 * Copilot's API gateway (api.individual.githubcopilot.com) expects a specific
 * set of editor-identification + intent headers on every request. Missing or
 * wrong headers cause 401/403 even with a valid token. This module centralizes
 * header construction so both the Anthropic and OpenAI Responses variants
 * produce identical headers.
 */

import { COPILOT_EDITOR_HEADERS } from "../auth/github-copilot-oauth.js";
import type { Message } from "./base.js";

export interface CopilotHeaderOptions {
  /** If true, adds `copilot-vision-request: true` 鈥?required when sending image content. */
  vision?: boolean;
  /**
   * Whether this request is an agent-driven follow-up (after a tool call, or a
   * subagent continuation) as opposed to a direct user-initiated request. This
   * flips the `x-initiator` header between `agent` and `user` 鈥?a Copilot
   * billing / rate-limit signal. Without it, every request inside an agent loop
   * gets counted as user-initiated and billed as full premium.
   */
  isAgent?: boolean;
  /** Optional request ID to trace a specific request. */
  requestId?: string;
}

/**
 * Build the full set of Copilot request headers (excluding Authorization,
 * which the SDKs inject via apiKey/authToken options).
 *
 * These headers tell Copilot's gateway that we're a chat-capable editor
 * client, matching what VS Code's Copilot Chat extension sends.
 */
export function buildCopilotRequestHeaders(
  opts: CopilotHeaderOptions = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    ...COPILOT_EDITOR_HEADERS,
    // Chat + /models live on the Copilot gateway, which tracks the usage-based
    // billing era by API version. The copilot_internal/* token-exchange
    // endpoints keep COPILOT_EDITOR_HEADERS' older version; this overrides it
    // for gateway requests only.
    "x-github-api-version": "2026-06-01",
    "copilot-integration-id": "vscode-chat",
    "openai-intent": "conversation-panel",
    "x-initiator": opts.isAgent ? "agent" : "user",
  };
  if (opts.vision) {
    headers["copilot-vision-request"] = "true";
  }
  if (opts.requestId) {
    headers["x-request-id"] = opts.requestId;
  }
  return headers;
}

/**
 * Determine whether the current request is an agent-driven follow-up by
 * looking at the last message in the projected conversation.
 *
 * Our `Message` format uses a dedicated `tool_result` role (unlike Anthropic's
 * pattern of embedding tool_result blocks inside a `user` message), so the
 * logic is simple: if the last message is a plain user message, the request is
 * user-initiated; anything else (tool_result, assistant continuation after a
 * retry, etc.) is agent-initiated.
 */
export function detectAgentInMessages(messages: Message[]): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = messages[messages.length - 1];
  return last?.role !== "user";
}

/**
 * Detect whether any message in the request contains image content. Used to
 * decide whether to set `copilot-vision-request: true`.
 *
 * Both Anthropic-shaped and OpenAI-shaped messages can carry images as
 * structured content blocks; we check for the presence of any block whose
 * `type` is `image` or `image_url` or that has `source.media_type`.
 */
export function detectVisionInMessages(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const content = (msg as Record<string, unknown>)["content"];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const type = (block as Record<string, unknown>)["type"];
      if (type === "image" || type === "image_url" || type === "input_image") {
        return true;
      }
    }
  }
  return false;
}
