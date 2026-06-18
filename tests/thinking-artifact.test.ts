import { describe, expect, it } from "bun:test";

import {
  createThinkingArtifact,
  effectiveSealedSchema,
  effectiveThinkingEncryption,
  effectiveTransportProtocol,
  inferThinkingArtifact,
  isOpenRouterChatSealedPayload,
  resolveSealedSchema,
  SEALED_SCHEMA_ANTHROPIC_MESSAGES,
  SEALED_SCHEMA_OPENAI_RESPONSES,
  SEALED_SCHEMA_OPENROUTER_CHAT,
  selectThinkingTransmission,
} from "../src/thinking-artifact.js";

describe("thinking artifact selection", () => {
  it("sends sealed only when both encryption family and sealed schema match", () => {
    const openai = createThinkingArtifact(
      "openai",
      "openai summary",
      [{ type: "reasoning", encrypted_content: "enc" }],
      SEALED_SCHEMA_OPENAI_RESPONSES,
    );
    const anthropic = createThinkingArtifact(
      "anthropic",
      "anthropic summary",
      [{ type: "thinking", thinking: "hidden", signature: "sig" }],
      SEALED_SCHEMA_ANTHROPIC_MESSAGES,
    );

    // Matching family + schema → sealed
    expect(
      selectThinkingTransmission(openai, "openai", SEALED_SCHEMA_OPENAI_RESPONSES)?.kind,
    ).toBe("sealed");
    expect(
      selectThinkingTransmission(anthropic, "anthropic", SEALED_SCHEMA_ANTHROPIC_MESSAGES)?.kind,
    ).toBe("sealed");

    // Cross-family → omit even when target accepts sealed of its own kind
    expect(
      selectThinkingTransmission(openai, "anthropic", SEALED_SCHEMA_ANTHROPIC_MESSAGES)?.kind,
    ).toBe("omit");
    expect(
      selectThinkingTransmission(anthropic, "openai", SEALED_SCHEMA_OPENAI_RESPONSES)?.kind,
    ).toBe("omit");

    // Plain target → plain replay regardless of family
    expect(selectThinkingTransmission(openai, "none", null)?.kind).toBe("plain");
    expect(selectThinkingTransmission(anthropic, "none", null)?.kind).toBe("plain");
  });

  it("omits sealed when target schema differs from artifact schema (cross-vendor same-family)", () => {
    // OpenRouter+GPT artifact has openai family + openrouter-chat schema.
    // Switching to direct OpenAI Responses (openai family + openai-responses
    // schema) must NOT replay the Fernet-wrapped OpenRouter payload.
    const fromOpenRouterGpt = createThinkingArtifact(
      "openai",
      "summary",
      [{ type: "reasoning.encrypted", data: "fernet-blob" }],
      SEALED_SCHEMA_OPENROUTER_CHAT,
    );

    const toDirectOpenAI = selectThinkingTransmission(
      fromOpenRouterGpt,
      "openai",
      SEALED_SCHEMA_OPENAI_RESPONSES,
    );
    expect(toDirectOpenAI?.kind).toBe("omit");

    // Same-vendor same-schema still round-trips
    const sameOpenRouter = selectThinkingTransmission(
      fromOpenRouterGpt,
      "openai",
      SEALED_SCHEMA_OPENROUTER_CHAT,
    );
    expect(sameOpenRouter?.kind).toBe("sealed");
  });

  it("allows sealed round-trip across providers that explicitly share a schema", () => {
    // Anthropic direct ↔ Copilot Anthropic both use SEALED_SCHEMA_ANTHROPIC_MESSAGES.
    // Verified empirically (2026-05) that thinking signatures interchange
    // both directions.
    const fromCopilotAnthropic = createThinkingArtifact(
      "anthropic",
      "summary",
      [{ type: "thinking", thinking: "...", signature: "sig" }],
      SEALED_SCHEMA_ANTHROPIC_MESSAGES,
    );

    const toAnthropicDirect = selectThinkingTransmission(
      fromCopilotAnthropic,
      "anthropic",
      SEALED_SCHEMA_ANTHROPIC_MESSAGES,
    );
    expect(toAnthropicDirect?.kind).toBe("sealed");
  });

  it("replays plain text only when targeting non-encrypted models", () => {
    const openai = createThinkingArtifact(
      "openai",
      "openai summary",
      [{ type: "reasoning", encrypted_content: "enc" }],
      SEALED_SCHEMA_OPENAI_RESPONSES,
    );
    const anthropic = createThinkingArtifact(
      "anthropic",
      "anthropic summary",
      [{ type: "thinking", thinking: "hidden", signature: "sig" }],
      SEALED_SCHEMA_ANTHROPIC_MESSAGES,
    );
    const plain = createThinkingArtifact("none", "plain summary");

    expect(selectThinkingTransmission(openai, "none", null)?.kind).toBe("plain");
    expect(selectThinkingTransmission(anthropic, "none", null)?.kind).toBe("plain");
    expect(selectThinkingTransmission(plain, "openai", SEALED_SCHEMA_OPENAI_RESPONSES)?.kind).toBe("omit");
    expect(selectThinkingTransmission(plain, "anthropic", SEALED_SCHEMA_ANTHROPIC_MESSAGES)?.kind).toBe("omit");
    expect(selectThinkingTransmission(plain, "none", null)?.kind).toBe("plain");
  });

  it("omits encrypted-family replay when the matching sealed payload is missing", () => {
    const artifact = createThinkingArtifact(
      "openai",
      "summary only",
      undefined,
      SEALED_SCHEMA_OPENAI_RESPONSES,
    );
    const selected = selectThinkingTransmission(artifact, "openai", SEALED_SCHEMA_OPENAI_RESPONSES);
    expect(selected?.kind).toBe("omit");
  });

  it("never treats non-encrypted artifacts as sealed even if a caller passes payload", () => {
    const artifact = createThinkingArtifact("none", "plain replay", [{ type: "legacy" }]);
    const selected = selectThinkingTransmission(artifact, "none", null);
    expect(selected?.kind).toBe("plain");
    // sealedPayload should not even exist on encryption=none artifacts
    expect("sealedPayload" in artifact).toBe(false);
  });
});

