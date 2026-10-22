/**
 * 思考历史沿三个独立维度追踪：
 *   1. 传输协议 (responses / anthropic / chat)
 *      ——提供商使用何种线格式
 *   2. 推理加密族 (openai / anthropic / none)
 *      ——模型的思考是否经过签名/加密，以及由谁完成。
 *      决定明文重放策略：openai/anthropic 族的目标端会静默忽略
 *      明文 "thinking" 文本，因此必须省略。
 *   3. 密封模式字符串（如 "anthropic-messages"、"openai-responses"、
 *      "openrouter-chat"）——*密封载荷本身*使用何种线格式。
 *      两个提供商可共享加密族但不共享密封模式
 *      （如 OpenRouter 的 Fernet 包装 reasoning_details
 *      与 OpenAI Responses 原生 encrypted_content）。
 *      密封载荷仅在声明相同模式字符串的提供商之间往返。
 *
 * 提供商实现负责协议编码。模型切换通过比较存储产物的
 * (encryption, sealedSchema) 与目标提供商的 (encryption, sealedSchema)
 * 来决定发送内容。两个维度分别控制不同的门控：
 *   - 密封载荷？模式必须完全匹配
 *   - 明文重放？目标加密必须为 "none"
 *   - 否则：省略
 */

export type TransportProtocol = "responses" | "anthropic" | "chat" | "gemini";
export type ThinkingEncryption = "openai" | "anthropic" | "none";

/**
 * 密封思考载荷的线格式标签。使用相同模式的两个提供商可以
 * 在彼此之间往返密封载荷。新模式默认为"与其他所有模式不兼容"
 * ——共享需要新提供商选择加入现有字符串之一。
 *
 * 已知模式（2026-05）：
 *   - "anthropic-messages"：
 *       原生 Anthropic /v1/messages 思考块 `{type, thinking, signature}`。
 *       已验证在 Anthropic 直连与 Copilot Anthropic 之间可互换
 *       （签名双向互换）。
 *   - "openai-responses"：
 *       原生 OpenAI Responses 推理项 `{type:"reasoning", id, summary,
 *       encrypted_content}` + function_call 项。已验证 Copilot Responses
 *       逐字使用 OpenAI 原生 encrypted_content（无重新加密包装），
 *       因此 OpenAI 直连 → Copilot Responses → openai-codex 共享此模式。
 *   - "openrouter-chat"：
 *       OpenRouter 的 reasoning_details 数组
 *       `[{type:"reasoning.text"|"reasoning.summary"|"reasoning.encrypted",
 *          ...}]`。"reasoning.encrypted" 的 `data` 字段是 Fernet 令牌
 *       （带 0x80 版本字节的 urlsafe base64 + AES-CBC + HMAC），
 *       由 OpenRouter 持有的密钥加密——不是原始 OpenAI encrypted_content。
 *       这意味着 OpenRouter 密封载荷不能与 OpenAI Responses 直连互换，
 *       即使两者都目标 openai 族。
 */
export type SealedSchema = string;

export const SEALED_SCHEMA_ANTHROPIC_MESSAGES = "anthropic-messages";
export const SEALED_SCHEMA_OPENAI_RESPONSES = "openai-responses";
export const SEALED_SCHEMA_OPENROUTER_CHAT = "openrouter-chat";

export type ThinkingArtifact =
  | {
      encryption: "none";
      plainReplayText: string;
    }
  | {
      encryption: "openai" | "anthropic";
      plainReplayText: string;
      sealedPayload: unknown | null;
      sealedSchema: SealedSchema | null;
    };

export type ThinkingTransmission =
  | { kind: "sealed"; artifact: ThinkingArtifact; payload: unknown }
  | { kind: "plain"; artifact: ThinkingArtifact; plainReplayText: string }
  | { kind: "omit"; artifact: ThinkingArtifact };

export function createThinkingArtifact(
  encryption: ThinkingEncryption,
  plainReplayText: string,
  sealedPayload?: unknown,
  sealedSchema?: SealedSchema | null,
): ThinkingArtifact {
  const trimmed = plainReplayText.trim();
  if (encryption === "none") {
    return {
      encryption,
      plainReplayText: trimmed,
    };
  }
  return {
    encryption,
    plainReplayText: trimmed,
    sealedPayload: sealedPayload ?? null,
    sealedSchema: sealedSchema ?? null,
  };
}

