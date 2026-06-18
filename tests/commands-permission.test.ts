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

describe("/permission command", () => {
  it("persists permission mode to settings.json for bootstrap reloads", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "swarmflow-permission-"));
    try {
      const registry = buildDefaultRegistry();
      const cmd = registry.lookup("/permission");
      expect(cmd).toBeTruthy();

      const session = { permissionMode: "reversible" };
      const ctx: CommandContext = {
        ...baseContext(registry),
        session,
        swarmflowHomeDir: homeDir,
      };

      await cmd!.handler(ctx, "yolo");

      expect(session.permissionMode).toBe("yolo");
      const settings = JSON.parse(readFileSync(join(homeDir, "settings.json"), "utf-8"));
      expect(settings.permission_mode).toBe("yolo");
      expect(existsSync(join(homeDir, "tui-preferences.json"))).toBe(false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
