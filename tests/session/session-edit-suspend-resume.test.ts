import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { EDIT_PATCH } from "../../src/tools/definitions.js";
import { makeScriptedSession, stageApprovalGate } from "../helpers/session-harness.js";

describe("edit suspend and resume", () => {
  it("drains an approved edit call using the patch from the assistant body", async () => {
    const patch = "*** Begin Patch\n*** Add File: approved.txt\n+hello\n*** End Patch";
    const h = makeScriptedSession({
      rounds: [
        {
          text: patch,
          toolCalls: [{ id: "call-edit", name: "edit", arguments: {} }],
        },
        { text: "done" },
      ],
      tools: [EDIT_PATCH],
    });
    try {
      const gate = stageApprovalGate(h, "edit");
      await h.session.turn("apply the patch");

      expect(gate.ask).not.toBeNull();
      expect(h.session.getPendingAsk()?.kind).toBe("approval");
      expect(existsSync(join(h.projectRoot, "approved.txt"))).toBe(false);

      h.session.resolveApprovalAsk(gate.ask!.id, 0);
      await h.session.resumePendingTurn();

      expect(readFileSync(join(h.projectRoot, "approved.txt"), "utf8")).toBe("hello\n");

      const secondRequest = h.provider.calls[1] ?? [];
      const toolResult = secondRequest.find((message) => message["role"] === "tool_result");
      expect(String(toolResult?.["content"])).toContain(
        "Success. Updated the following files:\nA approved.txt",
      );

      const assistant = secondRequest.find((message) => (
        message["role"] === "assistant" && Array.isArray(message["tool_calls"])
      ));
      expect(assistant?.["text"]).toBe(patch);
      expect(assistant?.["tool_calls"]).toEqual([
        { id: "call-edit", name: "edit", arguments: {} },
      ]);
    } finally {
      h.dispose();
    }
  });
});
