import type { ModelConfig } from "../config/config.js";
import { BaseProvider, type Message, ProviderResponse, type SendMessageOptions, type ToolDef, Usage, finalizeToolCall } from "./base.js";

function roleOf(message: Message): "user" | "model" {
  return message.role === "assistant" ? "model" : "user";
}

function textOf(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => typeof part.text === "string" ? part.text : JSON.stringify(part))
    .join("\n");
}

function convertMessages(messages: Message[]): Array<{ role: "user" | "model"; parts: Array<Record<string, unknown>> }> {
  const out: Array<{ role: "user" | "model"; parts: Array<Record<string, unknown>> }> = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      out.push({ role: "user", parts: [{ text: textOf(msg.content) }] });
      continue;
    }
    if ((msg as Record<string, unknown>).role === "tool_result") {
      out.push({ role: "user", parts: [{ text: textOf(msg.content) }] });
      continue;
    }
    out.push({ role: roleOf(msg), parts: [{ text: textOf(msg.content) }] });
  }
  return out;
}

function convertTools(tools: ToolDef[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    functionDeclarations: [{
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }],
  }));
}

export class GeminiGenerateContentProvider extends BaseProvider {
  protected _config: ModelConfig;

  constructor(config: ModelConfig) {
    super();
    this._config = config;
  }

  async sendMessage(
    messages: Message[],
    tools?: ToolDef[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const baseUrl = (this._config.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
    const url = `${baseUrl}/models/${encodeURIComponent(this._config.model)}:generateContent`;
    const body: Record<string, unknown> = {
      contents: convertMessages(messages),
      generationConfig: {
        temperature: options?.temperature ?? this._config.temperature,
        maxOutputTokens: options?.maxTokens ?? this._config.maxTokens,
      },
    };
    const convertedTools = convertTools(tools);
    if (convertedTools) body.tools = convertedTools;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this._config.apiKey && this._config.apiKey !== "local") {
      headers["x-goog-api-key"] = this._config.apiKey;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Gemini generateContent failed (${res.status}): ${text || res.statusText}`);
    }
    const raw = await res.json() as Record<string, unknown>;
    const candidates = raw.candidates as Array<Record<string, unknown>> | undefined;
    const first = candidates?.[0] ?? {};
    const content = first.content as Record<string, unknown> | undefined;
    const parts = content?.parts as Array<Record<string, unknown>> | undefined;
    const textParts: string[] = [];
    const toolCalls = [];
    for (const part of parts ?? []) {
      if (typeof part.text === "string") {
        textParts.push(part.text);
      } else if (part.functionCall && typeof part.functionCall === "object") {
        const fc = part.functionCall as Record<string, unknown>;
        toolCalls.push(finalizeToolCall(
          typeof fc.name === "string" ? fc.name : `gemini-call-${toolCalls.length}`,
          typeof fc.name === "string" ? fc.name : "unknown",
          JSON.stringify(fc.args ?? {}),
          "Gemini function call",
        ));
      }
    }
    if (options?.onTextChunk) {
      const text = textParts.join("");
      if (text) options.onTextChunk(text);
    }
    const usageMeta = raw.usageMetadata as Record<string, number> | undefined;
    return new ProviderResponse({
      text: textParts.join(""),
      toolCalls,
      usage: new Usage(
        usageMeta?.promptTokenCount ?? 0,
        usageMeta?.candidatesTokenCount ?? 0,
      ),
      raw,
    });
  }
}
