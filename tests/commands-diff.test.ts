import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  buildDefaultRegistry,
  type CommandContext,
} from "../src/commands/commands.js";

function baseContext(registry: ReturnType<typeof buildDefaultRegistry>): CommandContext {
  return {
    session: {},
    showMessage: vi.fn(),
    autoSave: vi.fn(),
    resetUiState: vi.fn(),
    commandRegistry: registry,
  };
}

describe("/diff command", () => {
  it("persists full diff display mode and notifies the TUI", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "swarmflow-diff-"));
    try {
      const registry = buildDefaultRegistry();
      const cmd = registry.lookup("/diff");
      expect(cmd).toBeTruthy();

      const showMessage = vi.fn();
      const showHint = vi.fn();
      const ctx: CommandContext = {
        ...baseContext(registry),
        showMessage,
        showHint,
        swarmflowHomeDir: homeDir,
      };

      await cmd!.handler(ctx, "full");

      const settings = JSON.parse(readFileSync(join(homeDir, "settings.json"), "utf-8"));
      expect(settings.diff_display).toBe("full");
      expect(showMessage).toHaveBeenCalledWith("__diff_display__:full");
      expect(showHint).toHaveBeenCalledWith("Diff display: full");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("opens a picker when invoked without arguments", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/diff");
    expect(cmd).toBeTruthy();

    const promptCommandPicker = vi.fn(async (options) => {
      expect(options.map((option: { value: string }) => option.value)).toEqual(["compact", "full"]);
      return "compact";
    });
    const ctx: CommandContext = {
      ...baseContext(registry),
      promptCommandPicker,
    };

    await cmd!.handler(ctx, "");

    expect(promptCommandPicker).toHaveBeenCalledTimes(1);
  });

  it("defaults to compact without writing legacy preference files", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "swarmflow-diff-"));
    try {
      const registry = buildDefaultRegistry();
      const cmd = registry.lookup("/diff");
      expect(cmd).toBeTruthy();

      const ctx: CommandContext = {
        ...baseContext(registry),
        swarmflowHomeDir: homeDir,
      };

      await cmd!.handler(ctx, "compact");

      const settings = JSON.parse(readFileSync(join(homeDir, "settings.json"), "utf-8"));
      expect(settings.diff_display).toBe("compact");
      expect(existsSync(join(homeDir, "tui-preferences.json"))).toBe(false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
