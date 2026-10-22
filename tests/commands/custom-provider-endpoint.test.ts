import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDefaultRegistry } from "../../src/commands/registration.js";
import type { CommandContext } from "../../src/commands/types.js";
import { globalSettingsPath, loadGlobalSettings, saveSettings } from "../../src/config/settings/io.js";
import { Config } from "../../src/config/loader.js";
import { createProvider } from "../../src/providers/registry.js";
import { OpenAIResponsesProvider } from "../../src/providers/openai-responses.js";

vi.mock("../../src/models/discovery.js", () => ({
  fetchModelsFromServer: vi.fn(async () => []),
}));

const endpoints = [
  {
    name: "OpenAI Chat Completions",
    protocol: "openai-chat-completions",
    full: "https://chat.example/v1/chat/completions",
    base: "https://chat.example/v1",
    expected: "https://chat.example/v1",
  },
  {
    name: "OpenAI Responses",
    protocol: "openai-responses",
    full: "https://responses.example/v1/responses",
    base: "https://responses.example/v1",
    expected: "https://responses.example/v1",
  },
  {
    name: "Anthropic Messages",
    protocol: "anthropic-messages",
    full: "https://anthropic.example/v1/messages",
    base: "https://anthropic.example/v1",
    expected: "https://anthropic.example",
  },
  {
    name: "Gemini generateContent",
    protocol: "gemini-generate-content",
    full: "https://gemini.example/v1beta/models/gemini-pro:generateContent",
    base: "https://gemini.example/v1beta",
    expected: "https://gemini.example/v1beta",
  },
] as const;

