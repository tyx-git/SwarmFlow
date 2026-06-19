/**
 * 所有 Copilot 提供者变体共享的请求头构造。
 *
 * Copilot 的 API 网关（api.individual.githubcopilot.com）要求每个请求携带特定的
 * 编辑器标识 + 意图头。即使 token 有效，缺失或错误的头也会导致 401/403。
 * 此模块集中构造请求头，使 Anthropic 和 OpenAI Responses 两种变体
 * 产生相同的头。
 */

import { COPILOT_EDITOR_HEADERS } from "../auth/github-copilot-oauth.js";
import type { Message } from "./base.js";

export interface CopilotHeaderOptions {
  /** 如果为 true，添加 `copilot-vision-request: true` — 发送图像内容时必需。 */
  vision?: boolean;
  /**
   * 此请求是否是 agent 驱动的后续请求（工具调用后，或子 agent 延续），
   * 而不是用户直接发起的请求。这会在 `agent` 和 `user` 之间切换
   * `x-initiator` 头 — 这是 Copilot 计费/限速信号。没有它，agent 循环内
   * 每个请求都会被计为用户发起，并按完整 premium 计费。
   */
  isAgent?: boolean;
  /** 用于追踪特定请求的可选请求 ID。 */
  requestId?: string;
}

/**
 * 构建完整的 Copilot 请求头集合（不包括 Authorization，
 * 它由 SDK 通过 apiKey/authToken 选项注入）。
 *
 * 这些头告诉 Copilot 网关我们是支持聊天的编辑器客户端，
 * 与 VS Code Copilot Chat 扩展发送的内容匹配。
 */
export function buildCopilotRequestHeaders(
  opts: CopilotHeaderOptions = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    ...COPILOT_EDITOR_HEADERS,
    // Chat + /models 位于 Copilot 网关上，该网关通过 API 版本跟踪按用量计费时代。
    // copilot_internal/* token-exchange 端点保留 COPILOT_EDITOR_HEADERS 的旧版本；
    // 这里仅对网关请求覆盖它。
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
 * 通过查看投影对话中的最后一条消息，判断当前请求是否为 agent 驱动的后续请求。
 *
 * 我们的 `Message` 格式使用专门的 `tool_result` 角色（不同于 Anthropic
 * 将 tool_result 块嵌入 `user` 消息的模式），因此逻辑很简单：
 * 如果最后一条消息是普通用户消息，则请求由用户发起；其他情况
 *（tool_result、重试后的 assistant 延续等）均由 agent 发起。
 */
export function detectAgentInMessages(messages: Message[]): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = messages[messages.length - 1];
  return last?.role !== "user";
}

/**
 * 检测请求中是否有任何消息包含图像内容。用于决定是否设置
 * `copilot-vision-request: true`。
 *
 * Anthropic 形状和 OpenAI 形状的消息都可以通过结构化内容块携带图像；
 * 我们检查是否存在 `type` 为 `image`、`image_url` 或 `input_image` 的块。
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