describe("transport and encryption classification", () => {
  it("keeps protocol, encryption, and sealed schema independent", () => {
    // OpenRouter Claude: chat transport, anthropic encryption,
    // openrouter-chat sealed schema (NOT anthropic-messages — wire format differs).
    expect(effectiveTransportProtocol({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.6",
    })).toBe("chat");
    expect(effectiveThinkingEncryption({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.6",
    })).toBe("anthropic");
    expect(effectiveSealedSchema({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.6",
    })).toBe(SEALED_SCHEMA_OPENROUTER_CHAT);

    // OpenRouter GPT: chat transport, openai encryption, openrouter-chat schema.
    expect(effectiveTransportProtocol({
      provider: "openrouter",
      model: "openai/gpt-5.4",
    })).toBe("chat");
    expect(effectiveThinkingEncryption({
      provider: "openrouter",
      model: "openai/gpt-5.4",
    })).toBe("openai");
    expect(effectiveSealedSchema({
      provider: "openrouter",
      model: "openai/gpt-5.4",
    })).toBe(SEALED_SCHEMA_OPENROUTER_CHAT);

    // Qwen direct: Responses transport, but thinking remains non-encrypted.
    expect(effectiveTransportProtocol({
      provider: "qwen-intl",
      model: "qwen3.6-plus",
    })).toBe("responses");
    expect(effectiveThinkingEncryption({
      provider: "qwen-intl",
      model: "qwen3.6-plus",
    })).toBe("none");
    expect(effectiveSealedSchema({
      provider: "qwen-intl",
      model: "qwen3.6-plus",
    })).toBeNull();

    // Anthropic direct + Copilot Anthropic share the schema (verified empirically).
    expect(resolveSealedSchema("anthropic", "claude-sonnet-4-6")).toBe(SEALED_SCHEMA_ANTHROPIC_MESSAGES);
    expect(resolveSealedSchema("copilot", "claude-sonnet-4.6")).toBe(SEALED_SCHEMA_ANTHROPIC_MESSAGES);

    // OpenAI direct + Copilot Responses + openai-codex share the schema.
    expect(resolveSealedSchema("openai", "gpt-5.4")).toBe(SEALED_SCHEMA_OPENAI_RESPONSES);
    expect(resolveSealedSchema("openai-codex", "gpt-5.2-codex")).toBe(SEALED_SCHEMA_OPENAI_RESPONSES);
    expect(resolveSealedSchema("copilot", "gpt-5.4")).toBe(SEALED_SCHEMA_OPENAI_RESPONSES);

    // Kimi / DeepSeek / MiniMax / Xiaomi never emit sealed payloads
    expect(resolveSealedSchema("kimi", "kimi-k2.5")).toBeNull();
    expect(resolveSealedSchema("deepseek", "deepseek-reasoner")).toBeNull();
    expect(resolveSealedSchema("minimax", "MiniMax-M2")).toBeNull();
    expect(resolveSealedSchema("xiaomi", "mimo")).toBeNull();
  });
});