const createdHomes: string[] = [];
afterEach(() => {
  for (const home of createdHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function addProvider(protocol: string, endpoint: string, label = "Test Relay") {
  const home = mkdtempSync(join(tmpdir(), "swarmflow-custom-provider-"));
  createdHomes.push(home);
  const registry = buildDefaultRegistry();
  const command = registry.lookup("/provider")!;
  const promptSecret = vi.fn()
    .mockResolvedValueOnce(label)
    .mockResolvedValueOnce(endpoint)
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("test-model");
  const promptSelect = vi.fn()
    .mockResolvedValueOnce(protocol)
    .mockResolvedValueOnce("__manual__")
    .mockResolvedValueOnce("128000")
    .mockResolvedValueOnce("no")
    .mockResolvedValueOnce("__skip__")
    .mockResolvedValueOnce("__done__");
  const config = new Config({});
  const upsertModelRaw = vi.spyOn(config, "upsertModelRaw");
  const context = {
    session: { config },
    showMessage: vi.fn(),
    autoSave: vi.fn(),
    resetUiState: vi.fn(),
    commandRegistry: registry,
    promptCommandPicker: vi.fn(),
    swarmflowHomeDir: home,
    promptSecret,
    promptSelect,
  } as unknown as CommandContext;

  await command.handler(context, "__add_provider__");
  return { home, promptSecret, promptSelect, config, upsertModelRaw };
}

describe("custom provider endpoint persistence", () => {
  it.each(endpoints)("stores the normalized full $name endpoint", async ({ protocol, full, expected }) => {
    const { home, promptSecret, promptSelect } = await addProvider(protocol, full);
    expect(loadGlobalSettings(home).providers?.["test-relay"]?.base_url).toBe(expected);
    expect(promptSelect.mock.invocationCallOrder[0]).toBeLessThan(promptSecret.mock.invocationCallOrder[1]);
    const protocolLabel = protocol === "openai-chat-completions" ? "Chat Completions"
      : protocol === "openai-responses" ? "Responses API"
        : protocol === "anthropic-messages" ? "Anthropic Messages" : "Gemini generateContent";
    expect(promptSecret.mock.calls[1]?.[0].message).toContain(protocolLabel);
  });

  it("marks dynamically registered DeepSeek models custom and dispatches by protocol", async () => {
    const { config, upsertModelRaw } = await addProvider("openai-responses", "https://responses.example/v1", "DeepSeek");
    const registered = upsertModelRaw.mock.calls.find(([name]) => name === "deepseek:test-model");

    expect(registered?.[1]).toEqual(expect.objectContaining({
      provider: "deepseek",
      model: "test-model",
      custom: true,
      transport_protocol: "responses",
    }));

    const modelConfig = config.getModel("deepseek:test-model");
    expect(modelConfig.custom).toBe(true);
    expect(createProvider(modelConfig)).toBeInstanceOf(OpenAIResponsesProvider);
  });

  it.each(endpoints)("stores the normalized $name base URL", async ({ protocol, base, expected }) => {
    const { home } = await addProvider(protocol, base);
    expect(loadGlobalSettings(home).providers?.["test-relay"]?.base_url).toBe(expected);
  });

  it("normalizes the retained historical full Responses URL when the new endpoint is left empty", async () => {
    const home = mkdtempSync(join(tmpdir(), "swarmflow-custom-provider-edit-"));
    createdHomes.push(home);
    saveSettings({
      providers: {
        deepseek: {
          custom: true,
          label: "DeepSeek",
          base_url: "https://responses.example/v1/responses",
          protocol: "openai-responses",
          models: [{ id: "test-model", context_length: 128000 }],
        },
      },
    }, globalSettingsPath(home));

    const registry = buildDefaultRegistry();
    const command = registry.lookup("/provider")!;
    const config = new Config({});
    const upsertModelRaw = vi.spyOn(config, "upsertModelRaw");
    const promptSecret = vi.fn()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");
    const promptSelect = vi.fn().mockResolvedValueOnce("edit");
    const context = {
      session: { config },
      showMessage: vi.fn(),
      autoSave: vi.fn(),
      resetUiState: vi.fn(),
      commandRegistry: registry,
      promptCommandPicker: vi.fn(),
      swarmflowHomeDir: home,
      promptSecret,
      promptSelect,
    } as unknown as CommandContext;

    await command.handler(context, "manage:deepseek");

    const normalizedBaseUrl = "https://responses.example/v1";
    expect(loadGlobalSettings(home).providers?.deepseek?.base_url).toBe(normalizedBaseUrl);
    expect(upsertModelRaw).toHaveBeenCalledWith("deepseek:test-model", expect.objectContaining({
      custom: true,
      base_url: normalizedBaseUrl,
      transport_protocol: "responses",
    }));
    const modelConfig = config.getModel("deepseek:test-model");
    expect(modelConfig.custom).toBe(true);
    expect(createProvider(modelConfig)).toBeInstanceOf(OpenAIResponsesProvider);
  });

  it("normalizes an edited endpoint using the provider's saved protocol", async () => {
    const home = mkdtempSync(join(tmpdir(), "swarmflow-custom-provider-edit-"));
    createdHomes.push(home);
    saveSettings({
      providers: {
        relay: {
          custom: true,
          label: "Relay",
          base_url: "https://responses.example/v1",
          protocol: "openai-responses",
          models: [{ id: "test-model", context_length: 128000 }],
        },
      },
    }, globalSettingsPath(home));

    const registry = buildDefaultRegistry();
    const command = registry.lookup("/provider")!;
    const config = new Config({});
    const upsertModelRaw = vi.spyOn(config, "upsertModelRaw");
    const promptSecret = vi.fn()
      .mockResolvedValueOnce("https://responses.example/v2/responses/")
      .mockResolvedValueOnce("");
    const promptSelect = vi.fn().mockResolvedValueOnce("edit");
    const context = {
      session: { config },
      showMessage: vi.fn(),
      autoSave: vi.fn(),
      resetUiState: vi.fn(),
      commandRegistry: registry,
      promptCommandPicker: vi.fn(),
      swarmflowHomeDir: home,
      promptSecret,
      promptSelect,
    } as unknown as CommandContext;

    await command.handler(context, "manage:relay");

    expect(loadGlobalSettings(home).providers?.relay?.base_url).toBe("https://responses.example/v2");
    expect(promptSecret.mock.calls[0]?.[0].message).toContain("OpenAI Responses");
  });
});
