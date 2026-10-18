import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDefaultRegistry, type CommandContext } from "../src/commands/commands.js";
import { Config } from "../src/config/config.js";

const MODEL_TEST_ENV_VARS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "QWEN_API_KEY",
  "QWEN_INTL_API_KEY",
  "QWEN_US_API_KEY",
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_INTL_API_KEY",
  "DASHSCOPE_US_API_KEY",
  "MOONSHOT_API_KEY",
  "KIMI_API_KEY",
  "KIMI_CN_API_KEY",
  "KIMI_CODE_API_KEY",
  "GLM_API_KEY",
  "GLM_CODE_API_KEY",
  "GLM_INTL_API_KEY",
  "GLM_INTL_CODE_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "SWARMFLOW_KIMI_API_KEY",
  "SWARMFLOW_KIMI_CN_API_KEY",
  "SWARMFLOW_KIMI_CODE_API_KEY",
  "SWARMFLOW_QWEN_API_KEY",
  "SWARMFLOW_QWEN_INTL_API_KEY",
  "SWARMFLOW_QWEN_US_API_KEY",
  "SWARMFLOW_GLM_API_KEY",
  "SWARMFLOW_GLM_INTL_API_KEY",
  "SWARMFLOW_GLM_CODE_API_KEY",
  "SWARMFLOW_GLM_INTL_CODE_API_KEY",
  "SWARMFLOW_MINIMAX_API_KEY",
  "SWARMFLOW_MINIMAX_CN_API_KEY",
];

const savedModelTestEnv = new Map<string, string | undefined>();

function makeContext(
  registry: ReturnType<typeof buildDefaultRegistry>,
  session: Record<string, unknown>,
  swarmflowHomeDir?: string,
): CommandContext {
  return {
    session,
    showMessage: vi.fn(),
    swarmflowHomeDir,
    autoSave: vi.fn(),
    resetUiState: vi.fn(),
    commandRegistry: registry,
  };
}

