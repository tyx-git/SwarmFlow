import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const persistSettingsPatch = vi.hoisted(() => vi.fn(() => true));
const setDotenvKey = vi.hoisted(() => vi.fn());
const testEndpoint = vi.hoisted(() => vi.fn(async () => ({ ok: true, detail: "200 OK" })));

vi.mock("../../src/commands/settings-patch.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  persistSettingsPatch,
}));
vi.mock("../../src/lifecycle/dotenv.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  setDotenvKey,
}));
vi.mock("../../src/commands/provider/endpoint.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  testEndpoint,
}));
vi.mock("../../src/models/discovery.js", () => ({
  fetchModelsFromServer: vi.fn(async () => []),
}));

import { buildDefaultRegistry } from "../../src/commands/registration.js";
import { globalSettingsPath, saveSettings } from "../../src/config/settings/io.js";
import { Config } from "../../src/config/loader.js";
import type { CommandContext } from "../../src/commands/types.js";

const PROVIDER_ID = "test-relay";
const createdHomes: string[] = [];

afterEach(() => {
  persistSettingsPatch.mockClear();
  setDotenvKey.mockClear();
  testEndpoint.mockClear();
  for (const home of createdHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** 真实临时目录 + 一个已存在的自定义供应商；两个写入函数换成探针。 */
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "swarmflow-provider-edit-"));
  createdHomes.push(home);
  saveSettings({
    providers: {
      [PROVIDER_ID]: {
        custom: true,
        label: "Test Relay",
        base_url: "https://old.example/v1",
        protocol: "openai-chat",
        models: [{ id: "old-model", context_length: 128000 }],
      },
    },
  }, globalSettingsPath(home));
  return home;
}

/**
 * 队列用完即抛错，而不是返回 undefined —— 否则被取消语义影响的循环会
 * 拿着 undefined 一路 continue，把测试进程跑爆内存。
 */
function scripted<T>(values: T[], exhausted: string): ReturnType<typeof vi.fn> {
  const fn = vi.fn();
  for (const value of values) fn.mockResolvedValueOnce(value);
  fn.mockImplementation(async () => {
    throw new Error(`${exhausted}: mocked prompt queue exhausted`);
  });
  return fn;
}

function makeContext(
  home: string,
  promptSecret: CommandContext["promptSecret"],
  promptSelect: CommandContext["promptSelect"],
): CommandContext {
  return {
    session: { config: new Config({}) },
    showMessage: vi.fn(),
    showHint: vi.fn(),
    autoSave: vi.fn(),
    resetUiState: vi.fn(),
    commandRegistry: buildDefaultRegistry(),
    promptCommandPicker: vi.fn(),
    swarmflowHomeDir: home,
    promptSecret,
    promptSelect,
  } as unknown as CommandContext;
}

/** /provider 的 manage:<id> 入口，动作选择器固定选 edit。 */
async function runEdit(home: string, secrets: Array<string | undefined>) {
  const promptSecret = scripted(secrets, "promptSecret");
  const promptSelect = scripted(["edit"], "promptSelect");
  const command = buildDefaultRegistry().lookup("/provider")!;
  await command.handler(makeContext(home, promptSecret, promptSelect), `manage:${PROVIDER_ID}`);
  return { promptSecret, promptSelect };
}

/** /provider 的 protocol:<wire> 入口：跳过协议选择，直接进新增向导。 */
async function runAddWizard(home: string, secrets: Array<string | undefined>, selectDefault = "__cancel__") {
  const promptSecret = scripted(secrets, "promptSecret");
  const promptSelect = vi.fn().mockResolvedValue(selectDefault);
  const command = buildDefaultRegistry().lookup("/provider")!;
  await command.handler(
    makeContext(home, promptSecret, promptSelect),
    "protocol:openai-chat-completions",
  );
  return { promptSecret, promptSelect };
}

describe("/provider edit discards unsaved input", () => {
  it("writes nothing when the endpoint prompt is cancelled", async () => {
    const { promptSecret } = await runEdit(makeHome(), [undefined]);

    expect(persistSettingsPatch).not.toHaveBeenCalled();
    expect(setDotenvKey).not.toHaveBeenCalled();
    expect(testEndpoint).not.toHaveBeenCalled();
    // 取消即终止整个编辑，不该再追问 API key。
    expect(promptSecret).toHaveBeenCalledTimes(1);
  });

  it("drops an already entered endpoint when the key prompt is cancelled", async () => {
    await runEdit(makeHome(), ["https://new.example/v1", undefined]);

    expect(persistSettingsPatch).not.toHaveBeenCalled();
    expect(setDotenvKey).not.toHaveBeenCalled();
  });

  it("writes nothing when both inputs are left empty", async () => {
    await runEdit(makeHome(), ["", ""]);

    expect(persistSettingsPatch).not.toHaveBeenCalled();
    expect(setDotenvKey).not.toHaveBeenCalled();
    expect(testEndpoint).not.toHaveBeenCalled();
  });

  it("saves once when a new endpoint is submitted", async () => {
    await runEdit(makeHome(), ["https://new.example/v1", ""]);

    expect(persistSettingsPatch).toHaveBeenCalledTimes(1);
    const [patch] = persistSettingsPatch.mock.calls[0]!;
    expect(patch.providers?.[PROVIDER_ID]?.base_url).toBe("https://new.example/v1");
    expect(setDotenvKey).not.toHaveBeenCalled();
  });

  it("saves the key slot when a new key is submitted", async () => {
    await runEdit(makeHome(), ["", "sk-new"]);

    expect(setDotenvKey).toHaveBeenCalledTimes(1);
    expect(setDotenvKey.mock.calls[0]![0]).toBe("SWARMFLOW_CUSTOM_TEST_RELAY_KEY");
    const [patch] = persistSettingsPatch.mock.calls[0]!;
    expect(patch.providers?.[PROVIDER_ID]?.api_key).toBe("${SWARMFLOW_CUSTOM_TEST_RELAY_KEY}");
    expect(patch.providers?.[PROVIDER_ID]?.base_url).toBe("https://old.example/v1");
  });
});

describe("/provider add wizard discards cancelled key prompt", () => {
  it("stops before the model step when the API key prompt is cancelled", async () => {
    const { promptSelect } = await runAddWizard(makeHome(), ["Wizard Relay", "https://chat.example/v1", undefined]);

    expect(persistSettingsPatch).not.toHaveBeenCalled();
    expect(setDotenvKey).not.toHaveBeenCalled();
    // 取消不该继续走到模型选择。
    expect(promptSelect).not.toHaveBeenCalled();
  });

  it("keeps going when the API key prompt is submitted empty", async () => {
    const { promptSelect } = await runAddWizard(makeHome(), ["Wizard Relay", "https://chat.example/v1", ""]);

    // 留空表示「不使用密钥」，流程应继续到模型选择器。
    expect(promptSelect).toHaveBeenCalled();
    expect(persistSettingsPatch).not.toHaveBeenCalled();
  });
});
