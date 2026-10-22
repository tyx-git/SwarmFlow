import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { Config } from "../../src/config/loader.js";
import { loadGlobalSettings, mergeSettings, parseSettingsOverrides, saveSettings } from "../../src/config/settings/io.js";

describe("Config preference-backed models", () => {
  it("preserves the OAuth sentinel for openai-codex presets", () => {
    const config = new Config({
      providerEnvVars: {
        "openai-codex": "_OPENAI_CODEX_OAUTH",
      },
      providerModels: {
        "openai-codex": [
          { id: "gpt-5.2-codex", contextLength: 400_000 },
          { id: "gpt-5.3-codex", contextLength: 400_000 },
          { id: "gpt-5.4", contextLength: 1_050_000 },
          { id: "gpt-5.4-mini", contextLength: 400_000 },
        ],
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

describe("fork prompt cache setting", () => {
  it("persists fork_inherit_prompt_cache_key and lets local settings override", () => {
    const home = mkdtempSync(join(tmpdir(), "swarmflow-fork-setting-"));
    try {
      saveSettings(
        { fork_inherit_prompt_cache_key: true },
        join(home, "settings.json"),
      );
      expect(loadGlobalSettings(home).fork_inherit_prompt_cache_key).toBe(true);

      const merged = mergeSettings(
        { fork_inherit_prompt_cache_key: true },
        { fork_inherit_prompt_cache_key: false },
      );
      expect(merged.fork_inherit_prompt_cache_key).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
