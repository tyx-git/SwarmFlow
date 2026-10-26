/**
 * æ¬å°æä¾åç«¯ç¹å¥å£çè§èåå¥çº¦ã
 *
 * ææå¼æ¥èª SDK è¯·æ±è·¯å¾çº¦å®ï¼openai SDK æ¼ `<baseURL>/chat/completions`ï¼
 * æ¨¡ååç°èµ° `<base>/models`ï¼ï¼ä¸æ¥èªå®ç°ï¼ç¨æ·åªå¡«å°ä¸»æºåæ¶ï¼
 * ææåå¥å£é½å¿é¡»è½ `/v1`ï¼ä¸ `/provider custom` ä¸ init åå¯¼ä¿æä¸è´ã
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const createdHomes: string[] = [];
let home = "";

const discovery = vi.hoisted(() => ({ fetchModelsFromServer: vi.fn(async () => [] as Array<{ id: string }>) }));
vi.mock("../../src/models/discovery.js", () => discovery);
vi.mock("../../src/config/home-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/home-dir.js")>();
  return { ...actual, getSwarmflowHomeDir: () => home };
});

import { loadGlobalSettings, saveSettings, globalSettingsPath } from "../../src/config/settings/io.js";
import { InitService } from "../../src/lifecycle/init-service.js";
import { cmdModelLocalDiscover } from "../../src/commands/provider/discovery.js";
import { Config } from "../../src/config/loader.js";
import type { CommandContext } from "../../src/commands/types.js";

afterEach(() => {
  for (const dir of createdHomes.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

function tempHome(): string {
  home = mkdtempSync(join(tmpdir(), "swarmflow-local-endpoint-"));
  createdHomes.push(home);
  return home;
}

describe("local provider endpoint entries normalize to /v1", () => {
  it("scans the versioned base URL when the GUI posts a host-only endpoint", async () => {
    tempHome();
    const service = new InitService();

    await service.configureLocalProvider("ollama", "http://localhost:11434");

    expect(discovery.fetchModelsFromServer).toHaveBeenCalledWith(
      "http://localhost:11434/v1",
      expect.anything(),
      expect.anything(),
    );
  });

  it("persists the versioned base URL when the GUI saves a host-only endpoint", () => {
    tempHome();
    saveSettings({ providers: {} }, globalSettingsPath(home));
    const service = new InitService();

    service.saveLocalProvider("ollama", "http://localhost:11434", "llama3", 32768);
    service.saveConfiguration({});

    expect(loadGlobalSettings(home).providers?.ollama?.base_url).toBe("http://localhost:11434/v1");
  });

  it("keeps an already versioned endpoint untouched", async () => {
    tempHome();
    const service = new InitService();

    await service.configureLocalProvider("ollama", "http://localhost:11434/v1");
    expect(discovery.fetchModelsFromServer).toHaveBeenCalledWith(
      "http://localhost:11434/v1",
      expect.anything(),
      expect.anything(),
    );
  });
});

describe("/model local discovery scans the normalized endpoint", () => {
  it("appends /v1 to a host-only custom server URL", async () => {
    tempHome();
    const promptSelect = vi.fn().mockResolvedValueOnce("__custom__");
    const promptSecret = vi.fn().mockResolvedValueOnce("http://192.168.1.7:1234").mockResolvedValueOnce("");
    const showMessage = vi.fn();
    const ctx = {
      session: { config: new Config({}) },
      swarmflowHomeDir: home,
      promptSelect,
      promptSecret,
      showMessage,
      autoSave: vi.fn(),
    } as unknown as CommandContext;

    await cmdModelLocalDiscover(ctx, "lmstudio");

    expect(discovery.fetchModelsFromServer).toHaveBeenCalledWith(
      "http://192.168.1.7:1234/v1",
      expect.anything(),
      expect.anything(),
    );
    expect(showMessage).toHaveBeenCalled();
  });
});
