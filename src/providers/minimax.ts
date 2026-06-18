/**
 * @deprecated 2026-05 鈥?superseded by MiniMaxAnthropicProvider in `./minimax-anthropic.ts`.
 *
 * Kept in the tree for emergency rollback only. The registry no longer
 * dispatches the `minimax*` provider ids to this class. Once the new path
 * has soaked, delete this file.
 *
 * ---- Original docstring follows ----
 *
 * MiniMax provider adapter.
 *
 * Extends OpenAIChatProvider with reasoning_split support.
 * MiniMax embeds reasoning in <think>...</think> tags within content
 * rather than using a separate reasoning_details field.
 */

import type { ModelConfig } from "../config/config.js";
import {
  ProviderResponse,
  type Message,
  type SendMessageOptions,
  type ToolDef,
} from "./base.js";
import { OpenAIChatProvider } from "./openai-chat.js";

/** Extract <think> block from text. Returns { reasoning, visible } or null if no think block. */
function extractThinkBlock(text: string): { reasoning: string; visible: string } | null {
  const trimmed = text.replace(/^\s*/, "");
  if (!trimmed.startsWith("<think>")) return null;
  const tagStart = text.indexOf("<think>") + "<think>".length;
  const closeIdx = text.indexOf("</think>", tagStart);
  if (closeIdx < 0) return null; // incomplete
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

    // Streaming path: <think> extraction is handled in _callStream.
    // Non-streaming path: extract reasoning from <think> tags in content.
    if (!result.reasoningContent && result.text) {
      const extracted = extractThinkBlock(result.text);
      if (extracted) {
        result.reasoningContent = extracted.reasoning;
        result.reasoningState = extracted.reasoning || null;
        result.text = extracted.visible;
      }
    }

    // Legacy: also check reasoning_details in raw response (older API versions)
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
        // ignore
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

      // Re-embed reasoning as <think> block in content for multi-turn context,
      // since MiniMax expects thinking content in the conversation history.
      const origIdx = assistantIndexMap.get(i);
      if (origIdx == null) continue;

      const orig = originalMessages[origIdx];
      const reasoning = orig["reasoning_content"] as string | undefined;
      const content = (msg["content"] as string) || "";
      if (reasoning && !content.includes("<think>")) {
        msg["content"] = `<think>\n${reasoning}\n</think>\n${content}`;
      }
      // Also accept `_reasoning_state` when the upstream response provides it.
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

    // 1) Strong match: text + detailed tool signature.
    assignUniqueMatches((orig, conv) =>
      !!orig.toolSignatureKey &&
      orig.toolSignatureKey === conv.toolSignatureKey &&
      orig.text === conv.text,
    );

    // 2) Medium match: text + tool name sequence.
    assignUniqueMatches((orig, conv) =>
      !!orig.toolNamesKey &&
      orig.toolNamesKey === conv.toolNamesKey &&
      orig.text === conv.text,
    );

    // 3) Weak match: text only.
    assignUniqueMatches((orig, conv) =>
      !!orig.text && orig.text === conv.text,
    );

    // 4) Final fallback: preserve order only when the remaining cardinality matches.
    // This avoids the old "always ordinal" misalignment failure mode.
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
