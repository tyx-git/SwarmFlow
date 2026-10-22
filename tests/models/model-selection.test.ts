import { describe, expect, it } from "vitest";

import { Config } from "../../src/config/loader.js";
import { resolveModelSelection, runtimeModelName } from "../../src/models/selection.js";

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
  it("resolves a provider model target through the normal model selector", () => {
    const session = makeSession();
    const resolved = resolveModelSelection(session, "openai-codex:gpt-5.3-codex");
    expect(resolved.selectedConfigName).toBe("runtime-openai-codex-gpt-5-3-codex");
    expect(resolved.modelProvider).toBe("openai-codex");
    expect(resolved.modelId).toBe("gpt-5.3-codex");
  });
});
