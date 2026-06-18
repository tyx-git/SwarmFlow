import { describe, expect, it } from "bun:test";

import { Config } from "../src/config.js";

describe("Config model validation", () => {
  function makeConfigWithRaw(name: string, raw: Record<string, unknown>): Config {
    const cfg = new Config({});
    cfg.upsertModelRaw(name, raw);
    return cfg;
  }

  it("throws a clear error when provider is missing", () => {
    const cfg = makeConfigWithRaw("bad", {
      model: "gpt-5.2",
      api_key: "sk-test",
    });

    expect(() => cfg.getModel("bad")).toThrowError(
      "Invalid model config 'bad': missing required string field 'provider'",
    );
  });

  it("throws a clear error when model is missing", () => {
    const cfg = makeConfigWithRaw("bad", {
      provider: "openai",
      api_key: "sk-test",
    });

    expect(() => cfg.getModel("bad")).toThrowError(
      "Invalid model config 'bad': missing required string field 'model'",
    );
  });

  it("throws a clear error when api_key is missing or empty", () => {
    const cfg = makeConfigWithRaw("bad", {
      provider: "openai",
      model: "gpt-5.2",
      api_key: "",
    });

    expect(() => cfg.getModel("bad")).toThrowError(
      "Invalid model config 'bad': missing required string field 'api_key'",
    );
  });

  it("throws a typed error for invalid optional numeric fields", () => {
    const cfg = makeConfigWithRaw("bad", {
      provider: "openai",
      model: "gpt-5.2",
      api_key: "sk-test",
      temperature: "hot",
    });

    expect(() => cfg.getModel("bad")).toThrowError(
      "Invalid model config 'bad': field 'temperature' must be a number",
    );
  });

  it("applies the global Moonshot Anthropic base URL for provider 'kimi'", () => {
    const cfg = makeConfigWithRaw("kimiGlobal", {
      provider: "kimi",
      model: "kimi-k2.5",
      api_key: "sk-test",
    });

    expect(cfg.getModel("kimiGlobal").baseUrl).toBe("https://api.moonshot.ai/anthropic");
  });

  it("applies the shared coding endpoint base URL for provider 'kimi-code'", () => {
    const cfg = makeConfigWithRaw("kimiCode", {
      provider: "kimi-code",
      model: "kimi-k2.5",
      api_key: "sk-test",
    });

    expect(cfg.getModel("kimiCode").baseUrl).toBe("https://api.kimi.com/coding");
  });

  it("applies the documented DashScope Responses base URLs for direct Qwen providers", () => {
    const cases = [
      ["qwenChina", "qwen", "https://dashscope.aliyuncs.com/api/v2/apps/protocols/compatible-mode/v1"],
      ["qwenIntl", "qwen-intl", "https://dashscope-intl.aliyuncs.com/api/v2/apps/protocols/compatible-mode/v1"],
      ["qwenUs", "qwen-us", "https://dashscope-us.aliyuncs.com/api/v2/apps/protocols/compatible-mode/v1"],
    ] as const;

    for (const [name, provider, baseUrl] of cases) {
      const cfg = makeConfigWithRaw(name, {
        provider,
        model: "qwen3.7-max",
        api_key: "sk-test",
      });

      expect(cfg.getModel(name).baseUrl).toBe(baseUrl);
    }
  });

  it("treats Kimi as Anthropic transport with non-encrypted thinking", () => {
    const cfg = makeConfigWithRaw("kimiGlobal", {
      provider: "kimi",
      model: "kimi-k2.5",
      api_key: "sk-test",
    });

    const model = cfg.getModel("kimiGlobal");
    expect(model.transportProtocol).toBe("anthropic");
    expect(model.thinkingEncryption).toBe("none");
  });

  it("treats Qwen as Responses transport with non-encrypted thinking", () => {
    const cfg = makeConfigWithRaw("qwenIntl", {
      provider: "qwen-intl",
      model: "qwen3.6-plus",
      api_key: "sk-test",
    });

    const model = cfg.getModel("qwenIntl");
    expect(model.transportProtocol).toBe("responses");
    expect(model.thinkingEncryption).toBe("none");
  });

  it("treats OpenRouter Claude models as chat transport with Anthropic-encrypted thinking", () => {
    const cfg = makeConfigWithRaw("orClaude", {
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.6",
      api_key: "sk-test",
    });

    const model = cfg.getModel("orClaude");
    expect(model.transportProtocol).toBe("chat");
    expect(model.thinkingEncryption).toBe("anthropic");
  });

  it("treats OpenRouter GPT models as chat transport with OpenAI-encrypted thinking", () => {
    const cfg = makeConfigWithRaw("orGpt", {
      provider: "openrouter",
      model: "openai/gpt-5.4",
      api_key: "sk-test",
    });

    const model = cfg.getModel("orGpt");
    expect(model.transportProtocol).toBe("chat");
    expect(model.thinkingEncryption).toBe("openai");
  });

  it("routes Copilot Claude models through Anthropic transport and encryption", () => {
    const cfg = makeConfigWithRaw("copilotClaude", {
      provider: "copilot",
      model: "claude-sonnet-4.6",
      api_key: "sk-test",
    });

    const model = cfg.getModel("copilotClaude");
    expect(model.transportProtocol).toBe("anthropic");
    expect(model.thinkingEncryption).toBe("anthropic");
  });

  it("routes Copilot GPT models through Responses transport and OpenAI encryption", () => {
    const cfg = makeConfigWithRaw("copilotGpt", {
      provider: "copilot",
      model: "gpt-5.4",
      api_key: "sk-test",
    });

    const model = cfg.getModel("copilotGpt");
    expect(model.transportProtocol).toBe("responses");
    expect(model.thinkingEncryption).toBe("openai");
  });
});
