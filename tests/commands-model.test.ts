import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

    expect(config.listModelEntries().every((entry) => entry.isPreset)).toBe(true);
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
    expect(anthropic!.children?.some((c) => c.label.includes("Claude Sonnet 4.6  (current)"))).toBe(true);
    expect(anthropic!.children?.some((c) => c.label.includes("Claude Haiku 4.5"))).toBe(false);
    expect(openai!.children).toHaveLength(1);
    expect(openai!.children?.some((c) => c.label.includes("GPT-5.4"))).toBe(true);
    expect(openai!.children?.some((c) => c.label.includes("GPT-5.2"))).toBe(false);
    const qwenChina = qwenGroup!.children?.find((o) => o.value === "qwen");
    const qwenIntl = qwenGroup!.children?.find((o) => o.value === "qwen-intl");
    const qwenUs = qwenGroup!.children?.find((o) => o.value === "qwen-us");
    expect(qwenChina?.label).toBe("Qwen China");
    expect(qwenIntl?.label).toBe("Qwen Intl");
    expect(qwenUs).toBeUndefined();
    expect(qwenChina!.children).toHaveLength(1);
    expect(qwenIntl!.children).toHaveLength(1);
    expect(qwenChina!.children?.some((c) => c.label.includes("Qwen3.6 Plus"))).toBe(true);
    expect(qwenChina!.children?.some((c) => c.label.includes("Qwen3.7 Max"))).toBe(false);
    expect(qwenIntl!.children?.some((c) => c.label.includes("Qwen3.7 Max"))).toBe(true);
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
    expect(vendorAnthro!.children?.some((c) => c.label.startsWith("Claude Haiku 4.5"))).toBe(true);
    expect(vendorAnthro!.children?.some((c) => c.label.includes("Claude Sonnet 4.6  (1M context)"))).toBe(true);

    expect(vendorOpenAI).toBeTruthy();
    expect(vendorOpenAI!.label).toBe("OpenAI");
    expect(vendorOpenAI!.children?.some((c) => c.label.startsWith("GPT-5.4"))).toBe(true);
    expect(vendorOpenAI!.children?.some((c) => c.label.startsWith("GPT-5.3 Codex"))).toBe(true);

    expect(vendorQwen).toBeTruthy();
    expect(vendorQwen!.label).toBe("Qwen");
    expect(vendorQwen!.children?.some((c) => c.label.startsWith("Qwen3.6 Plus"))).toBe(true);
    expect(vendorQwen!.children?.some((c) => c.label.startsWith("Qwen3.7 Max"))).toBe(true);

    expect(vendorKimi).toBeTruthy();
    expect(vendorKimi!.label).toBe("Kimi");
    expect(vendorKimi!.children?.some((c) => c.label.startsWith("Kimi K2.5"))).toBe(true);

    expect(vendorMiniMax).toBeTruthy();
    expect(vendorMiniMax!.label).toBe("MiniMax");
    expect(vendorMiniMax!.children?.some((c) => c.label.startsWith("MiniMax M2.5"))).toBe(true);

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
          lmstudio: {
            base_url: "http://localhost:1234/v1",
            model: "qwen/qwen3.5-9b",
            context_length: 260000,
          },
        },
        context_budget_percent: 75,
      });

      const persistedState = JSON.parse(
        readFileSync(join(swarmflowHome, "state", "model-selection.json"), "utf-8"),
      );
      expect(persistedState).toEqual({
        config_name: "runtime-glm-code-glm-5",
        provider: "glm-code",
        selection_key: "glm-5",
        model_id: "glm-5",
        thinking_level: "default",
      });
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("preserves preset-specific overrides for Anthropic 1M variants", async () => {
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
        model: "claude-sonnet-4-6",
        api_key: "${ANTHROPIC_API_KEY}",
        context_length: 1_000_000,
        betas: ["context-1m-2025-08-07"],
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

  it("maps OpenRouter Anthropic aliases to the official 1M preset config", async () => {
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
        model: "anthropic/claude-sonnet-4.6",
        api_key: "${OPENROUTER_API_KEY}",
        context_length: 1_000_000,
      }),
    );
    expect(switchModel).toHaveBeenCalledWith("runtime-openrouter-anthropic-claude-sonnet-4-6");
    expect(resetForNewSession).not.toHaveBeenCalled();
  });
});
