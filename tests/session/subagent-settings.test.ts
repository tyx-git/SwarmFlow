import { existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  loadSubagentSettings,
  saveSubagentSettings,
  subagentSettingsPath,
  SubagentSettingsLoadError,
} from "../../src/session/subagent-settings.js";
import { SubAgentFactory } from "../../src/session/subagent-factory.js";

const MODEL = {
  name: "subagent-model",
  provider: "openai",
  model: "gpt-subagent",
  apiKey: "sk-test",
  temperature: 0.2,
  maxTokens: 256,
  contextLength: 8192,
  supportsMultimodal: false,
  thinkingBudget: 0,
  supportsWebSearch: false,
  transportProtocol: "chat" as const,
  thinkingEncryption: "none" as const,
  sealedSchema: null,
  extra: {},
};

describe("sub-agent role model settings", () => {
  it("stores versioned role settings below the project .swarmflow session directory", () => {
    const root = mkdtempSync(join(tmpdir(), "swarmflow-subagent-settings-"));
    try {
      const path = subagentSettingsPath(root, join(root, "session-123"));
      expect(path).toBe(join(root, ".swarmflow", "session-123", "agents", "subagent.json"));

      const value = {
        version: 1 as const,
        roles: {
          scout: {
            config_name: "subagent-model",
            provider: "openai",
            selection_key: "gpt-subagent",
            model_id: "gpt-subagent",
            thinking_level: "high",
          },
        },
      };
      saveSubagentSettings(path, value);
      const updated = { ...value, roles: { ...value.roles, scout: { ...value.roles.scout, thinking_level: "xhigh" } } };
      saveSubagentSettings(path, updated);
      expect(existsSync(path)).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(updated);
      expect(loadSubagentSettings(path)).toEqual(updated);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the shared role resolution result to construct a role agent", () => {
    const template = {
      name: "scout",
      systemPrompt: "Explore.",
      tools: [],
      maxToolRounds: 4,
    } as any;
    const factory = new SubAgentFactory({
      getAgentTemplates: () => ({ scout: template }),
      getConfig: () => ({
        subAgentInheritMcp: false,
      }) as any,
      getMcpManager: () => undefined,
      getPromptsDirs: () => undefined,
      resolveSessionArtifacts: () => ".",
      resolveRoleModel: (role: string) => role === "scout"
        ? {
            role,
            source: "role",
            configName: MODEL.name,
            provider: MODEL.provider,
            selectionKey: MODEL.model,
            modelId: MODEL.model,
            modelConfig: MODEL as any,
            thinkingLevel: "high",
          }
        : {
            role,
            source: "queen",
            configName: "parent-model",
            provider: "openai",
            selectionKey: "gpt-parent",
            modelId: "gpt-parent",
            modelConfig: { ...MODEL, name: "parent-model", model: "gpt-parent" } as any,
            thinkingLevel: "off",
          },
    });

    const result = factory.createFromPredefined("scout", "worker-1");
    expect(result.agent.modelConfig.name).toBe("subagent-model");
    expect(result.thinkingLevel).toBe("high");
  });

  it("fails loudly when persisted role settings are corrupt instead of inheriting Queen", () => {
    const root = mkdtempSync(join(tmpdir(), "swarmflow-subagent-settings-corrupt-"));
    try {
      const path = subagentSettingsPath(root, join(root, "session-123"));
      mkdirSync(join(root, ".swarmflow", "session-123", "agents"), { recursive: true });
      writeFileSync(path, "{\"version\":1,\"roles\":", "utf8");
      expect(() => loadSubagentSettings(path)).toThrow(SubagentSettingsLoadError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
