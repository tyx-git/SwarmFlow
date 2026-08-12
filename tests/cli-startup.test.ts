import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, resolveOpenTuiEntry, type MainDeps } from "../src/cli.js";
import type { ApplyStagedResult } from "../src/lifecycle/update-check.js";
import { VERSION } from "../src/version.js";

let tempHome = "";
let events: string[] = [];
let stagedResult: ApplyStagedResult = { kind: "none" };

let settings: Record<string, unknown> = {};
let hasGitHubTokens = true;
let serverCalls: unknown[] = [];

function writeSettings(next: Record<string, unknown>): void {
  settings = next;
  mkdirSync(tempHome, { recursive: true });
  writeFileSync(join(tempHome, "settings.json"), JSON.stringify(next, null, 2));
}

function startupDeps(extra: MainDeps = {}): MainDeps {
  return {
    homeDir: tempHome,
    loadDotenv: () => {
      events.push("dotenv");
      process.env["SWARMFLOW_TEST_KEY"] = "loaded";
    },
    loadGlobalSettings: () => settings,
    applyStaged: () => {
      events.push("applyStaged");
      return stagedResult;
    },
    checkForUpdates: () => {
      events.push("checkForUpdates");
      return () => ({ phase: "idle" as const, currentVersion: "0.0.0" });
    },
    runInitWizard: async () => {
      events.push(`init:${process.env["SWARMFLOW_TEST_KEY"] ?? "missing"}`);
      writeSettings({
        providers: {
          openai: { api_key_env: "SWARMFLOW_TEST_KEY" },
        },
        auto_update: true,
      });
    },
    runServerMode: async (opts) => {
      events.push("server");
      serverCalls.push(opts);
    },
    hasGitHubTokens: () => hasGitHubTokens,
    ...extra,
  };
}

describe("CLI startup", () => {
  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "swarmflow-cli-home-"));
    events = [];
    stagedResult = { kind: "none" };

    settings = {};
    hasGitHubTokens = true;
    serverCalls = [];
    delete process.env["SWARMFLOW_RESUME_SESSION_DIR"];
    delete process.env["SWARMFLOW_TEST_KEY"];
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    delete process.env["SWARMFLOW_RESUME_SESSION_DIR"];
    delete process.env["SWARMFLOW_TEST_KEY"];
  });

  it("loads dotenv before dispatching the init subcommand", async () => {
    await main(["node", "swarmflow", "init"], startupDeps());

    expect(events).toEqual(["dotenv", "init:loaded"]);
  });

  it("runs startup preflight before launching the TUI", async () => {
    writeSettings({
      providers: {
        openai: { api_key_env: "SWARMFLOW_TEST_KEY" },
      },
      auto_update: true,
    });
    stagedResult = { kind: "applied", version: "9.9.9" };


    await main(["node", "swarmflow"], startupDeps({
      launchTui: async () => {
        events.push("launch");
      },
    }));

    expect(events).toEqual([
      "dotenv",
      "applyStaged",
      "checkForUpdates",

      "launch",
    ]);
  });

  it("relaunches after applying a staged update before launching the TUI", async () => {
    writeSettings({
      providers: {
        openai: { api_key_env: "SWARMFLOW_TEST_KEY" },
      },
      auto_update: true,
    });
    stagedResult = { kind: "applied", version: "9.9.9" };

    await main(["node", "swarmflow", "--verbose"], startupDeps({
      relaunchAfterUpdate: (argv) => {
        events.push(`relaunch:${argv.slice(2).join(" ")}`);
      },
      launchTui: async () => {
        events.push("launch");
      },
    }));

    expect(events).toEqual([
      "dotenv",
      "applyStaged",
      "relaunch:--verbose",
    ]);
  });

  it("runs the init wizard once before launch when no providers are configured", async () => {
    writeSettings({ auto_update: true });

    await main(["node", "swarmflow"], startupDeps({
      launchTui: async () => {
        events.push("launch");
      },
    }));

    expect(events).toEqual([
      "dotenv",
      "applyStaged",
      "checkForUpdates",
      "init:loaded",

      "launch",
    ]);
  });

  it("routes server mode before TUI startup preflight", async () => {
    await main([
      "node",
      "swarmflow",
      "--server",
      "--work-dir",
      "/tmp/swarmflow-work",
      "-c",
      "context_budget_percent=50",
    ], startupDeps({
      launchTui: async () => {
        events.push("launch");
      },
    }));

    expect(events).toEqual(["server"]);
    expect(serverCalls).toEqual([{
      workDir: "/tmp/swarmflow-work",
      sessionId: undefined,
      selectedModel: undefined,
      selectedAgent: undefined,
      templates: undefined,
      configOverrides: ["context_budget_percent=50"],
    }]);
  });

  it("resolves --resume before launching the TUI", async () => {
    writeSettings({
      providers: {
        openai: { api_key_env: "SWARMFLOW_TEST_KEY" },
      },
      auto_update: false,
    });
    const sessionId = "00000000-0000-7000-8000-000000000001";
    const sessionDir = join(tempHome, "projects", "demo_123456", sessionId);

    await main(["node", "swarmflow", "--resume", sessionId], startupDeps({
      findSessionById: (id) => id === sessionId
        ? {
            sessionDir,
            projectDir: join(tempHome, "projects", "demo_123456"),
            projectPath: process.cwd(),
            title: "Demo",
          }
        : null,
      launchTui: async () => {
        events.push(`launch:${process.env["SWARMFLOW_RESUME_SESSION_DIR"] ?? "missing"}`);
      },
    }));

    expect(events).toEqual([
      "dotenv",
      "applyStaged",
      `launch:${sessionDir}`,
    ]);
  });

  it("warns once for configured Copilot without stored GitHub tokens", async () => {
    writeSettings({
      providers: {
        copilot: { api_key_env: "_COPILOT_OAUTH" },
      },
      auto_update: false,
    });
    hasGitHubTokens = false;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await main(["node", "swarmflow"], startupDeps({
        launchTui: async () => {
          events.push("launch");
        },
      }));

      expect(warnSpy).toHaveBeenCalledWith("Warning: GitHub Copilot credentials missing.");
      expect(events).toEqual(["dotenv", "applyStaged", "launch"]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("supports options before subcommands through the unified CLI dispatcher", async () => {
    await main(["node", "swarmflow", "--verbose", "init"], startupDeps({
      launchTui: async () => {
        events.push("launch");
      },
    }));

    expect(events).toEqual(["dotenv", "init:loaded"]);
  });

  it("keeps -v, -V, and --version working at the compiled entry", () => {
    for (const flag of ["-v", "-V", "--version"]) {
      const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", flag], {
        cwd: process.cwd(),
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${VERSION}\n`);
      expect(result.stderr).toBe("");
    }
  }, 30_000);

  it("resolves the UI source from a compiled dist CLI", () => {
    const compiledCli = join(process.cwd(), "dist", "src", "cli.js");

    expect(resolveOpenTuiEntry(compiledCli)).toBe(
      join(process.cwd(), "external", "opentui", "main.tsx"),
    );
  });
});
