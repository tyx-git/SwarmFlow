import { describe, expect, it } from "bun:test";
import { Config } from "../src/config.js";
import { mergeSettings, parseSettingsOverrides } from "../src/persistence.js";

describe("Config preference-backed models", () => {
  it("preserves the OAuth sentinel for openai-codex presets", () => {
    const config = new Config({
      providerEnvVars: {
        "openai-codex": "_OPENAI_CODEX_OAUTH",
      },
    });

    expect(config.modelNames).toContain("openai-codex:gpt-5.2-codex");
    expect(config.listModelEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "openai-codex:gpt-5.2-codex",
          provider: "openai-codex",
          model: "gpt-5.2-codex",
          apiKeyRaw: "oauth:openai-codex",
        }),
        expect.objectContaining({
          name: "openai-codex:gpt-5.3-codex",
          apiKeyRaw: "oauth:openai-codex",
        }),
        expect.objectContaining({
          name: "openai-codex:gpt-5.4",
          apiKeyRaw: "oauth:openai-codex",
        }),
        expect.objectContaining({
          name: "openai-codex:gpt-5.4-mini",
          apiKeyRaw: "oauth:openai-codex",
        }),
      ]),
    );
  });

  it("can invalidate cached models by provider", () => {
    const config = new Config({});
    config.upsertModelRaw("runtime-test", {
      provider: "openai-codex",
      model: "gpt-5.4",
      api_key: "old-token",
    });

    expect(config.getModel("runtime-test").apiKey).toBe("old-token");
    (config as any)._rawModels["runtime-test"].api_key = "new-token";
    expect(config.getModel("runtime-test").apiKey).toBe("old-token");

    config.invalidateModelsByProvider("openai-codex");
    expect(config.getModel("runtime-test").apiKey).toBe("new-token");
  });
});

describe("process settings overrides", () => {
  it("parses context budget override and applies it above settings", () => {
    const settings = mergeSettings(
      { context_budget_percent: 80, thinking_level: "medium" },
      parseSettingsOverrides(["context_budget_percent=50"]),
    );

    expect(settings.context_budget_percent).toBe(50);
    expect(settings.thinking_level).toBe("medium");
  });
});