function hasSealedPayload(
  artifact: ThinkingArtifact,
): artifact is Extract<ThinkingArtifact, { sealedPayload: unknown | null }> {
  return artifact.encryption !== "none" && artifact.sealedPayload !== null;
}

export function isThinkingArtifact(value: unknown): value is ThinkingArtifact {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  const encryption = raw["encryption"];
  const plainReplayText = raw["plainReplayText"];
  if (
    (encryption !== "openai" &&
      encryption !== "anthropic" &&
      encryption !== "none") ||
    typeof plainReplayText !== "string"
  ) {
    return false;
  }
  if (encryption === "none") {
    return !("sealedPayload" in raw);
  }
  // For encrypted artifacts we require sealedPayload to be present (may be null).
  // sealedSchema is also expected but accept legacy artifacts that pre-date it.
  return "sealedPayload" in raw;
}

export function normalizeThinkingArtifact(value: unknown): ThinkingArtifact | null {
  if (!isThinkingArtifact(value)) return null;
  const raw = value as unknown as Record<string, unknown>;
  const encryption = raw["encryption"] as ThinkingEncryption;
  const text = raw["plainReplayText"] as string;
  if (encryption === "none") {
    return createThinkingArtifact("none", text);
  }
  const sealedSchema =
    typeof raw["sealedSchema"] === "string" && raw["sealedSchema"] !== ""
      ? (raw["sealedSchema"] as string)
      : null;
  return createThinkingArtifact(encryption, text, raw["sealedPayload"], sealedSchema);
}

// ------------------------------------------------------------------
// 旧版 reasoning_state 推断
// ------------------------------------------------------------------

/** OpenAI Responses 原生推理项：`[{type:"reasoning"}, {type:"function_call"}, ...]`。 */
export function isOpenAIResponsesSealedPayload(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.some((item) => {
    if (!item || typeof item !== "object") return false;
    const type = (item as Record<string, unknown>)["type"];
    return type === "reasoning" || type === "function_call";
  });
}

/** Anthropic Messages 原生思考块：`[{type:"thinking"}, {type:"redacted_thinking"}]`。 */
export function isAnthropicMessagesSealedPayload(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((item) => {
    if (!item || typeof item !== "object") return false;
    const type = (item as Record<string, unknown>)["type"];
    return type === "thinking" || type === "redacted_thinking";
  });
}

/**
 * OpenRouter 的 reasoning_details 数组：
 *   `[{type:"reasoning.text"|"reasoning.summary"|"reasoning.encrypted", ...}]`。
 *
 * 被 `inferThinkingArtifact` 用于识别在 swarmflow 显式追踪
 * `_thinking_artifact` 之前产生的旧版 `_reasoning_state` 数组。
 */
export function isOpenRouterChatSealedPayload(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  let hasReasoningDotEntry = false;
  for (const item of value) {
    if (!item || typeof item !== "object") return false;
    const type = (item as Record<string, unknown>)["type"];
    if (typeof type !== "string") return false;
    if (type.startsWith("reasoning.")) {
      hasReasoningDotEntry = true;
      continue;
    }
    // 未知类型 → 非 OpenRouter reasoning_details 数组
    return false;
  }
  return hasReasoningDotEntry;
}

/** 启发式：任意 OpenRouter reasoning_details 条目标记为 "reasoning.encrypted"。 */
function openRouterEntriesHaveEncrypted(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((item) => {
    if (!item || typeof item !== "object") return false;
    return (item as Record<string, unknown>)["type"] === "reasoning.encrypted";
  });
}

/** 启发式：任意 OpenRouter reasoning_details 条目携带非空 `signature` 字段。 */
function openRouterEntriesHaveSignature(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((item) => {
    if (!item || typeof item !== "object") return false;
    const sig = (item as Record<string, unknown>)["signature"];
    return typeof sig === "string" && sig.length > 0;
  });
}

/**
 * 从旧版字段（`reasoning_content` + `_reasoning_state`）重建 ThinkingArtifact。
 * 在重新加载 `_thinking_artifact` 追踪功能上线之前保存的会话，
 * 或产物来自仍使用旧字段形状的其他代码路径时使用。
 */
