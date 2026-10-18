import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadGlobalSettings } from "../src/config/persistence.js";

const prompts = vi.hoisted(() => ({ select: vi.fn(), input: vi.fn() }));
vi.mock("@inquirer/prompts", () => prompts);

import { runInitWizard } from "../src/lifecycle/init-wizard.js";

const createdHomes: string[] = [];
afterEach(() => {
  for (const home of createdHomes.splice(0)) rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  prompts.select.mockReset();
  prompts.input.mockReset();
});

describe("init wizard custom provider endpoint", () => {
  it("selects a protocol before URL input and persists its normalized base URL", async () => {
    const home = mkdtempSync(join(tmpdir(), "swarmflow-init-provider-"));
    createdHomes.push(home);
    vi.stubEnv("TAVILY_API_KEY", "test-search-key");
    vi.spyOn(console, "log").mockImplementation(() => {});

    prompts.select
      .mockResolvedValueOnce("zh")
      .mockResolvedValueOnce("brief")
      .mockResolvedValueOnce("yes")
      .mockResolvedValueOnce("anthropic");
    prompts.input
      .mockResolvedValueOnce("Anthropic Relay")
      .mockResolvedValueOnce("https://anthropic.example/v1/messages/")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("claude-test")
      .mockResolvedValueOnce("128000");

    await runInitWizard(home);

    const settings = loadGlobalSettings(home);
    expect(settings.providers?.["anthropic-relay"]).toMatchObject({
      base_url: "https://anthropic.example",
      protocol: "anthropic",
    });
    expect(prompts.select.mock.invocationCallOrder[3]).toBeLessThan(prompts.input.mock.invocationCallOrder[1]);
    expect(prompts.input.mock.calls[1]?.[0].message).toContain("Anthropic Messages");
  });
});
