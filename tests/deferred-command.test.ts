import { describe, expect, it, vi } from "vitest";

import { buildDefaultRegistry } from "../src/commands/commands.js";
import { enqueueDeferredCommand, takeReadyDeferredCommand } from "../src/ui/deferred-command.js";
import { makeScriptedSession } from "./helpers/session-harness.js";

describe("deferred slash commands", () => {
  it("delivers /plan to its handler only after the active turn is completely idle", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = makeScriptedSession({
      rounds: [{ text: "finished" }],
    });
    try {
      const sendMessage = h.provider.sendMessage.bind(h.provider);
      h.provider.sendMessage = async (...args: Parameters<typeof h.provider.sendMessage>) => {
        await gate;
        return sendMessage(...args);
      };
      const registry = buildDefaultRegistry();
      const plan = registry.lookup("/plan")!;
      const handler = vi.fn(async (_ctx: unknown, args: string) => args);
      registry.register({ ...plan, handler });
      const running = h.session.turn("current work");

      const item = enqueueDeferredCommand(registry, h.session, "/plan new goal", null, false);
      expect(item?.text).toBe("/plan new goal");
      expect(takeReadyDeferredCommand(item, h.session, h.session.canRunDeferredCommand())).toBeNull();
      expect(h.session.log.some((entry) => entry.display.includes("/plan new goal"))).toBe(false);

      release();
      await running;
      const command = takeReadyDeferredCommand(item, h.session, h.session.canRunDeferredCommand());
      expect(command).toBe("/plan new goal");
      await registry.lookup("/plan")!.handler({} as never, command!.slice("/plan".length).trim());
      expect(handler).toHaveBeenCalledExactlyOnceWith({}, "new goal");
      expect(h.provider.sawUserText("/plan new goal")).toBe(false);
    } finally {
      release();
      h.dispose();
    }
  });

  it("rejects duplicate or cross-session queued commands", () => {
    const registry = buildDefaultRegistry();
    const session = {};
    const item = enqueueDeferredCommand(registry, session, "/plan goal", null, false);
    expect(item).not.toBeNull();
    expect(enqueueDeferredCommand(registry, session, "/plan other", item, false)).toBeNull();
    expect(enqueueDeferredCommand(registry, session, "/plan other", null, true)).toBeNull();
    expect(enqueueDeferredCommand(registry, session, "/model", null, false)).toBeNull();
    expect(takeReadyDeferredCommand(item, {}, true)).toBeNull();
  });

  it("accepts /compact as a deferred command", () => {
    const registry = buildDefaultRegistry();
    const item = enqueueDeferredCommand(registry, {}, "/compact", null, false);
    expect(item?.text).toBe("/compact");
  });
});