export function inferThinkingArtifact(
  plainReplayText: unknown,
  reasoningState: unknown,
): ThinkingArtifact | null {
  const replayText = typeof plainReplayText === "string" ? plainReplayText.trim() : "";

  if (isThinkingArtifact(reasoningState)) {
    const artifact = normalizeThinkingArtifact(reasoningState);
    if (artifact) return artifact;
  }

  if (isOpenAIResponsesSealedPayload(reasoningState)) {
    return createThinkingArtifact(
      "openai",
      replayText,
      reasoningState,
      SEALED_SCHEMA_OPENAI_RESPONSES,
    );
  }

  if (isAnthropicMessagesSealedPayload(reasoningState)) {
    return createThinkingArtifact(
      "anthropic",
      replayText,
      reasoningState,
      SEALED_SCHEMA_ANTHROPIC_MESSAGES,
    );
  }

  if (isOpenRouterChatSealedPayload(reasoningState)) {
    // OpenRouter reasoning_details —— 根据条目形状推断加密族。
    // 我们可以可靠区分的情况：
    //   - 存在 reasoning.encrypted：来自加密上游。我们猜测 "openai"，
    //     因为 OpenRouter 上的 Claude 使用 reasoning.text + signature，
    //     而非 reasoning.encrypted。Fernet `data` 包装是 OpenRouter 持有的
    //     对称 AES，但内部密文是上游模型的加密；为安全起见，
    //     往返目标必须是另一个 OpenRouter+OpenAI 调用（模式和族都匹配）。
    //   - reasoning.text/summary 上存在 signature：Claude 族标记。
    //   - 都不存在：开源/非加密模型。加密为 "none"；
    //     跳过密封（没有族标记无法安全往返，且通过 reasoning_content
    //     的明文重放覆盖常见情况）。
    const hasEncrypted = openRouterEntriesHaveEncrypted(reasoningState);
    const hasSignature = openRouterEntriesHaveSignature(reasoningState);
    if (hasEncrypted) {
      return createThinkingArtifact(
        "openai",
        replayText,
        reasoningState,
        SEALED_SCHEMA_OPENROUTER_CHAT,
      );
    }
    if (hasSignature) {
      return createThinkingArtifact(
        "anthropic",
        replayText,
        reasoningState,
        SEALED_SCHEMA_OPENROUTER_CHAT,
      );
    }
    // Non-encrypted OpenRouter model — sealed round-trip unavailable.
    return createThinkingArtifact("none", replayText);
  }

  if (replayText || (reasoningState !== undefined && reasoningState !== null)) {
    return createThinkingArtifact("none", replayText);
  }

  return null;
}

export function resolveMessageThinkingArtifact(
  message: Record<string, unknown>,
): ThinkingArtifact | null {
  const raw = message["_thinking_artifact"];
  const normalized = normalizeThinkingArtifact(raw);
  if (normalized) return normalized;
  return inferThinkingArtifact(
    message["reasoning_content"],
    message["_reasoning_state"],
  );
}

/**
 * 决定向目标提供商发送何种推理载荷。
 *
 *   1. 仅当以下三者全部匹配时才发送密封载荷：
 *        - 产物携带密封载荷
 *        - artifact.sealedSchema === 目标接受的模式（线格式）
 *        - artifact.encryption === 目标的加密族（信任域）
 *      两个门控是独立的：例如 OpenRouter+Claude 和 OpenRouter+GPT
 *      都使用模式 "openrouter-chat" 但加密族不同，因此即使模式对齐，
 *      密封载荷也不会在它们之间交叉传输。相反，Anthropic 直连与
 *      Copilot Anthropic 共享模式和族，因此签名可干净往返
 *      （2026-05 实证验证）。
 *   2. 否则，如果目标接受明文思考（encryption === "none"），
 *      重放 plainReplayText。
 *   3. 否则，省略（加密族目标如 OpenAI / Anthropic
 *      会静默丢弃明文思考，发送只会浪费 token）。
 */
export function selectThinkingTransmission(
  artifact: ThinkingArtifact | null | undefined,
  targetEncryption: ThinkingEncryption,
  targetSealedSchema: SealedSchema | null = null,
): ThinkingTransmission | null {
  if (!artifact) return null;

  const replayText = artifact.plainReplayText.trim();

  if (
    targetSealedSchema &&
    hasSealedPayload(artifact) &&
    artifact.sealedSchema === targetSealedSchema &&
    artifact.encryption === targetEncryption
  ) {
    return {
      kind: "sealed",
      artifact,
      payload: artifact.sealedPayload,
    };
  }

  if (targetEncryption === "none" && replayText) {
    return {
      kind: "plain",
      artifact,
      plainReplayText: replayText,
    };
  }

  return {
    kind: "omit",
    artifact,
  };
}

