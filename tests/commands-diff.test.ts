import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, mock } from "bun:test";

import {
  buildDefaultRegistry,
  type CommandContext,
} from "../src/commands.js";

function baseContext(registry: ReturnType<typeof buildDefaultRegistry>): CommandContext {
  return {
    session: {},
    showMessage: mock(),
    autoSave: mock(),
    resetUiState: mock(),
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

      const showMessage = mock();
      const showHint = mock();
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

    const promptCommandPicker = mock(async (options) => {
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
