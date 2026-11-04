import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { TurnIncompleteError } from "../../src/network/retry.js";
import { Usage, ProviderResponse } from "../../src/providers/response.js";
import { EDIT_PATCH } from "../../src/tools/definitions.js";
import { makeScriptedSession } from "../helpers/session-harness.js";

describe("edit retry stream reset", () => {
  it("discards a partial patch from a failed attempt before replay", async () => {
    const partial = "*** Begin Patch\n*** Add File: retry.txt\n+partial";
    const full = "*** Begin Patch\n*** Add File: retry.txt\n+alpha\n*** End Patch";
    const h = makeScriptedSession({ tools: [EDIT_PATCH] });
    try {
      let attempt = 0;
      (h.provider as any).sendMessage = async (
        messages: unknown[],
        _tools: unknown,
        options?: {
          onTextChunk?: (chunk: string) => void;
          onToolCallClosed?: (call: unknown) => void;
        },
      ) => {
        attempt += 1;
        (h.provider.calls as unknown[][]).push(structuredClone(messages));
        if (attempt === 1) {
          options?.onTextChunk?.(partial);
          throw new TurnIncompleteError("stream cut");
        }
        if (attempt === 2) {
          options?.onToolCallClosed?.({
            id: "call-edit",
            name: "edit",
            rawArguments: "{}",
            arguments: {},
            parseError: null,
          });
          return new ProviderResponse({ text: full, usage: new Usage(50, 5) });
        }
        return new ProviderResponse({ text: "done", usage: new Usage(50, 5) });
      };

      await h.session.turn("apply it");

      expect(attempt).toBe(3);
      expect(readFileSync(join(h.projectRoot, "retry.txt"), "utf8")).toBe("alpha\n");

      const retryRequest = h.provider.calls[1] ?? [];
      expect(JSON.stringify(retryRequest)).not.toContain("+partial");

      const followUp = h.provider.calls[2] ?? [];
      const assistant = followUp.find((message) => (
        message["role"] === "assistant" && Array.isArray(message["tool_calls"])
      ));
      expect(assistant?.["text"]).toBe(full);
      expect(JSON.stringify(followUp)).not.toContain("+partial");

      const texts = h.internals._log.filter((entry: any) => (
        entry.type === "assistant_text" && entry.roundIndex === 0
      ));
      expect(texts.some((entry: any) => entry.discarded === true)).toBe(true);
      expect(texts.filter((entry: any) => entry.discarded !== true)).toHaveLength(1);
      expect(existsSync(join(h.projectRoot, "retry.txt"))).toBe(true);
    } finally {
      h.dispose();
    }
  });
});