export function buildAnthropicPlainThinkingPayload(
  plainReplayText: string,
): Record<string, unknown>[] {
  const trimmed = plainReplayText.trim();
  if (!trimmed) return [];
  return [{
    type: "thinking",
    thinking: trimmed,
  }];
}

function stripVendorPrefix(model: string): string {
  const idx = model.lastIndexOf("/");
  return idx >= 0 ? model.slice(idx + 1) : model;
}

export function isAnthropicFamilyModel(model: string): boolean {
  return stripVendorPrefix(model).toLowerCase().startsWith("claude-");
}

export function isOpenAIFamilyModel(model: string): boolean {
  const normalized = stripVendorPrefix(model).toLowerCase();
  return normalized.startsWith("gpt-") || /^o\d/.test(normalized);
}

export function resolveTransportProtocol(
  provider: string,
  model: string,
): TransportProtocol {
  const id = provider.toLowerCase();

  if (id === "openai" || id === "openai-codex") return "responses";
  if (id === "qwen" || id === "qwen-intl" || id === "qwen-us") return "responses";
  if (id === "anthropic") return "anthropic";
  if (id === "copilot") {
    return isAnthropicFamilyModel(model) ? "anthropic" : "responses";
  }
  if (
    id === "kimi" || id === "kimi-cn" || id === "kimi-ai" || id === "kimi-code"
    || id === "deepseek"
    || id === "minimax" || id === "minimax-cn"
    || id === "xiaomi"
  ) {
    return "anthropic";
  }
  return "chat";
}

export function resolveThinkingEncryption(
  provider: string,
  model: string,
): ThinkingEncryption {
  const id = provider.toLowerCase();

  if (id === "openai" || id === "openai-codex") return "openai";
  if (id === "anthropic") return "anthropic";
  if (id === "copilot" || id === "openrouter") {
    if (isOpenAIFamilyModel(model)) return "openai";
    if (isAnthropicFamilyModel(model)) return "anthropic";
    return "none";
  }
  return "none";
}

/**
 * 决定给定（提供商、模型、传输）组合能产生和消费哪种密封载荷模式。
 *
 * 从不产生密封载荷的厂商（如 Kimi/DeepSeek/MiniMax/Xiaomi、
 * Ollama、GLM、LM Studio）返回 null —— 密封传输对它们不可用，
 * 会降级为明文重放或省略。
 */
export function resolveSealedSchema(
  provider: string,
  model: string,
): SealedSchema | null {
  const id = provider.toLowerCase();

  if (id === "anthropic") return SEALED_SCHEMA_ANTHROPIC_MESSAGES;
  if (id === "openai" || id === "openai-codex") return SEALED_SCHEMA_OPENAI_RESPONSES;
  if (id === "copilot") {
    return isAnthropicFamilyModel(model)
      ? SEALED_SCHEMA_ANTHROPIC_MESSAGES
      : SEALED_SCHEMA_OPENAI_RESPONSES;
  }
  if (id === "openrouter") {
    // OpenRouter 用其自有的基于 Fernet 的 reasoning_details 信封包装一切，
    // 因此即使同族模型，跨厂商密封重用也不安全。
    // 所有 OpenRouter 响应共享此模式。
    return SEALED_SCHEMA_OPENROUTER_CHAT;
  }
  return null;
}

export function effectiveTransportProtocol(config: {
  provider: string;
  model: string;
  transportProtocol?: TransportProtocol;
}): TransportProtocol {
  return config.transportProtocol ?? resolveTransportProtocol(config.provider, config.model);
}

export function effectiveThinkingEncryption(config: {
  provider: string;
  model: string;
  thinkingEncryption?: ThinkingEncryption;
}): ThinkingEncryption {
  return config.thinkingEncryption ?? resolveThinkingEncryption(config.provider, config.model);
}

export function effectiveSealedSchema(config: {
  provider: string;
  model: string;
  sealedSchema?: SealedSchema | null;
}): SealedSchema | null {
  if (config.sealedSchema !== undefined) return config.sealedSchema;
  return resolveSealedSchema(config.provider, config.model);
}
