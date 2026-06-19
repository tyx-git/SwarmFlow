/**
 * @deprecated 2026-05 — 已由 `./minimax-anthropic.ts` 中的 MiniMaxAnthropicProvider 取代。
 *
 * 仅保留在代码树中用于紧急回滚。注册表不再将 `minimax*` 提供者 id
 * 分派到此类。新路径稳定后删除此文件。
 *
 * ---- 原始文档字符串如下 ----
 *
 * MiniMax 提供者适配器。
 *
 * 使用 reasoning_split 支持扩展 OpenAIChatProvider。
 * MiniMax 会在 content 内的 <think>...</think> 标签中嵌入 reasoning，
 * 而不是使用单独的 reasoning_details 字段。
 */

import type { ModelConfig } from "../config/config.js";
import {
  ProviderResponse,
  type Message,
  type SendMessageOptions,
  type ToolDef,
} from "./base.js";
import { OpenAIChatProvider } from "./openai-chat.js";

/** 从文本中提取 <think> 块。返回 { reasoning, visible }，如果没有 think 块则返回 null。 */
function extractThinkBlock(text: string): { reasoning: string; visible: string } | null {
  const trimmed = text.replace(/^\s*/, "");
  if (!trimmed.startsWith("<think>")) return null;
  const tagStart = text.indexOf("<think>") + "<think>".length;
  const closeIdx = text.indexOf("</think>", tagStart);
  if (closeIdx < 0) return null; // 不完整
  const reasoning = text.slice(tagStart, closeIdx);
  const visible = text.slice(closeIdx + "</think>".length).replace(/^\r?\n+/, "");
  return { reasoning, visible };
}

interface AssistantProjection {
  msgIndex: number;
  text: string;
  toolNamesKey: string;
  toolSignatureKey: string;
}

export class MiniMaxProvider extends OpenAIChatProvider {
  constructor(config: ModelConfig) {
    if (!config.baseUrl) {
      throw new Error(
        "MiniMax provider requires a base_url. " +
          "Use provider 'minimax' or 'minimax-cn' (auto-configured) or set base_url.",
      );
    }
    super(config);
  }

  protected override _applyThinkingParams(
    kwargs: Record<string, unknown>,
  ): void {
    if (!this._config.supportsThinking) return;
    kwargs["extra_body"] = {
      ...((kwargs["extra_body"] as Record<string, unknown>) || {}),
      reasoning_split: true,
    };
  }