describe("/model command", () => {
  beforeEach(() => {
    savedModelTestEnv.clear();
    for (const envVar of MODEL_TEST_ENV_VARS) {
      savedModelTestEnv.set(envVar, process.env[envVar]);
      delete process.env[envVar];
    }
  });

  afterEach(() => {
    for (const [envVar, value] of savedModelTestEnv.entries()) {
      if (value === undefined) {
        delete process.env[envVar];
      } else {
        process.env[envVar] = value;
      }
    }
    savedModelTestEnv.clear();
  });

  it("is the only model-depth entry point and uses an inline picker", () => {
    const registry = buildDefaultRegistry();
    const model = registry.lookup("/model");

    expect(model).toBeTruthy();
    expect(model?.picker?.inputArea).toBe(true);
    expect(registry.lookup("/effort")).toBeUndefined();
    expect(registry.getAll().some((command) => command.name === "/effort")).toBe(false);
    expect(registry.lookup("/agents")?.picker?.inputArea).toBe(true);
    expect(registry.lookup("/agents")?.picker?.mode).toBe("single");
  });

  it.each(["queen", "scout", "worker", "reviewer", "guard", "merger"])(
    "saves /agents model and thinking depth for the %s role",
    async (role) => {
      process.env["OPENAI_API_KEY"] = "sk-openai";
      const registry = buildDefaultRegistry();
      const cmd = registry.lookup("/agents");
      expect(cmd).toBeTruthy();

      const save = vi.fn();
      const promptCommandPicker = vi.fn()
        .mockResolvedValueOnce({ value: "my-openai" })
        .mockResolvedValueOnce({ value: "high" });
      const session: any = {
        config: {
          modelNames: ["my-openai"],
          getModel: () => ({
            name: "my-openai",
            provider: "openai",
            model: "gpt-5.4",
            apiKey: "sk-openai",
          }),
          listModelEntries: () => ([{
            name: "my-openai",
            provider: "openai",
            model: "gpt-5.4",
            apiKeyRaw: "sk-openai",
            hasResolvedApiKey: true,
          }]),
        },
        primaryAgent: { modelConfig: { name: "primary", provider: "anthropic", model: "claude" } },
        thinkingLevel: "medium",
        getSubagentSettings: () => undefined,
        setSubagentSettings: save,
      };

      await cmd!.handler({
        ...makeContext(registry, session),
        promptCommandPicker,
      }, role);

      expect(promptCommandPicker).toHaveBeenCalledTimes(2);
      expect(save).toHaveBeenCalledWith({
        version: 1,
        roles: {
          [role]: {
            config_name: "my-openai",
            provider: "openai",
            selection_key: "gpt-5.4",
            model_id: "gpt-5.4",
            thinking_level: "high",
          },
        },
      });
      expect(session.primaryAgent.modelConfig.provider).toBe("anthropic");
      expect(session.switchModel).toBeUndefined();
    },
  );

  it("lists all roles with Queen inheritance and opens each selection stage inline", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/agents");
    const session: any = {
      primaryAgent: { modelConfig: { provider: "openai", model: "gpt-5.4" } },
      getSubagentSettings: () => undefined,
    };
    const options = cmd!.options!({ session });
    expect(options.map((option) => option.value)).toEqual([
      "queen", "scout", "worker", "reviewer", "guard", "merger",
    ]);
    expect(options.find((option) => option.value === "scout")?.label).toMatch(/(?:继承 Queen 当前模型|Inherit Queen current model) \(openai\/gpt-5\.4 off\)/);

    const saves = vi.fn();
    const picker = vi.fn()
      .mockResolvedValueOnce({ value: "guard" })
      .mockResolvedValueOnce({ value: "my-openai" })
      .mockResolvedValueOnce({ value: "high" });
    const configuredSession: any = {
      config: {
        modelNames: ["my-openai"],
        getModel: () => ({ name: "my-openai", provider: "openai", model: "gpt-5.4", apiKey: "sk-openai" }),
        listModelEntries: () => [{ name: "my-openai", provider: "openai", model: "gpt-5.4", apiKeyRaw: "sk-openai", hasResolvedApiKey: true }],
      },
      primaryAgent: { modelConfig: { provider: "anthropic", model: "claude" } },
      getSubagentSettings: () => undefined,
      setSubagentSettings: saves,
    };
    await cmd!.handler({ ...makeContext(registry, configuredSession), promptCommandPicker: picker }, "");

    expect(picker).toHaveBeenCalledTimes(3);
    expect(picker.mock.calls.every(([, presentation]) => presentation?.inputArea === true)).toBe(true);
    const pickerTitles = picker.mock.calls.map(([, presentation]) => presentation?.title ?? "");
    expect(pickerTitles[0]).toMatch(/选择角色|Select role/);
    expect(pickerTitles[1]).toMatch(/选择供应商和模型|Select provider and model/);
    expect(pickerTitles[2]).toMatch(/思考深度|Thinking depth/);
    expect(saves).toHaveBeenCalledWith(expect.objectContaining({
      version: 1,
      roles: { guard: expect.objectContaining({ model_id: "gpt-5.4", thinking_level: "high" }) },
    }));
  });

  it("shows an unresolved configured role in the picker instead of presenting it as inherited", () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/agents");
    const options = cmd!.options!({
      session: {
        primaryAgent: { modelConfig: { provider: "openai", model: "gpt-5.4" } },
        config: {
          modelNames: [],
          listModelEntries: () => [],
          getModel: () => { throw new Error("missing configured model"); },
        },
        getSubagentSettings: () => ({
          version: 1,
          roles: {
            scout: {
              config_name: "removed-model",
              provider: "unknown-provider",
              selection_key: "removed-model",
              model_id: "removed-model",
              thinking_level: "high",
            },
          },
        }),
      },
    });

    const scout = options.find((option) => option.value === "scout");
    expect(scout?.label).toMatch(/model unavailable|模型不可用/i);
    expect(scout?.detail).toContain("scout");
  });

  it.each([
    { stage: "role", values: [undefined] },
    { stage: "model", values: ["scout", undefined] },
    { stage: "thinking depth", values: ["scout", "my-openai", undefined] },
  ])("cancelling the /agents $stage step leaves existing role settings untouched", async ({ values }) => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/agents");
    const existing = {
      version: 1 as const,
      roles: {
        scout: {
          config_name: "saved-model",
          provider: "anthropic",
          selection_key: "claude-sonnet-4-6",
          model_id: "claude-sonnet-4-6",
          thinking_level: "medium",
        },
      },
    };
    const save = vi.fn();
    const prompt = vi.fn();
    values.forEach((value) => prompt.mockResolvedValueOnce(value ? { value } : undefined));
    const session: any = {
      config: {
        modelNames: ["my-openai"],
        getModel: () => ({ name: "my-openai", provider: "openai", model: "gpt-5.4", apiKey: "sk-openai" }),
        listModelEntries: () => [{ name: "my-openai", provider: "openai", model: "gpt-5.4", apiKeyRaw: "sk-openai", hasResolvedApiKey: true }],
      },
      primaryAgent: { modelConfig: { provider: "anthropic", model: "claude" } },
      getSubagentSettings: () => existing,
      setSubagentSettings: save,
    };

    await cmd!.handler({ ...makeContext(registry, session), promptCommandPicker: prompt }, "");
    expect(save).not.toHaveBeenCalled();
    expect(existing.roles.scout.model_id).toBe("claude-sonnet-4-6");
  });

  it("persists Queen runtime model definitions with the /model provider settings path without switching the active session", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-anthropic";
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/agents");
    const tempHome = mkdtempSync(join(tmpdir(), "swarmflow-agents-queen-"));
    const save = vi.fn();
    const switchModel = vi.fn();
    const setPersistedModelSelection = vi.fn();
    const picker = vi.fn()
      .mockResolvedValueOnce({ value: "anthropic:claude-sonnet-4-6-1m" })
      .mockResolvedValueOnce({ value: "high" });
    const session: any = {
      config: {
        modelNames: [],
        listModelEntries: () => [],
        upsertModelRaw: vi.fn(),
      },
      primaryAgent: { modelConfig: { name: "active", provider: "openai", model: "gpt-5.4" } },
      switchModel,
      setPersistedModelSelection,
      getSubagentSettings: () => undefined,
      setSubagentSettings: save,
    };

    try {
      await cmd!.handler({ ...makeContext(registry, session, tempHome), promptCommandPicker: picker }, "queen");
      const providerSettings = JSON.parse(readFileSync(join(tempHome, "settings.json"), "utf8"));
      expect(providerSettings.providers.anthropic.models).toContainEqual(expect.objectContaining({ id: "claude-sonnet-4-6-1m" }));
      expect(save).toHaveBeenCalledWith(expect.objectContaining({
        roles: { queen: expect.objectContaining({ config_name: "runtime-anthropic-claude-sonnet-4-6-1m" }) },
      }));
      expect(switchModel).not.toHaveBeenCalled();
      expect(setPersistedModelSelection).not.toHaveBeenCalled();
      expect(session.primaryAgent.modelConfig).toMatchObject({ provider: "openai", model: "gpt-5.4" });
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("registers every option command with the shared input-area picker", () => {
    const registry = buildDefaultRegistry();
    const optionCommands = registry.getAll().filter((command) => command.options);

    expect(optionCommands.length).toBeGreaterThan(0);
    expect(optionCommands.every((command) => command.picker?.inputArea === true)).toBe(true);
    expect(registry.lookup("/skills")?.picker?.mode).toBe("toggle");
    expect(registry.lookup("/skills-manager")).toBeUndefined();
    expect(registry.lookup("/model")?.picker?.mode).toBe("single");
  });

  it("opens thinking depth as an inline picker after switching models", async () => {
    process.env["OPENAI_API_KEY"] = "sk-openai";
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd).toBeTruthy();

    const promptCommandPicker = vi.fn(async (
      _options: Array<{ label: string; value: string }>,
      config?: { inputArea?: boolean },
    ) => {
      expect(config?.inputArea).toBe(true);
      return { value: "high" };
    });
    const switchModel = vi.fn();
    const session: any = {
      config: {
        modelNames: ["my-openai"],
        getModel: () => ({
          name: "my-openai",
          provider: "openai",
          model: "gpt-5.4",
          apiKey: "sk-openai",
        }),
        listModelEntries: () => ([
          {
            name: "my-openai",
            provider: "openai",
            model: "gpt-5.4",
            apiKeyRaw: "sk-openai",
            hasResolvedApiKey: true,
          },
        ]),
      },
      switchModel: (name: string) => {
        switchModel(name);
        session.primaryAgent.modelConfig = {
          name,
          provider: "openai",
          model: "gpt-5.4",
          apiKey: "sk-openai",
        };
      },
      setPersistedModelSelection: vi.fn(),
      getGlobalPreferences: () => ({
        modelConfigName: "my-openai",
        modelProvider: "openai",
        modelSelectionKey: "gpt-5.4",
        modelId: "gpt-5.4",
        thinkingLevel: session.thinkingLevel ?? "none",
      }),
      primaryAgent: {
        modelConfig: {
          name: "my-openai",
          provider: "openai",
          model: "gpt-5.4",
          apiKey: "sk-openai",
        },
      },
      thinkingLevel: "none",
    };

    const ctx = {
      ...makeContext(registry, session),
      promptCommandPicker,
    };
    await cmd!.handler(ctx, "my-openai");

    expect(switchModel).toHaveBeenCalledWith("my-openai");
    expect(promptCommandPicker).toHaveBeenCalledTimes(1);
    expect(session.thinkingLevel).toBe("high");
  });

  it("keeps the completed model switch when thinking depth is cancelled", async () => {
    process.env["OPENAI_API_KEY"] = "sk-openai";
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd).toBeTruthy();

    const switchModel = vi.fn();
    const session: any = {
      config: {
        modelNames: ["my-openai"],
        getModel: () => ({
          name: "my-openai",
          provider: "openai",
          model: "gpt-5.4",
          apiKey: "sk-openai",
        }),
        listModelEntries: () => ([
          {
            name: "my-openai",
            provider: "openai",
            model: "gpt-5.4",
            apiKeyRaw: "sk-openai",
            hasResolvedApiKey: true,
          },
        ]),
      },
      switchModel: (name: string) => {
        switchModel(name);
        session.primaryAgent.modelConfig = {
          name,
          provider: "openai",
          model: "gpt-5.4",
          apiKey: "sk-openai",
        };
      },
      setPersistedModelSelection: vi.fn(),
      getGlobalPreferences: () => ({
        modelConfigName: "my-openai",
        modelProvider: "openai",
        modelSelectionKey: "gpt-5.4",
        modelId: "gpt-5.4",
        thinkingLevel: session.thinkingLevel ?? "none",
      }),
      primaryAgent: {
        modelConfig: {
          name: "old-model",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          apiKey: "sk-anthropic",
        },
      },
      thinkingLevel: "medium",
    };

    const promptCommandPicker = vi.fn(async () => undefined);
    const ctx = {
      ...makeContext(registry, session),
      promptCommandPicker,
    };
    await cmd!.handler(ctx, "my-openai");

    expect(switchModel).toHaveBeenCalledWith("my-openai");
    expect(session.primaryAgent.modelConfig.name).toBe("my-openai");
    expect(promptCommandPicker).toHaveBeenCalledTimes(1);
  });

  it("still opens thinking depth for an unknown custom model", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd).toBeTruthy();

    const promptCommandPicker = vi.fn(async () => ({ value: "high" }));
    const session: any = {
      config: {
        modelNames: ["jucode:gpt-5"],
        getModel: () => ({
          name: "jucode:gpt-5",
          provider: "jucode",
          model: "gpt-5",
          apiKey: "sk-jucode",
        }),
        listModelEntries: () => ([
          {
            name: "jucode:gpt-5",
            provider: "jucode",
            model: "gpt-5",
            apiKeyRaw: "sk-jucode",
            hasResolvedApiKey: true,
          },
        ]),
      },
      switchModel: vi.fn(),
      setPersistedModelSelection: vi.fn(),
      getGlobalPreferences: () => ({ thinkingLevel: session.thinkingLevel ?? "none" }),
      primaryAgent: {
        modelConfig: {
          name: "jucode:gpt-5",
          provider: "jucode",
          model: "gpt-5",
          apiKey: "sk-jucode",
        },
      },
      thinkingLevel: "none",
    };
    const ctx = { ...makeContext(registry, session), promptCommandPicker };

    await cmd!.handler(ctx, "jucode:gpt-5");

    expect(promptCommandPicker).toHaveBeenCalledTimes(1);
    expect(promptCommandPicker.mock.calls[0]?.[1]).toMatchObject({ inputArea: true });
  });

  it("uses thinking_levels from settings.json without filtering or reordering", async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "swarmflow-thinking-levels-"));
    const swarmflowHome = join(tempHome, ".swarmflow");
    mkdirSync(swarmflowHome, { recursive: true });
    writeFileSync(join(swarmflowHome, "settings.json"), JSON.stringify({
      thinking_levels: ["off", "max", "vendor_custom"],
    }));

    try {
      const registry = buildDefaultRegistry();
      const cmd = registry.lookup("/model");
      expect(cmd).toBeTruthy();
      const promptCommandPicker = vi.fn(async (options: Array<{ value: string }>) => {
        expect(options.map((option) => option.value)).toEqual(["off", "max", "vendor_custom"]);
        return { value: "vendor_custom" };
      });
      const session: any = {
        config: {
          modelNames: ["custom-model"],
          getModel: () => ({ name: "custom-model", provider: "custom", model: "model", apiKey: "key" }),
          listModelEntries: () => ([{
            name: "custom-model",
            provider: "custom",
            model: "model",
            apiKeyRaw: "key",
            hasResolvedApiKey: true,
          }]),
        },
        switchModel: vi.fn(),
        setPersistedModelSelection: vi.fn(),
        getGlobalPreferences: () => ({ thinkingLevel: session.thinkingLevel ?? "off" }),
        primaryAgent: { modelConfig: { name: "custom-model", provider: "custom", model: "model", apiKey: "key" } },
        thinkingLevel: "off",
      };
      await cmd!.handler({
        ...makeContext(registry, session, swarmflowHome),
        promptCommandPicker,
      }, "custom-model");
      expect(session.thinkingLevel).toBe("vendor_custom");
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("does not show built-in models when no models have been added", () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd?.options).toBeTruthy();

    const session = {
      config: {
        modelNames: [],
        listModelEntries: () => [],
      },
      primaryAgent: {
        modelConfig: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          apiKey: "sk-anthropic",
        },
      },
    };

    expect(cmd!.options!({ session })).toEqual([]);
  });

  it("does not show provider preference presets as registered models", () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd?.options).toBeTruthy();

    const config = new Config({
      providerEnvVars: { openai: "OPENAI_API_KEY" },
    });
    const session = {
      config,
      primaryAgent: {
        modelConfig: {
          provider: "openai",
          model: "gpt-5.4",
          apiKey: "sk-openai",
        },
      },
    };

    expect(config.listModelEntries()).toEqual([]);
    expect(cmd!.options!({ session })).toEqual([]);
  });

  it("shows only registered models and preserves provider grouping", () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd?.options).toBeTruthy();

    const session = {
      config: {
        modelNames: ["my-claude"],
        listModelEntries: () => ([
          {
            name: "my-claude",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            apiKeyRaw: "sk-anthropic",
            hasResolvedApiKey: true,
          },
          {
            name: "my-openai",
            provider: "openai",
            model: "gpt-5.4",
            apiKeyRaw: "",
            hasResolvedApiKey: false,
          },
          {
            name: "my-qwen",
            provider: "qwen",
            model: "qwen3.6-plus",
            apiKeyRaw: "sk-qwen",
            hasResolvedApiKey: true,
          },
          {
            name: "my-qwen-intl",
            provider: "qwen-intl",
            model: "qwen3.7-max",
            apiKeyRaw: "sk-qwen-intl",
            hasResolvedApiKey: true,
          },
        ]),
      },
      primaryAgent: {
        modelConfig: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          apiKey: "sk-anthropic",
        },
      },
    };

    const opts = cmd!.options!({ session });
    const anthropic = opts.find((o) => o.value === "anthropic");
    const qwenGroup = opts.find((o) => o.value === "qwen");
    const openai = opts.find((o) => o.value === "openai");

    expect(anthropic).toBeTruthy();
    expect(qwenGroup).toBeTruthy();
    expect(openai).toBeTruthy();
    expect(opts.find((o) => o.value === "kimi")).toBeUndefined();
    expect(anthropic!.children).toHaveLength(1);
    expect(anthropic!.children?.some((c) => c.value === "anthropic:claude-sonnet-4-6")).toBe(true);
    expect(anthropic!.children?.some((c) => c.value === "anthropic:claude-haiku-4-5")).toBe(false);
    expect(openai!.children).toHaveLength(1);
    expect(openai!.children?.some((c) => c.value === "openai:gpt-5.4")).toBe(true);
    expect(openai!.children?.some((c) => c.value === "openai:gpt-5.2")).toBe(false);
    const qwenChina = qwenGroup!.children?.find((o) => o.value === "qwen");
    const qwenIntl = qwenGroup!.children?.find((o) => o.value === "qwen-intl");
    const qwenUs = qwenGroup!.children?.find((o) => o.value === "qwen-us");
    expect(qwenChina?.label).toBe("Qwen China");
    expect(qwenIntl?.label).toBe("Qwen Intl");
    expect(qwenUs).toBeUndefined();
    expect(qwenChina!.children).toHaveLength(1);
    expect(qwenIntl!.children).toHaveLength(1);
    expect(qwenChina!.children?.some((c) => c.value === "qwen:qwen3.6-plus")).toBe(true);
    expect(qwenChina!.children?.some((c) => c.value === "qwen:qwen3.7-max")).toBe(false);
    expect(qwenIntl!.children?.some((c) => c.value === "qwen-intl:qwen3.7-max")).toBe(true);
  });

  it("tracks managed provider keys per exact endpoint instead of sharing them across a group", () => {
    process.env["SWARMFLOW_GLM_API_KEY"] = "glm-cn";

    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd?.options).toBeTruthy();

    const session = {
      config: {
        modelNames: ["glm:glm-5", "glm-code:glm-5"],
        listModelEntries: () => ([
          {
            name: "glm:glm-5",
            provider: "glm",
            model: "glm-5",
            apiKeyRaw: "${GLM_API_KEY}",
            hasResolvedApiKey: false,
          },
          {
            name: "glm-code:glm-5",
            provider: "glm-code",
            model: "glm-5",
            apiKeyRaw: "",
            hasResolvedApiKey: false,
          },
        ]),
      },
      primaryAgent: {
        modelConfig: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          apiKey: "sk-anthropic",
        },
      },
    };

    const opts = cmd!.options!({ session });
    const glmGroup = opts.find((o) => o.value === "glm");
    const glmChina = glmGroup?.children?.find((o) => o.value === "glm");
    const glmChinaCode = glmGroup?.children?.find((o) => o.value === "glm-code");

    expect(glmChina).toBeTruthy();
    expect(glmChinaCode).toBeTruthy();
    expect(glmChina!.children?.some((c) => c.label.includes("key missing"))).toBe(false);
    expect(glmChinaCode!.children?.every((c) => c.label.includes("key missing"))).toBe(true);
  });

  it("groups registered OpenRouter models by vendor prefix into three-level hierarchy", () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd?.options).toBeTruthy();

    const session = {
      config: {
        modelNames: [
          "openrouter:anthropic/claude-haiku-4.5",
          "openrouter:anthropic/claude-sonnet-4.6",
          "openrouter:openai/gpt-5.4",
          "openrouter:openai/gpt-5.3-codex",
          "openrouter:qwen/qwen3.6-plus",
          "openrouter:qwen/qwen3.7-max",
          "openrouter:moonshotai/kimi-k2.5",
          "openrouter:minimax/minimax-m2.5",
          "openrouter:z-ai/glm-5",
        ],
        listModelEntries: () => ([
          "anthropic/claude-haiku-4.5",
          "anthropic/claude-sonnet-4.6",
          "openai/gpt-5.4",
          "openai/gpt-5.3-codex",
          "qwen/qwen3.6-plus",
          "qwen/qwen3.7-max",
          "moonshotai/kimi-k2.5",
          "minimax/minimax-m2.5",
          "z-ai/glm-5",
        ].map((model) => ({
          name: `openrouter:${model}`,
          provider: "openrouter",
          model,
          apiKeyRaw: "",
          hasResolvedApiKey: false,
        }))),
      },
      primaryAgent: {
        modelConfig: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          apiKey: "sk-anthropic",
        },
      },
    };

    const opts = cmd!.options!({ session });
    const openrouter = opts.find((o) => o.value === "openrouter");
    expect(openrouter).toBeTruthy();

    // OpenRouter children are now vendor sub-groups.
    const vendorAnthro = openrouter!.children?.find((c) => c.value === "openrouter-anthropic");
    const vendorOpenAI = openrouter!.children?.find((c) => c.value === "openrouter-openai");
    const vendorQwen = openrouter!.children?.find((c) => c.value === "openrouter-qwen");
    const vendorKimi = openrouter!.children?.find((c) => c.value === "openrouter-moonshotai");
    const vendorMiniMax = openrouter!.children?.find((c) => c.value === "openrouter-minimax");
    const vendorGLM = openrouter!.children?.find((c) => c.value === "openrouter-z-ai");

    expect(vendorAnthro).toBeTruthy();
    expect(vendorAnthro!.label).toBe("Anthropic");
    expect(vendorAnthro!.children?.some((c) => c.value === "openrouter:anthropic/claude-haiku-4.5")).toBe(true);
    expect(vendorAnthro!.children?.some((c) => c.value === "openrouter:anthropic/claude-sonnet-4.6")).toBe(true);

    expect(vendorOpenAI).toBeTruthy();
    expect(vendorOpenAI!.label).toBe("OpenAI");
    expect(vendorOpenAI!.children?.some((c) => c.value === "openrouter:openai/gpt-5.4")).toBe(true);
    expect(vendorOpenAI!.children?.some((c) => c.value === "openrouter:openai/gpt-5.3-codex")).toBe(true);

    expect(vendorQwen).toBeTruthy();
    expect(vendorQwen!.label).toBe("Qwen");
    expect(vendorQwen!.children?.some((c) => c.value === "openrouter:qwen/qwen3.6-plus")).toBe(true);
    expect(vendorQwen!.children?.some((c) => c.value === "openrouter:qwen/qwen3.7-max")).toBe(true);

    expect(vendorKimi).toBeTruthy();
    expect(vendorKimi!.label).toBe("Kimi");
    expect(vendorKimi!.children?.some((c) => c.value === "openrouter:moonshotai/kimi-k2.5")).toBe(true);

    expect(vendorMiniMax).toBeTruthy();
    expect(vendorMiniMax!.label).toBe("MiniMax");
    expect(vendorMiniMax!.children?.some((c) => c.value === "openrouter:minimax/minimax-m2.5")).toBe(true);

    expect(vendorGLM).toBeTruthy();
    expect(vendorGLM!.label).toBe("GLM / Zhipu");
  });

  it("blocks switching to provider:model when provider API key is missing", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd).toBeTruthy();

    const switchModel = vi.fn();
    const session = {
      config: {
        modelNames: ["my-claude"],
        listModelEntries: () => ([
          {
            name: "my-claude",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            apiKeyRaw: "sk-anthropic",
            hasResolvedApiKey: true,
          },
        ]),
      },
      switchModel,
      resetForNewSession: vi.fn(),
      primaryAgent: {
        modelConfig: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          apiKey: "sk-anthropic",
        },
      },
    };

    const ctx = makeContext(registry, session);
    await cmd!.handler(ctx, "openai:gpt-5.4");

    const rendered = (ctx.showMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(rendered).toContain("Missing API key for provider 'openai'");
    expect(switchModel).not.toHaveBeenCalled();
  });

  it("prompts for a managed provider key during /model and switches after importing a detected key", async () => {
    process.env["GLM_CODE_API_KEY"] = "glm-code-detected";
    const tempHome = mkdtempSync(join(tmpdir(), "swarmflow-model-home-"));
    const swarmflowHome = join(tempHome, ".swarmflow");
    mkdirSync(swarmflowHome, { recursive: true });

    try {
      const registry = buildDefaultRegistry();
      const cmd = registry.lookup("/model");
      expect(cmd).toBeTruthy();

      const upsertModelRaw = vi.fn();
      const switchModel = vi.fn();
      const resetForNewSession = vi.fn();
      const promptSelect = vi.fn(async () => "import:GLM_CODE_API_KEY");
      const promptSecret = vi.fn();
      const session = {
        config: {
          modelNames: [],
          listModelEntries: () => [],
          upsertModelRaw,
        },
        switchModel: (name: string) => {
          switchModel(name);
          (session.primaryAgent as any).modelConfig = {
            name,
            provider: "glm-code",
            model: "glm-5",
            contextLength: 200000,
            apiKey: "glm-code-detected",
          };
        },
        resetForNewSession,
        primaryAgent: {
          modelConfig: {
            name: "my-claude",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            contextLength: 200000,
            apiKey: "sk-anthropic",
          },
        },
      };

      const ctx = {
        ...makeContext(registry, session, swarmflowHome),
        promptSelect,
        promptSecret,
      };

      await cmd!.handler(ctx, "glm-code:glm-5");

      expect(promptSelect).toHaveBeenCalledTimes(1);
      expect(promptSecret).not.toHaveBeenCalled();
      expect(process.env["SWARMFLOW_GLM_CODE_API_KEY"]).toBe("glm-code-detected");
      expect(readFileSync(join(swarmflowHome, ".env"), "utf-8")).toContain(
        "SWARMFLOW_GLM_CODE_API_KEY=glm-code-detected",
      );
      expect(upsertModelRaw).toHaveBeenCalledWith(
        "runtime-glm-code-glm-5",
        expect.objectContaining({
          provider: "glm-code",
          model: "glm-5",
          api_key: "${SWARMFLOW_GLM_CODE_API_KEY}",
        }),
      );
      expect(switchModel).toHaveBeenCalledWith("runtime-glm-code-glm-5");
      expect(resetForNewSession).not.toHaveBeenCalled();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("rejects inline API key syntax and asks the user to use init or the picker", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd).toBeTruthy();

    const upsertModelRaw = vi.fn();
    const switchModel = vi.fn();
    const resetForNewSession = vi.fn();
    const session = {
      config: {
        modelNames: [],
        listModelEntries: () => [],
        upsertModelRaw,
      },
      switchModel: (name: string) => {
        switchModel(name);
        (session.primaryAgent as any).modelConfig = {
          name,
          provider: "openai",
          model: "gpt-5.2-codex",
          contextLength: 400000,
          apiKey: "sk-inline",
        };
      },
      resetForNewSession,
      primaryAgent: {
        modelConfig: {
          name: "my-claude",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          contextLength: 200000,
          apiKey: "sk-anthropic",
        },
      },
    };

    const ctx = makeContext(registry, session);
    await cmd!.handler(ctx, "openai:gpt-5.2-codex key=sk-inline");

    const rendered = (ctx.showMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(rendered).toContain("Inline API keys in `/model` are no longer supported.");
    expect(upsertModelRaw).not.toHaveBeenCalled();
    expect(switchModel).not.toHaveBeenCalled();
    expect(resetForNewSession).not.toHaveBeenCalled();
  });

  it("preserves configured settings and writes model selection state after model switch", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd).toBeTruthy();

    process.env["SWARMFLOW_GLM_CODE_API_KEY"] = "glm-test-key";
    const tempHome = mkdtempSync(join(tmpdir(), "swarmflow-model-home-"));
    const swarmflowHome = join(tempHome, ".swarmflow");
    mkdirSync(join(swarmflowHome, "state"), { recursive: true });
    writeFileSync(join(swarmflowHome, "settings.json"), JSON.stringify({
      providers: {
        glm: { api_key_env: "GLM_API_KEY" },
        lmstudio: {
          base_url: "http://localhost:1234/v1",
          model: "qwen/qwen3.5-9b",
          context_length: 260000,
        },
      },
      context_budget_percent: 75,
    }, null, 2));

    try {
      const switchModel = vi.fn();
      const resetForNewSession = vi.fn();

      const session = {
        config: {
          modelNames: [],
          listModelEntries: () => [],
          upsertModelRaw: vi.fn(),
        },
        switchModel: (name: string) => {
          switchModel(name);
          (session.primaryAgent as any).modelConfig = {
            name,
            provider: "glm-code",
            model: "glm-5",
            contextLength: 200000,
            apiKey: "glm-test-key",
          };
        },
        setPersistedModelSelection: vi.fn(),
        getGlobalPreferences: () => ({
          version: 1,
          modelConfigName: "runtime-glm-code-glm-5",
          modelProvider: "glm-code",
          modelSelectionKey: "glm-5",
          modelId: "glm-5",
          thinkingLevel: "default",
        }),
        resetForNewSession,
        primaryAgent: {
          modelConfig: {
            name: "my-lmstudio",
            provider: "lmstudio",
            model: "qwen/qwen3.5-9b",
            contextLength: 260000,
            apiKey: "local",
          },
        },
      };

      const ctx = {
        ...makeContext(registry, session, swarmflowHome),
        store: {
          clearSession: vi.fn(),
        },
      };

      await cmd!.handler(ctx, "glm-code:glm-5");

      const persistedSettings = JSON.parse(readFileSync(join(swarmflowHome, "settings.json"), "utf-8"));
      expect(persistedSettings).toEqual({
        providers: {
          glm: { api_key_env: "GLM_API_KEY" },
          "glm-code": {
            api_key_env: "SWARMFLOW_GLM_CODE_API_KEY",
            currentModel: {
              configName: "runtime-glm-code-glm-5",
              model: "glm-5",
              thinkingDepth: "default",
            },
            models: [{ id: "glm-5", context_length: 128000 }],
          },
          lmstudio: {
            base_url: "http://localhost:1234/v1",
            model: "qwen/qwen3.5-9b",
            context_length: 260000,
          },
        },
        context_budget_percent: 75,
        currentProvider: "glm-code",
      });

      // 模型选择只落 settings.json；旧的 state/model-selection.json 不再生成。
      expect(existsSync(join(swarmflowHome, "state", "model-selection.json"))).toBe(false);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("switches a user supplied model id without packaged preset overrides", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-anthropic";
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd).toBeTruthy();

    const upsertModelRaw = vi.fn();
    const switchModel = vi.fn();
    const resetForNewSession = vi.fn();
    const session = {
      config: {
        modelNames: [],
        listModelEntries: () => [],
        upsertModelRaw,
      },
      switchModel: (name: string) => {
        switchModel(name);
        (session.primaryAgent as any).modelConfig = {
          name,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          contextLength: 1_000_000,
          apiKey: "sk-inline",
        };
      },
      resetForNewSession,
      primaryAgent: {
        modelConfig: {
          name: "my-openai",
          provider: "openai",
          model: "gpt-5.2",
          contextLength: 400000,
          apiKey: "sk-openai",
        },
      },
    };

      const ctx = makeContext(registry, session);
    await cmd!.handler(ctx, "anthropic:claude-sonnet-4-6-1m");

    expect(upsertModelRaw).toHaveBeenCalledWith(
      "runtime-anthropic-claude-sonnet-4-6-1m",
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-sonnet-4-6-1m",
        api_key: "${ANTHROPIC_API_KEY}",
      }),
    );
    expect(switchModel).toHaveBeenCalledWith("runtime-anthropic-claude-sonnet-4-6-1m");
    expect(resetForNewSession).not.toHaveBeenCalled();
  });

  it("reuses provider key from existing model when switching to another model in same provider", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd).toBeTruthy();

    const upsertModelRaw = vi.fn();
    const switchModel = vi.fn();
    const resetForNewSession = vi.fn();
    const session = {
      config: {
        modelNames: ["my-openai"],
        listModelEntries: () => ([
          {
            name: "my-openai",
            provider: "openai",
            model: "gpt-5.2",
            apiKeyRaw: "${OPENAI_API_KEY}",
            hasResolvedApiKey: true,
          },
        ]),
        upsertModelRaw,
      },
      switchModel: (name: string) => {
        switchModel(name);
        (session.primaryAgent as any).modelConfig = {
          name,
          provider: "openai",
          model: "gpt-5.2-codex",
          contextLength: 400000,
          apiKey: "sk-openai",
        };
      },
      resetForNewSession,
      primaryAgent: {
        modelConfig: {
          name: "my-openai",
          provider: "openai",
          model: "gpt-5.2",
          contextLength: 400000,
          apiKey: "sk-openai",
        },
      },
    };

    const ctx = makeContext(registry, session);
    await cmd!.handler(ctx, "openai:gpt-5.2-codex");

    expect(upsertModelRaw).toHaveBeenCalledWith(
      "runtime-openai-gpt-5-2-codex",
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.2-codex",
        api_key: "${OPENAI_API_KEY}",
      }),
    );
    expect(switchModel).toHaveBeenCalledWith("runtime-openai-gpt-5-2-codex");
    expect(resetForNewSession).not.toHaveBeenCalled();
  });

  it("keeps user supplied OpenRouter model ids unchanged", async () => {
    process.env["OPENROUTER_API_KEY"] = "sk-openrouter";
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd).toBeTruthy();

    const upsertModelRaw = vi.fn();
    const switchModel = vi.fn();
    const resetForNewSession = vi.fn();
    const session = {
      config: {
        modelNames: [],
        listModelEntries: () => [],
        upsertModelRaw,
      },
      switchModel: (name: string) => {
        switchModel(name);
        (session.primaryAgent as any).modelConfig = {
          name,
          provider: "openrouter",
          model: "anthropic/claude-sonnet-4.6",
          contextLength: 1_000_000,
          apiKey: "sk-inline",
        };
      },
      resetForNewSession,
      primaryAgent: {
        modelConfig: {
          name: "my-openai",
          provider: "openai",
          model: "gpt-5.2",
          contextLength: 400000,
          apiKey: "sk-openai",
        },
      },
    };

    const ctx = makeContext(registry, session);
    await cmd!.handler(ctx, "openrouter:anthropic/claude-sonnet-4-6");

    expect(upsertModelRaw).toHaveBeenCalledWith(
      "runtime-openrouter-anthropic-claude-sonnet-4-6",
      expect.objectContaining({
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4-6",
        api_key: "${OPENROUTER_API_KEY}",
      }),
    );
    expect(switchModel).toHaveBeenCalledWith("runtime-openrouter-anthropic-claude-sonnet-4-6");
    expect(resetForNewSession).not.toHaveBeenCalled();
  });
});

