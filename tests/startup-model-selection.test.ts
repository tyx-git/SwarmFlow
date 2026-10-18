import { describe, expect, it } from "vitest";

import {
  resolveStartupModelSelection,
  resolveTemplateFallbackModel,
} from "../src/models/startup-selection.js";

function modelCatalog() {
  const names = ["anthropic:claude-opus", "openai:gpt-5.2"];
  return {
    modelNames: names,
    findModelConfigName(provider: string, model: string): string | undefined {
      const name = `${provider}:${model}`;
      return names.includes(name) ? name : undefined;
    },
  };
}

function settingsWithCurrentModel(thinkingDepth: string | undefined = "high") {
  return {
    currentProvider: "anthropic",
    providers: {
      anthropic: {
        currentModel: {
          model: "claude-opus",
          configName: "anthropic:claude-opus",
          ...(thinkingDepth ? { thinkingDepth } : {}),
        },
      },
    },
    default_model: "openai:gpt-5.2",
    thinking_level: "medium",
  };
}

describe("startup model selection", () => {
  it("uses settings.json currentProvider.currentModel and its thinking depth", () => {
    const selection = resolveStartupModelSelection(
      modelCatalog(),
      settingsWithCurrentModel("high"),
    );

    expect(selection).toEqual({
      modelConfigName: "anthropic:claude-opus",
      modelProvider: "anthropic",
      modelSelectionKey: "claude-opus",
      modelId: "claude-opus",
      thinkingLevel: "high",
    });
  });

  it("resolves currentModel by provider + model when configName is absent", () => {
    const settings = {
      currentProvider: "anthropic",
      providers: {
        anthropic: {
          currentModel: {
            model: "claude-opus",
            thinkingDepth: "xhigh",
          },
        },
      },
      default_model: "openai:gpt-5.2",
      thinking_level: "medium",
    };

    const selection = resolveStartupModelSelection(modelCatalog(), settings);

    expect(selection.modelConfigName).toBe("anthropic:claude-opus");
    expect(selection.thinkingLevel).toBe("xhigh");
  });

  it("does not carry the previous model thinking depth onto an explicit --model override", () => {
    const selection = resolveStartupModelSelection(
      modelCatalog(),
      settingsWithCurrentModel("high"),
      { selectedModel: "openai:gpt-5.2" },
    );

    expect(selection.modelConfigName).toBe("openai:gpt-5.2");
    expect(selection.modelProvider).toBeUndefined();
    expect(selection.thinkingLevel).toBe("medium");
  });

  it("falls back to settings.default_model when currentModel is unavailable", () => {
    const selection = resolveStartupModelSelection(
      modelCatalog(),
      { default_model: "openai:gpt-5.2", thinking_level: "medium" },
    );
    expect(selection.modelConfigName).toBe("openai:gpt-5.2");
    expect(selection.thinkingLevel).toBe("medium");
  });

  it("resolves the template fallback from the selected startup model", () => {
    const catalog = modelCatalog();
    const byConfigName = resolveTemplateFallbackModel(catalog, {
      modelConfigName: "anthropic:claude-opus",
    });
    expect(byConfigName).toBe("anthropic:claude-opus");

    const byProvider = resolveTemplateFallbackModel(catalog, {
      modelConfigName: "missing",
      modelProvider: "openai",
      modelId: "gpt-5.2",
    });
    expect(byProvider).toBe("openai:gpt-5.2");
  });
});