  override async sendMessage(
    messages: Message[],
    tools?: ToolDef[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const result = await super.sendMessage(messages, tools, options);

    // 流式路径：<think> 提取由 _callStream 处理。
    // 非流式路径：从 content 中的 <think> 标签提取 reasoning。
    if (!result.reasoningContent && result.text) {
      const extracted = extractThinkBlock(result.text);
      if (extracted) {
        result.reasoningContent = extracted.reasoning;
        result.reasoningState = extracted.reasoning || null;
        result.text = extracted.visible;
      }
    }

    // 遗留：还检查原始响应中的 reasoning_details（旧 API 版本）
    if (!result.reasoningContent) {
      try {
        const raw = result.raw as Record<string, unknown> | null;
        if (!raw) return result;
        const choices = (raw["choices"] as Record<string, unknown>[]) || [];
        if (choices.length === 0) return result;
        const message = choices[0]["message"] as Record<string, unknown>;
        const details = message?.["reasoning_details"] as
          | Record<string, unknown>[]
          | undefined;
        if (details) {
          const reasoningTexts: string[] = [];
          for (const item of details) {
            const text =
              (item["content"] as string) || (item["text"] as string) || "";
            if (text) reasoningTexts.push(text);
          }
          if (reasoningTexts.length > 0) {
            result.reasoningContent = reasoningTexts.join("\n");
            result.reasoningState = details;
          }
        }
      } catch {
        // 忽略
      }
    }

    return result;
  }

  protected override _convertMessages(
    messages: Message[],
  ): Record<string, unknown>[] {
    const converted = super._convertMessages(messages);
    const originalMessages = messages as unknown as Record<string, unknown>[];
    const assistantIndexMap = MiniMaxProvider._buildAssistantIndexMap(
      originalMessages,
      converted,
    );

    for (let i = 0; i < converted.length; i++) {
      const msg = converted[i];
      if (msg["role"] !== "assistant") continue;

      // 为多回合上下文将 reasoning 重新嵌入 content 的 <think> 块中，
      // 因为 MiniMax 期望对话历史中包含 thinking 内容。
      const origIdx = assistantIndexMap.get(i);
      if (origIdx == null) continue;

      const orig = originalMessages[origIdx];
      const reasoning = orig["reasoning_content"] as string | undefined;
      const content = (msg["content"] as string) || "";
      if (reasoning && !content.includes("<think>")) {
        msg["content"] = `<think>\n${reasoning}\n</think>\n${content}`;
      }
      // 当上游响应提供 `_reasoning_state` 时也接受它。
      const blocks = orig["_reasoning_state"];
      if (blocks && Array.isArray(blocks)) {
        converted[i]["reasoning_details"] = blocks;
      }
    }

    return converted;
  }

  private static _buildAssistantIndexMap(
    original: Record<string, unknown>[],
    converted: Record<string, unknown>[],
  ): Map<number, number> {
    const originalAssistants = MiniMaxProvider._collectAssistantProjections(original);
    const convertedAssistants = MiniMaxProvider._collectAssistantProjections(converted);
    const mapped = new Map<number, number>();
    const usedOriginal = new Set<number>();

    const assignUniqueMatches = (
      predicate: (orig: AssistantProjection, conv: AssistantProjection) => boolean,
    ): void => {
      for (const conv of convertedAssistants) {
        if (mapped.has(conv.msgIndex)) continue;
        const candidates = originalAssistants.filter(
          (orig) => !usedOriginal.has(orig.msgIndex) && predicate(orig, conv),
        );
        if (candidates.length === 1) {
          const chosen = candidates[0];
          mapped.set(conv.msgIndex, chosen.msgIndex);
          usedOriginal.add(chosen.msgIndex);
        }
      }
    };

    // 1) 强匹配：文本 + 详细工具签名。
    assignUniqueMatches((orig, conv) =>
      !!orig.toolSignatureKey &&
      orig.toolSignatureKey === conv.toolSignatureKey &&
      orig.text === conv.text,
    );

    // 2) 中等匹配：文本 + 工具名称序列。
    assignUniqueMatches((orig, conv) =>
      !!orig.toolNamesKey &&
      orig.toolNamesKey === conv.toolNamesKey &&
      orig.text === conv.text,
    );

    // 3) 弱匹配：仅文本。
    assignUniqueMatches((orig, conv) =>
      !!orig.text && orig.text === conv.text,
    );

    // 4) 最终回退：仅在剩余基数匹配时保留顺序。
    // 这避免了旧的“始终按序号”错位失败模式。
    const remainingConverted = convertedAssistants.filter(
      (conv) => !mapped.has(conv.msgIndex),
    );
    const remainingOriginal = originalAssistants.filter(
      (orig) => !usedOriginal.has(orig.msgIndex),
    );
    if (remainingConverted.length === remainingOriginal.length) {
      for (let i = 0; i < remainingConverted.length; i++) {
        mapped.set(remainingConverted[i].msgIndex, remainingOriginal[i].msgIndex);
      }
    }

    return mapped;
  }

  private static _collectAssistantProjections(
    messages: Record<string, unknown>[],
  ): AssistantProjection[] {
    const assistants: AssistantProjection[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg["role"] !== "assistant") continue;
      assistants.push({
        msgIndex: i,
        ...MiniMaxProvider._projectAssistant(msg),
      });
    }
    return assistants;
  }

  private static _projectAssistant(
    msg: Record<string, unknown>,
  ): Omit<AssistantProjection, "msgIndex"> {
    const text = String((msg["content"] as string) || (msg["text"] as string) || "").trim();
    const toolCalls = Array.isArray(msg["tool_calls"])
      ? (msg["tool_calls"] as Record<string, unknown>[])
      : [];
    const toolNames: string[] = [];
    const toolSigs: string[] = [];

    for (const tc of toolCalls) {
      const fn = tc["function"] as Record<string, unknown> | undefined;
      const name = String((tc["name"] as string) || (fn?.["name"] as string) || "");
      const id = String((tc["id"] as string) || (tc["tool_call_id"] as string) || "");
      const argsRaw = tc["arguments"] ?? fn?.["arguments"];
      let args = "";
      if (typeof argsRaw === "string") {
        args = argsRaw;
      } else if (argsRaw && typeof argsRaw === "object") {
        try {
          args = JSON.stringify(argsRaw);
        } catch {
          args = "";
        }
      }
      toolNames.push(name);
      toolSigs.push(`${name}|${id}|${args}`);
    }

    return {
      text,
      toolNamesKey: toolNames.join("||"),
      toolSignatureKey: toolSigs.join("||"),
    };
  }
}
