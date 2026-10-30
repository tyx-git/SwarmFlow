/** 端点 URL 规范化、连通性测试与自定义模型条目注册。 */

import type { CustomModelEntry } from "../../config/settings/types.js";

import { runtimeTransportProtocol } from "../../config/model-capabilities.js";

import { type UiText } from "../../ui/text.js";

import { type StoredProviderProtocol, storedProtocolFromWire, wireProtocolFromStored } from "./protocol.js";

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return n % 1_000_000 === 0 ? `${n / 1_000_000}M` : `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1000)}K`;
}

/**
 * 从用户输入的显示名称派生 provider id。
 *
 * 中文等 Unicode 文字/数字是合法的 id 字符：provider id 只作为 settings 键、
 * 模型配置名前缀和内部寻址使用，JSON 键与 `provider:model` 解析都支持它们。
 * 只把标点/空白折叠成 "-"；完全不含文字或数字的名称才回落到 "custom"。
 */
export function slugifyProviderId(label: string): string {
  return label
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "custom";
}

/** 在 `<baseId>` 已被占用时依次尝试 `<baseId>_2`、`<baseId>_3`。 */
export function resolveUniqueProviderId(baseId: string, isTaken: (id: string) => boolean): string {
  let id = baseId;
  for (let i = 2; isTaken(id); i++) id = `${baseId}_${i}`;
  return id;
}

/**
 * Normalize a user-pasted endpoint into the base URL its selected SDK expects.
 * The optional protocol keeps suffix inference available for callers that have
 * not selected a protocol yet; provider setup passes the selected protocol.
 * `changed` reports whitespace, trailing slash, endpoint suffix cleanup, or a
 * missing version root.
 */
export function normalizeEndpointUrl(raw: string, selectedProtocol?: string): {
  baseUrl: string;
  protocol?: StoredProviderProtocol | null;
  changed: boolean;
} {
  const cleaned = raw.trim().replace(/\/+$/, "");
  const wireProtocol = selectedProtocol ? wireProtocolFromStored(selectedProtocol) : undefined;
  let protocol: StoredProviderProtocol | null = selectedProtocol
    ? storedProtocolFromWire(wireProtocol!)
    : null;
  let baseUrl = cleaned;

  if (wireProtocol === "anthropic-messages" || (!wireProtocol && /\/(?:v\d+\/)?messages$/i.test(cleaned))) {
    baseUrl = baseUrl.replace(/\/(?:v\d+\/)?messages$/i, "");
    baseUrl = baseUrl.replace(/\/v\d+$/i, "");
    protocol ??= "anthropic";
  } else if (wireProtocol === "openai-chat-completions" || (!wireProtocol && /\/chat\/completions$/i.test(cleaned))) {
    baseUrl = baseUrl.replace(/\/chat\/completions$/i, "");
    protocol ??= "openai-chat";
  } else if (wireProtocol === "openai-responses" || (!wireProtocol && /\/responses$/i.test(cleaned))) {
    baseUrl = baseUrl.replace(/\/responses$/i, "");
    protocol ??= "openai-responses";
  } else if (wireProtocol === "gemini-generate-content" || (!wireProtocol && /\/models\/[^/]+:generateContent$/i.test(cleaned))) {
    baseUrl = baseUrl.replace(/\/models\/[^/]+:generateContent$/i, "");
    baseUrl = baseUrl.replace(/:generateContent$/i, "");
    protocol ??= "gemini";
  }

  // openai SDK 请求 `<baseURL>/chat/completions` 与 `<baseURL>/responses`，而
  // OpenAI 兼容服务（含 /v1/models 发现）一律挂在 /v1 下；用户只填到主机名时
  // 补上版本根。Anthropic SDK 自带 `/v1/messages`，所以它的 base 不能带版本段。
  const effectiveWire = wireProtocol ?? (protocol ? wireProtocolFromStored(protocol) : undefined);
  if ((effectiveWire === "openai-chat-completions" || effectiveWire === "openai-responses")
    && /^https?:\/\//i.test(baseUrl)
    && !/\/v\d+$/i.test(baseUrl)) {
    baseUrl = `${baseUrl}/v1`;
  }

  return { baseUrl, protocol, changed: baseUrl !== raw };
}

/* 自定义端点的最佳可达性探测。 */
export async function testEndpoint(baseUrl: string, apiKey: string | undefined, protocol: string, t: UiText): Promise<{ ok: boolean; detail: string }> {
  if (wireProtocolFromStored(protocol) !== "openai-chat-completions") {
    return { ok: true, detail: t.get(["Commands", "/provider", "custom", "endpointSkipped"]) };
  }
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const headers: Record<string, string> = {};
    if (apiKey && apiKey !== "local") headers["Authorization"] = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      return { ok: true, detail: t.get(["Commands", "/provider", "custom", "endpointHttp"], { status: res.status }) };
    }
    const suffix = res.status === 401 || res.status === 403
      ? t.language === "zh" ? " — 请检查 API 密钥" : " — check API key"
      : "";
    return { ok: false, detail: t.get(["Commands", "/provider", "custom", "endpointHttpError"], { status: res.status, suffix }) };
  } catch (e) {
    return {
      ok: false,
      detail: t.get(["Commands", "/provider", "custom", "endpointUnreachable"], {
        message: e instanceof Error ? e.message : String(e),
      }),
    };
  }
}

/* 将一个自定义模型注册到活动运行时配置中。 */
export function registerCustomModel(config: any, providerId: string, baseUrl: string, protocol: string, apiKeyRef: string, m: CustomModelEntry): void {
  config.upsertModelRaw(`${providerId}:${m.id}`, {
    provider: providerId,
    model: m.id,
    custom: true,
    api_key: apiKeyRef,
    base_url: baseUrl,
    context_length: m.context_length,
    transport_protocol: runtimeTransportProtocol(protocol) ?? "chat",
    supports_multimodal: m.multimodal ?? false,
    supports_web_search: false,
    ...(m.max_output_tokens ? { max_tokens: m.max_output_tokens } : {}),
  });
}
