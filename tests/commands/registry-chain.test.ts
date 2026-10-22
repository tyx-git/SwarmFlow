import { describe, expect, it, vi } from "vitest";
import { buildDefaultRegistry } from "../../src/commands/registration.js";
import { getLocalizedCommandDescription } from "../../src/commands/registry.js";
import type { CommandContext } from "../../src/commands/types.js";
import { createUiText, hasUiText } from "../../src/ui/text.js";

function baseContext(registry: ReturnType<typeof buildDefaultRegistry>): CommandContext {
  return {
    session: {},
    showMessage: vi.fn(),
    autoSave: vi.fn(),
    resetUiState: vi.fn(),
    commandRegistry: registry,
  };
}

describe("slash command chain", () => {
  it("/help opens the help panel via the panel sentinel", async () => {
    const registry = buildDefaultRegistry();
    const help = registry.lookup("/help");
    expect(help).toBeTruthy();

    const ctx = baseContext(registry);
    await help!.handler(ctx, "");

    // The UI intercepts this sentinel and opens the help panel; the shortcut
    // text lives in the panel component, not the command output.
    const rendered = (ctx.showMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(rendered).toBe("__help_panel__");
  });

  it("loads every built-in command description from both language tables", () => {
    const registry = buildDefaultRegistry();
    for (const command of registry.getAll()) {
      expect(hasUiText("zh", ["Commands", command.name, "description"]), command.name).toBe(true);
      expect(hasUiText("en", ["Commands", command.name, "description"]), command.name).toBe(true);
      expect(getLocalizedCommandDescription(command, "zh")).toBe(
        createUiText("zh").get(["Commands", command.name, "description"]),
      );
      expect(getLocalizedCommandDescription(command, "en")).toBe(
        createUiText("en").get(["Commands", command.name, "description"]),
      );
    }
  });

  it("/compact delegates to the manual compact callback with raw args", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/compact");
    expect(cmd).toBeTruthy();

    const onManualCompactRequested = vi.fn();
    const ctx: CommandContext = {
      ...baseContext(registry),
      onManualCompactRequested,
    };

    await cmd!.handler(ctx, "preserve deployment notes");
    expect(onManualCompactRequested).toHaveBeenCalledWith("preserve deployment notes");
  });

  it("/new delegates to runtime restart when available", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/new");
    expect(cmd).toBeTruthy();

    const restartRuntimeForNewSession = vi.fn(async () => {});
    const session = {
      resetForNewSession: vi.fn(),
    };
    const store = {
      clearSession: vi.fn(),
    };

    const ctx: CommandContext = {
      ...baseContext(registry),
      session,
      store: store as unknown as CommandContext["store"],
      restartRuntimeForNewSession,
    };

    await cmd!.handler(ctx, "");

    expect(restartRuntimeForNewSession).toHaveBeenCalledTimes(1);
    expect(ctx.autoSave as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(store.clearSession).not.toHaveBeenCalled();
    expect(session.resetForNewSession).not.toHaveBeenCalled();
    expect(ctx.resetUiState as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("/new falls back to in-place reset when runtime restart is unavailable", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/new");
    expect(cmd).toBeTruthy();

    const session = {
      resetForNewSession: vi.fn(),
    };
    const store = {
      clearSession: vi.fn(),
    };

    const ctx: CommandContext = {
      ...baseContext(registry),
      session,
      store: store as unknown as CommandContext["store"],
    };

    await cmd!.handler(ctx, "");

    expect(ctx.resetUiState as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(ctx.autoSave as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(store.clearSession).toHaveBeenCalledTimes(1);
    expect(session.resetForNewSession).toHaveBeenCalledTimes(1);
    expect(session.resetForNewSession).toHaveBeenCalledWith(store);
    expect(ctx.showMessage as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("/new keeps current store when clearSession fails", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/new");
    expect(cmd).toBeTruthy();

    const session = {
      resetForNewSession: vi.fn(),
    };
    const store = {
      clearSession: vi.fn(),
    };

    const ctx: CommandContext = {
      ...baseContext(registry),
      session,
      store: store as unknown as CommandContext["store"],
    };

    await cmd!.handler(ctx, "");

    expect(store.clearSession).toHaveBeenCalledTimes(1);
    expect(session.resetForNewSession).toHaveBeenCalledTimes(1);
    expect(session.resetForNewSession).toHaveBeenCalledWith(store);
    expect(ctx.showMessage as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

});
