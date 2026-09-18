import { describe, expect, it, vi } from "vitest";

import {
  buildDefaultRegistry,
  type CommandContext,
} from "../src/commands/commands.js";

describe("/shells command", () => {
  it("delegates to the TUI shells picker when available", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/shells");
    expect(cmd).toBeTruthy();

    const onShellsRequested = vi.fn();
    const ctx: CommandContext = {
      session: {} as never,
      showMessage: vi.fn(),
      autoSave: vi.fn(),
      resetUiState: vi.fn(),
      commandRegistry: registry,
      onShellsRequested,
    };

    await cmd!.handler(ctx, "");
    expect(onShellsRequested).toHaveBeenCalledTimes(1);
  });

  it("reports unavailability when the UI has no shells picker", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/shells");

    const showMessage = vi.fn();
    const ctx: CommandContext = {
      session: {} as never,
      showMessage,
      autoSave: vi.fn(),
      resetUiState: vi.fn(),
      commandRegistry: registry,
    };

    await cmd!.handler(ctx, "");
    expect(String(showMessage.mock.calls[0]?.[0])).toContain("not available");
  });
});