describe("OpenRouter legacy reasoning_details inference", () => {
  it("recognizes reasoning.encrypted entries as OpenAI-family sealed payload (Fernet-wrapped)", () => {
    const details = [{ type: "reasoning.encrypted", data: "gAAAAA-fernet-blob" }];
    expect(isOpenRouterChatSealedPayload(details)).toBe(true);

    const artifact = inferThinkingArtifact("plain summary", details);
    expect(artifact).not.toBeNull();
    expect(artifact!.encryption).toBe("openai");
    if (artifact!.encryption !== "none") {
      expect(artifact!.sealedSchema).toBe(SEALED_SCHEMA_OPENROUTER_CHAT);
      expect(artifact!.sealedPayload).toEqual(details);
    }
  });

  it("recognizes reasoning.text + signature as Anthropic-family sealed payload", () => {
    const details = [
      { type: "reasoning.text", text: "step 1", signature: "anthropic-sig" },
    ];
    const artifact = inferThinkingArtifact("plain summary", details);
    expect(artifact).not.toBeNull();
    expect(artifact!.encryption).toBe("anthropic");
    if (artifact!.encryption !== "none") {
      expect(artifact!.sealedSchema).toBe(SEALED_SCHEMA_OPENROUTER_CHAT);
      expect(artifact!.sealedPayload).toEqual(details);
    }
  });

  it("treats pure reasoning.text without signature as encryption=none", () => {
    const details = [{ type: "reasoning.text", text: "plain trace" }];
    const artifact = inferThinkingArtifact("plain summary", details);
    expect(artifact).not.toBeNull();
    expect(artifact!.encryption).toBe("none");
    expect("sealedPayload" in artifact!).toBe(false);
  });

  it("rejects arrays that are not reasoning_details-shaped", () => {
    expect(isOpenRouterChatSealedPayload([{ type: "thinking" }])).toBe(false);
    expect(isOpenRouterChatSealedPayload([{ type: "reasoning" }])).toBe(false);
    expect(isOpenRouterChatSealedPayload([])).toBe(false);
    expect(isOpenRouterChatSealedPayload("not an array")).toBe(false);
    expect(isOpenRouterChatSealedPayload(null)).toBe(false);
  });

  it("falls through to Anthropic Messages inference for raw thinking-block arrays", () => {
    const blocks = [{ type: "thinking", thinking: "...", signature: "sig" }];
    const artifact = inferThinkingArtifact("plain", blocks);
    expect(artifact).not.toBeNull();
    expect(artifact!.encryption).toBe("anthropic");
    if (artifact!.encryption !== "none") {
      expect(artifact!.sealedSchema).toBe(SEALED_SCHEMA_ANTHROPIC_MESSAGES);
    }
  });

  it("falls through to OpenAI Responses inference for raw reasoning-item arrays", () => {
    const items = [{ type: "reasoning", encrypted_content: "..." }];
    const artifact = inferThinkingArtifact("plain", items);
    expect(artifact).not.toBeNull();
    expect(artifact!.encryption).toBe("openai");
    if (artifact!.encryption !== "none") {
      expect(artifact!.sealedSchema).toBe(SEALED_SCHEMA_OPENAI_RESPONSES);
    }
  });
});
