import { describe, expect, it } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";

import { makeAnthropicSSERepairFetch } from "../src/providers/anthropic-sse-repair.js";

/**
 * Kimi's `/anthropic` web_search emits an `input_json_delta` event with NO
 * `partial_json` field on a degenerate (empty) search. The Anthropic SDK does
 * `"" + undefined === "undefined"` and feeds that to its partial-JSON parser,
 * which throws `JSON Parse error: Unexpected EOF` and kills the whole stream.
 * `makeAnthropicSSERepairFetch` normalizes the event so the SDK survives.
 */

const SSE_DEGENERATE = [
  `event: message_start`,
  `data: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[],"model":"kimi-k2.6","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}`,
  ``,
  `event: content_block_start`,
  `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
  ``,
  `event: content_block_delta`,
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Search results for query: "}}`,
  ``,
  `event: content_block_stop`,
  `data: {"type":"content_block_stop","index":0}`,
  ``,
  `event: content_block_start`,
  `data: {"type":"content_block_start","index":1,"content_block":{"type":"server_tool_use","name":"web_search"}}`,
  ``,
  `event: content_block_delta`,
  `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta"}}`,
  ``,
  `event: content_block_stop`,
  `data: {"type":"content_block_stop","index":1}`,
  ``,
  `event: content_block_start`,
  `data: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}`,
  ``,
  `event: content_block_delta`,
  `data: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"你好！"}}`,
  ``,
  `event: content_block_stop`,
  `data: {"type":"content_block_stop","index":2}`,
  ``,
  `event: message_delta`,
  `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}`,
  ``,
  `event: message_stop`,
  `data: {"type":"message_stop"}`,
  ``,
].join("\n");

function mockFetch(body: string): typeof globalThis.fetch {
  return (async () =>
    new Response(new Blob([body]).stream(), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof globalThis.fetch;
}

/** Drain the SSE response produced by a fetch, returning the raw text. */
async function readAll(fetchImpl: ReturnType<typeof makeAnthropicSSERepairFetch>): Promise<string> {
  const resp = await fetchImpl("https://mock/v1/messages", {});
  return await resp.text();
}

describe("makeAnthropicSSERepairFetch", () => {
  it("injects an empty partial_json into a field-less input_json_delta", async () => {
    const out = await readAll(makeAnthropicSSERepairFetch(mockFetch(SSE_DEGENERATE)));
    expect(out).toContain(`"input_json_delta","partial_json":""`);
    // The original (field-less) form must be gone.
    expect(out).not.toContain(`"input_json_delta"}`);
  });

  it("passes a compliant input_json_delta through unchanged", async () => {
    const compliant = [
      `event: content_block_delta`,
      `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"x\\"}"}}`,
      ``,
    ].join("\n");
    const out = await readAll(makeAnthropicSSERepairFetch(mockFetch(compliant)));
    expect(out).toContain(`"partial_json":"{\\"query\\":\\"x\\"}"`);
  });

  it("passes non-event-stream responses through untouched", async () => {
    const base = (async () =>
      new Response(`{"ok":true}`, { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;
    const resp = await makeAnthropicSSERepairFetch(base)("https://mock", {});
    expect(await resp.text()).toBe(`{"ok":true}`);
  });

  it("lets the Anthropic SDK consume the degenerate stream without throwing", async () => {
    // The crash (partialParse of `"undefined"`) happens *during* iteration, in
    // the SDK's stream accumulator — so the regression target is that the
    // for-await completes without throwing and we still receive the text.
    const client = new Anthropic({
      apiKey: "test",
      baseURL: "https://mock",
      fetch: makeAnthropicSSERepairFetch(mockFetch(SSE_DEGENERATE)),
    });
    const stream = client.messages.stream({
      model: "kimi-k2.6",
      max_tokens: 64,
      messages: [{ role: "user", content: "你好" }],
    });
    stream.on("error", () => {});
    let text = "";
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        text += ev.delta.text;
      }
    }
    expect(text).toContain("你好！");
  });

  it("crashes the SDK WITHOUT the repair (documents the bug)", async () => {
    const client = new Anthropic({
      apiKey: "test",
      baseURL: "https://mock",
      fetch: mockFetch(SSE_DEGENERATE),
    });
    const stream = client.messages.stream({
      model: "kimi-k2.6",
      max_tokens: 64,
      messages: [{ role: "user", content: "你好" }],
    });
    stream.on("error", () => {});
    let threw = false;
    try {
      for await (const _ of stream) {
        void _;
      }
      await stream.finalMessage();
    } catch (e) {
      threw = true;
      expect(String((e as Error).message)).toContain("Unexpected EOF");
    }
    expect(threw).toBe(true);
  });
});
