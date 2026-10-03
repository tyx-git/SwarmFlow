import { describe, expect, it } from "vitest";

import { Config } from "../src/config/config.js";
import {
  resolveAgentModelEntry,
  runtimeModelName,
} from "../src/models/selection.js";

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
