import { describe, expect, it, mock } from "bun:test";

import {
  buildDefaultRegistry,
  type CommandContext,
} from "../src/commands.js";

describe("/shells command", () => {
  it("delegates to the TUI shells picker when available", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/shells");
    expect(cmd).toBeTruthy();

    const onShellsRequested = mock();
    const ctx: CommandContext = {
      session: {} as never,
      showMessage: mock(),
      autoSave: mock(),
      resetUiState: mock(),
      commandRegistry: registry,
      onShellsRequested,
    };

    await cmd!.handler(ctx, "");
    expect(onShellsRequested).toHaveBeenCalledTimes(1);
  });

  it("reports unavailability when the UI has no shells picker", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/shells");

    const showMessage = mock();
    const ctx: CommandContext = {
      session: {} as never,
      showMessage,
      autoSave: mock(),
      resetUiState: mock(),
      commandRegistry: registry,
    };

    await cmd!.handler(ctx, "");
    expect(String(showMessage.mock.calls[0]?.[0])).toContain("not available");
  });
});
