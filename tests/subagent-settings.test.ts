import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  loadSubagentDefaultModel,
  saveSubagentDefaultModel,
  subagentSettingsPath,
} from "../src/session/subagent-settings.js";
import { SubAgentFactory } from "../src/session/subagent-factory.js";

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

describe("sub-agent default model settings", () => {
  it("stores settings below the project .swarmflow session directory", () => {
    const root = mkdtempSync(join(tmpdir(), "swarmflow-subagent-settings-"));
    try {
      const path = subagentSettingsPath(root, join(root, "session-123"));
      expect(path).toBe(join(root, ".swarmflow", "session-123", "agents", "subagent.json"));

      const value = {
        config_name: "subagent-model",
        provider: "openai",
        selection_key: "gpt-subagent",
        model_id: "gpt-subagent",
        thinking_level: "high",
      };
      saveSubagentDefaultModel(path, value);
      const updated = { ...value, thinking_level: "xhigh" };
      saveSubagentDefaultModel(path, updated);
      expect(existsSync(path)).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(updated);
      expect(loadSubagentDefaultModel(path)).toEqual(updated);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the configured default when no pin or tier is present", () => {
    const template = {
      name: "explorer",
      systemPrompt: "Explore.",
      tools: [],
      maxToolRounds: 4,
    } as any;
    const factory = new SubAgentFactory({
      getAgentTemplates: () => ({ explorer: template }),
      getConfig: () => ({
        agentModels: {},
        modelTiers: {},
        subAgentInheritMcp: false,
      }) as any,
      getMcpManager: () => undefined,
      getPromptsDirs: () => undefined,
      resolveSessionArtifacts: () => ".",
      getParentModelConfig: () => ({ ...MODEL, name: "parent-model", model: "gpt-parent" }),
      resolvePinnedModel: () => { throw new Error("unused"); },
      resolveTierModel: () => { throw new Error("unused"); },
      appendStatus: () => undefined,
      getSubagentDefaultModel: () => ({ modelConfig: MODEL, thinkingLevel: "high" }),
    });

    const result = factory.createFromPredefined("explorer", "worker-1");
    expect(result.agent.modelConfig.name).toBe("subagent-model");
    expect(result.thinkingLevel).toBe("high");
  });
});
