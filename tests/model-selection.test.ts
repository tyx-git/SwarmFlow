import { describe, expect, it } from "bun:test";

import { Config } from "../src/config.js";
import {
  resolveAgentModelEntry,
  resolveModelTierEntry,
  runtimeModelName,
} from "../src/model-selection.js";

function makeSession(provider = "openai-codex", model = "gpt-5.4"): any {
  return {
    config: new Config({}),
    primaryAgent: {
      modelConfig: {
        name: runtimeModelName(provider, model),
        provider,
        model,
        apiKey: "provider-token",
      },
    },
  };
}

describe("runtime model resolution", () => {
  it("materializes model tier identities with provider credentials from the active runtime", () => {
    const session = makeSession();

    const resolved = resolveModelTierEntry(session, {
      provider: "openai-codex",
      selection_key: "gpt-5.4-mini",
      model_id: "gpt-5.4-mini",
      thinking_level: "xhigh",
    });

    expect(resolved.selectedConfigName).toBe("runtime-openai-codex-gpt-5-4-mini");
    expect(resolved.thinkingLevel).toBe("xhigh");
    expect(resolved.modelConfig).toMatchObject({
      name: "runtime-openai-codex-gpt-5-4-mini",
      provider: "openai-codex",
      model: "gpt-5.4-mini",
    });
    expect(typeof resolved.modelConfig.apiKey).toBe("string");
    expect(resolved.modelConfig.apiKey.length).toBeGreaterThan(0);
  });

  it("materializes agent model pins through the same runtime resolver", () => {
    const session = makeSession();

    const resolved = resolveAgentModelEntry(session, {
      provider: "openai-codex",
      selection_key: "gpt-5.3-codex",
      model_id: "gpt-5.3-codex",
      thinking_level: "high",
    });

    expect(resolved.selectedConfigName).toBe("runtime-openai-codex-gpt-5-3-codex");
    expect(resolved.modelConfig).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.3-codex",
    });
    expect(typeof resolved.modelConfig.apiKey).toBe("string");
    expect(resolved.modelConfig.apiKey.length).toBeGreaterThan(0);
  });
});
