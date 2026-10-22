/** 提供商线协议与 settings.json 存储协议之间的映射及能力判断。 */

import type { ProviderEntry } from "../../config/settings/types.js";

export type ProviderWireProtocol = "anthropic-messages" | "openai-chat-completions" | "openai-responses" | "gemini-generate-content";

export type StoredProviderProtocol = NonNullable<ProviderEntry["protocol"]>;

export const WIRE_PROTOCOL_CHOICES: Array<{ key: "anthropic" | "chat" | "responses" | "gemini"; value: ProviderWireProtocol; detail: string; stored: StoredProviderProtocol }> = [
  { key: "anthropic", value: "anthropic-messages", detail: "/messages", stored: "anthropic" },
  { key: "chat", value: "openai-chat-completions", detail: "/chat/completions", stored: "openai-chat" },
  { key: "responses", value: "openai-responses", detail: "/responses", stored: "openai-responses" },
  { key: "gemini", value: "gemini-generate-content", detail: "models/*:generateContent", stored: "gemini" },
];

export function storedProtocolFromWire(protocol: ProviderWireProtocol): StoredProviderProtocol {
  return WIRE_PROTOCOL_CHOICES.find((p) => p.value === protocol)?.stored ?? "openai-chat";
}

export function wireProtocolFromStored(protocol: string | undefined): ProviderWireProtocol {
  switch (protocol) {
    case "anthropic":
    case "anthropic-messages":
      return "anthropic-messages";
    case "openai-responses":
    case "responses":
      return "openai-responses";
    case "gemini":
    case "gemini-generate-content":
      return "gemini-generate-content";
    case "openai-chat":
    case "chat":
    case "openai-chat-completions":
    default:
      return "openai-chat-completions";
  }
}

export function canDiscoverModels(protocol: string): boolean {
  return wireProtocolFromStored(protocol) === "openai-chat-completions";
}
