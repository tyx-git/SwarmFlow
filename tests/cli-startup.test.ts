import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, type MainDeps } from "../src/cli.js";

describe("CLI startup", () => {
  it("dispatches init without update preflight", async () => {
    const events: string[] = [];
    const deps: MainDeps = {
      homeDir: "F:/tmp/swarmflow-test-home",
      loadDotenv: () => events.push("dotenv"),
      runInitWizard: async () => events.push("init"),
    };
    await main(["node", "swarmflow", "init"], deps);
    expect(events).toEqual(["dotenv", "init"]);
  });

  it("runs the first-run wizard when ~/.swarmflow is absent", async () => {
    const events: string[] = [];
    const homeDir = join(tmpdir(), `swarmflow-first-run-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    try {
      await main(["node", "swarmflow"], {
        homeDir,
        loadDotenv: () => undefined,
        loadGlobalSettings: () => ({
          providers: { openai: { api_key_env: "OPENAI_API_KEY", models: [] } },
        }),
        runInitWizard: async (wizardHome) => events.push(`init:${wizardHome}`),
        launchTui: async () => events.push("launch"),
      });

      expect(events).toEqual([`init:${homeDir}`, "launch"]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("reads existing settings without rerunning the wizard when ~/.swarmflow exists", async () => {
    const events: string[] = [];
    const homeDir = mkdtempSync(join(tmpdir(), "swarmflow-existing-home-"));
    try {
      await main(["node", "swarmflow"], {
        homeDir,
        loadDotenv: () => undefined,
        loadGlobalSettings: (dir) => {
          events.push(`load:${dir}`);
          return {};
        },
        runInitWizard: async () => events.push("init"),
        launchTui: async () => events.push("launch"),
      });

      expect(events).toEqual([`load:${homeDir}`, "launch"]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

});
