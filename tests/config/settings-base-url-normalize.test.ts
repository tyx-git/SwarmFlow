import { describe, expect, it } from "vitest";

import { Config } from "../../src/config/loader.js";
import { settingsToConfigInputs } from "../../src/config/settings/io.js";
import type { SwarmflowSettings } from "../../src/config/settings/types.js";

describe("settings base URL normalization", () => {
  function modelBaseUrl(settings: SwarmflowSettings, name: string): string | undefined {
    return new Config(settingsToConfigInputs(settings)).getModel(name).baseUrl;
  }

  it("adds the /v1 version root to a legacy openai-responses base URL", () => {
    expect(modelBaseUrl({
      providers: {
        niko: {
          custom: true,
          base_url: "https://jp.example.xyz",
          protocol: "openai-responses",
          api_key: "test-key",
          models: [{ id: "deepseek-v4.1-flash" }],
        },
      },
    }, "niko:deepseek-v4.1-flash")).toBe("https://jp.example.xyz/v1");
  });

  it("adds /v1 for a local server entry that stores no protocol", () => {
    expect(modelBaseUrl({
      providers: {
        lmstudio: {
          base_url: "http://127.0.0.1:1234",
          model: "qwen2.5",
        },
      },
    }, "lmstudio:qwen2.5")).toBe("http://127.0.0.1:1234/v1");
  });

  it("trims a stored full responses endpoint back to its base URL", () => {
    expect(modelBaseUrl({
      providers: {
        niko: {
          custom: true,
          base_url: "https://jp.example.xyz/v1/responses",
          protocol: "openai-responses",
          api_key: "test-key",
          models: [{ id: "m" }],
        },
      },
    }, "niko:m")).toBe("https://jp.example.xyz/v1");
  });

  it("leaves an already normalized base URL untouched", () => {
    expect(modelBaseUrl({
      providers: {
        router: {
          custom: true,
          base_url: "https://openrouter.ai/api/v1",
          protocol: "openai-chat",
          api_key: "test-key",
          models: [{ id: "m" }],
        },
      },
    }, "router:m")).toBe("https://openrouter.ai/api/v1");
  });

  it("normalizes a raw model registration that bypasses settings conversion", () => {
    const config = new Config({});
    config.upsertModelRaw("local:qwen", {
      provider: "local",
      model: "qwen",
      api_key: "local",
      base_url: "http://127.0.0.1:1234",
      transport_protocol: "chat",
    });

    expect(config.getModel("local:qwen").baseUrl).toBe("http://127.0.0.1:1234/v1");
  });

  it("strips the version root for anthropic entries because the SDK appends /v1/messages", () => {
    expect(modelBaseUrl({
      providers: {
        proxy: {
          custom: true,
          base_url: "https://proxy.example.xyz/v1",
          protocol: "anthropic",
          models: [{ id: "claude-x" }],
        },
      },
    }, "proxy:claude-x")).toBe("https://proxy.example.xyz");
  });
});
