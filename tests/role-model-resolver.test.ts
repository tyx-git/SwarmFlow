import { describe, expect, it } from "vitest";

import {
  resolveRoleModel,
  RoleModelResolutionError,
} from "../src/session/role-model-resolver.js";

const QUEEN_MODEL = {
  name: "queen-model",
  provider: "openai",
  model: "gpt-5.4",
  apiKey: "queen-key",
  temperature: 0.2,
  maxTokens: 4096,
  contextLength: 128000,
  supportsMultimodal: false,
  thinkingBudget: 0,
  supportsWebSearch: false,
  transportProtocol: "chat" as const,
  thinkingEncryption: "none" as const,
  sealedSchema: null,
  extra: {},
};

function makeSession(config: any = { modelNames: [], getModel: () => { throw new Error("missing"); } }) {
  return {
    config,
    primaryAgent: { modelConfig: QUEEN_MODEL },
    thinkingLevel: "high",
  };
}

describe("unified role model resolver", () => {
  it("returns the active Queen model for an unconfigured role", () => {
    const resolved = resolveRoleModel(makeSession(), "scout", { version: 1, roles: {} });

    expect(resolved).toMatchObject({
      role: "scout",
      source: "queen",
      modelConfig: QUEEN_MODEL,
      provider: "openai",
      selectionKey: "gpt-5.4",
      modelId: "gpt-5.4",
      thinkingLevel: "high",
    });
  });

  it("resolves a configured role model and its thinking depth", () => {
    const roleModel = { ...QUEEN_MODEL, name: "scout-model", model: "gpt-scout" };
    const session = makeSession({
      modelNames: ["scout-model"],
      getModel: (name: string) => name === "scout-model" ? roleModel : QUEEN_MODEL,
    });
    const resolved = resolveRoleModel(session, "scout", {
      version: 1,
      roles: {
        scout: {
          config_name: "scout-model",
          provider: "openai",
          selection_key: "gpt-scout",
          model_id: "gpt-scout",
          thinking_level: "medium",
        },
      },
    });

    expect(resolved).toMatchObject({
      role: "scout",
      source: "role",
      configName: "scout-model",
      modelConfig: roleModel,
      thinkingLevel: "medium",
    });
  });

  it("reports an invalid configured model instead of silently inheriting Queen", () => {
    const session = makeSession();
    expect(() => resolveRoleModel(session, "scout", {
      version: 1,
      roles: {
        scout: {
          config_name: "missing-model",
          provider: "unknown-provider",
          selection_key: "missing-model",
          model_id: "missing-model",
          thinking_level: "high",
        },
      },
    })).toThrow(RoleModelResolutionError);
  });

  it("uses the child session's persisted model and thinking depth during history restore", () => {
    const childModel = { ...QUEEN_MODEL, name: "history-worker", model: "gpt-history" };
    const session = makeSession({
      getModel: (name: string) => name === "history-worker" ? childModel : QUEEN_MODEL,
    });
    const resolved = resolveRoleModel(session, "worker", undefined, {
      modelConfigName: "history-worker",
      modelProvider: "openai",
      modelSelectionKey: "gpt-history",
      modelId: "gpt-history",
      thinkingLevel: "xhigh",
    });

    expect(resolved).toMatchObject({
      source: "persisted",
      modelConfig: childModel,
      thinkingLevel: "xhigh",
    });
  });
});