describe("/provider command", () => {
  it("uses the Chinese language table for the third-party provider flow by default", () => {
    const registry = buildDefaultRegistry();
    const provider = registry.lookup("/provider");
    expect(provider?.options).toBeTruthy();

    const options = provider!.options!({
      session: { config: new Config({}) },
      swarmflowHomeDir: "F:/tmp/swarmflow-provider-language-home",
    });
    const custom = options.find((option) => option.value === "__protocol__");

    expect(custom?.label).toBe("按协议添加第三方供应商");
    expect(custom?.children?.map((option) => option.label)).toEqual([
      "Anthropic Messages 接口",
      "OpenAI Chat Completions 接口",
      "OpenAI Responses API 接口",
      "Gemini generateContent 接口",
    ]);
  });
});

describe("/rename command", () => {
  it("allows naming an empty session before the first conversation turn", async () => {
    const registry = buildDefaultRegistry();
    const rename = registry.lookup("/rename");
    const session = {
      turnCount: 0,
      setTitle: vi.fn(),
      getDisplayName: () => "New session",
    };
    const appendSwitchCommandEcho = vi.fn();

    await rename!.handler({
      ...makeContext(registry, session),
      appendSwitchCommandEcho,
    }, "Before chat");

    expect(session.setTitle).toHaveBeenCalledWith("Before chat");
    expect(appendSwitchCommandEcho).toHaveBeenCalledWith("/rename", "Before chat");
  });
});
