/**
 * Thinking history is tracked on three independent axes:
 *   1. transport protocol (responses / anthropic / chat)
 *      鈥?what wire format the provider speaks
 *   2. reasoning encryption family (openai / anthropic / none)
 *      鈥?whether the model's thinking is signed/encrypted, and by whom.
 *      Drives plain-replay decisions: targets in openai/anthropic families
 *      will silently ignore plaintext "thinking" text, so we must omit it.
 *   3. sealed schema string (e.g. "anthropic-messages", "openai-responses",
 *      "openrouter-chat") 鈥?what wire format the *sealed payload itself*
 *      is in. Two providers can share an encryption family without sharing
 *      a sealed schema (e.g. OpenRouter's Fernet-wrapped reasoning_details
 *      vs OpenAI Responses' native encrypted_content). Sealed payloads only
 *      round-trip between providers that declare the same schema string.
 *
 * Provider implementations are responsible for protocol encoding. Model
 * switching decides what to send by comparing the stored artifact's
 * (encryption, sealedSchema) with the target provider's (encryption,
 * sealedSchema). The two axes serve different gates:
 *   - sealed payload? schema must match exactly
 *   - plain replay? target encryption must be "none"
 *   - else: omit
 */

export type TransportProtocol = "responses" | "anthropic" | "chat";
export type ThinkingEncryption = "openai" | "anthropic" | "none";

/**
 * Wire-format tag for a sealed thinking payload. Two providers using the
 * same schema can round-trip sealed payloads between themselves. New schemas
 * default to "incompatible with everything else" 鈥?sharing requires the new
 * provider to opt into one of the existing strings.
 *
 * Known schemas (2026-05):
 *   - "anthropic-messages":
 *       Native Anthropic /v1/messages thinking blocks `{type, thinking,
 *       signature}`. Verified interchangeable between Anthropic direct and
 *       Copilot Anthropic (signatures interchange both ways).
 *   - "openai-responses":
 *       Native OpenAI Responses reasoning items `{type:"reasoning", id,
 *       summary, encrypted_content}` + function_call items. Verified that
 *       Copilot Responses uses OpenAI native encrypted_content verbatim
 *       (no re-encryption wrapper), so OpenAI direct 鈫?Copilot Responses
 *       鈫?openai-codex share this schema.
 *   - "openrouter-chat":
 *       OpenRouter's reasoning_details array
 *       `[{type:"reasoning.text"|"reasoning.summary"|"reasoning.encrypted",
 *          ...}]`. The "reasoning.encrypted" `data` field is a Fernet token
 *       (urlsafe base64 with 0x80 version byte + AES-CBC + HMAC) encrypted
 *       with an OpenRouter-held key 鈥?NOT raw OpenAI encrypted_content.
 *       This means OpenRouter sealed payloads are not interchangeable with
 *       direct OpenAI Responses even when both target the openai family.
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
// Legacy reasoning_state inference
// ------------------------------------------------------------------

/** OpenAI Responses native reasoning items: `[{type:"reasoning"}, {type:"function_call"}, ...]`. */
export function isOpenAIResponsesSealedPayload(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.some((item) => {
    if (!item || typeof item !== "object") return false;
    const type = (item as Record<string, unknown>)["type"];
    return type === "reasoning" || type === "function_call";
  });
}

/** Anthropic Messages native thinking blocks: `[{type:"thinking"}, {type:"redacted_thinking"}]`. */
export function isAnthropicMessagesSealedPayload(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((item) => {
    if (!item || typeof item !== "object") return false;
    const type = (item as Record<string, unknown>)["type"];
    return type === "thinking" || type === "redacted_thinking";
  });
}

/**
 * OpenRouter's reasoning_details array:
 *   `[{type:"reasoning.text"|"reasoning.summary"|"reasoning.encrypted", ...}]`.
 *
 * Used by `inferThinkingArtifact` to recognize legacy `_reasoning_state`
 * arrays produced before swarmflow tracked `_thinking_artifact` explicitly.
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
    // Unknown type 鈫?not an OpenRouter reasoning_details array
    return false;
  }
  return hasReasoningDotEntry;
}

/** Heuristic: any OpenRouter reasoning_details entry tagged "reasoning.encrypted". */
function openRouterEntriesHaveEncrypted(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((item) => {
    if (!item || typeof item !== "object") return false;
    return (item as Record<string, unknown>)["type"] === "reasoning.encrypted";
  });
}

/** Heuristic: any OpenRouter reasoning_details entry carries a non-empty `signature` field. */
function openRouterEntriesHaveSignature(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((item) => {
    if (!item || typeof item !== "object") return false;
    const sig = (item as Record<string, unknown>)["signature"];
    return typeof sig === "string" && sig.length > 0;
  });
}

/**
 * Reconstruct a ThinkingArtifact from legacy fields (`reasoning_content` +
 * `_reasoning_state`). Used when reloading sessions saved before
 * `_thinking_artifact` was tracked, or when artifacts come in from other code
 * paths that still use the old field shape.
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
    // OpenRouter reasoning_details 鈥?figure out encryption family from entry
    // shape.  The cases we can reliably distinguish:
    //   - reasoning.encrypted present: came from an encrypting upstream. We
    //     guess "openai" because Claude on OpenRouter uses reasoning.text +
    //     signature, not reasoning.encrypted. The Fernet `data` wrapping is
    //     symmetric AES held by OpenRouter, but the inner ciphertext is the
    //     upstream model's encryption; for safety the round-trip target must
    //     be another OpenRouter+OpenAI call (schema and family both match).
    //   - signature present on reasoning.text/summary: Claude family marker.
    //   - neither: open-source / non-encrypted model. Encryption "none";
    //     skip sealed (we can't safely round-trip without a family tag, and
    //     plain replay via reasoning_content covers the common case).
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
    // Non-encrypted OpenRouter model 鈥?sealed round-trip unavailable.
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
 * Decide what reasoning payload to send to the target provider.
 *
 *   1. Send the sealed payload IFF all three match:
 *        - artifact carries a sealed payload
 *        - artifact.sealedSchema === target's accepted schema (wire format)
 *        - artifact.encryption === target's encryption family (trust domain)
 *      The two gates are independent: e.g. OpenRouter+Claude and OpenRouter+GPT
 *      both use schema "openrouter-chat" but differ in encryption family, so
 *      sealed payloads do not cross between them even though the schema lines
 *      up.  Conversely, Anthropic direct and Copilot Anthropic share both
 *      schema and family, so their signatures round-trip cleanly (verified
 *      empirically 2026-05).
 *   2. Otherwise, if the target accepts plain thinking (encryption === "none"),
 *      replay the plainReplayText.
 *   3. Otherwise, omit (encrypted-family targets like OpenAI / Anthropic
 *      silently drop plaintext thinking, so sending it would only waste
 *      tokens).
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
 * Decide which sealed-payload schema a given (provider, model, transport)
 * combination can produce and consume.
 *
 * Vendors that never produce sealed payloads (e.g. Kimi/DeepSeek/MiniMax/Xiaomi,
 * Ollama, GLM, LM Studio) return null 鈥?sealed transmission is unavailable for
 * them and they fall through to plain replay or omit.
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
    // OpenRouter wraps everything in its own Fernet-based reasoning_details
    // envelope, so cross-vendor sealed reuse is unsafe even for same-family
    // models.  All OpenRouter responses share this schema.
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
