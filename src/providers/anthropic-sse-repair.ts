/**
 * SSE stream repair for non-compliant Anthropic-protocol vendors.
 *
 * Some vendors that expose an Anthropic /v1/messages-compatible endpoint emit
 * malformed streaming events. The concrete case this guards against (Kimi /
 * Moonshot `/anthropic`, verified live 2026-05):
 *
 *   When the model fires a degenerate server-side web_search (e.g. an empty
 *   search prepended to a trivial turn), Kimi emits an `input_json_delta`
 *   event with NO `partial_json` field at all:
 *
 *       data: {"type":"content_block_delta","index":1,
 *              "delta":{"type":"input_json_delta"}}
 *
 *   The Anthropic SDK's stream accumulator does `jsonBuf += event.delta.partial_json`,
 *   which evaluates to the string `"" + undefined === "undefined"`, then feeds
 *   `"undefined"` to its partial-JSON parser. That throws
 *   `JSON Parse error: Unexpected EOF`, which rejects the entire stream and
 *   surfaces to the user as a turn error. A real (non-empty) web_search sends a
 *   proper `partial_json` and works fine 鈥?only the empty case crashes.
 *
 * The repair: transparently rewrite any `input_json_delta` event that lacks a
 * string `partial_json` so it carries `partial_json: ""`. The SDK then computes
 * `"" + "" === ""`, skips the parse, and the stream completes normally. Events
 * that already carry `partial_json` (every compliant vendor, and Kimi's real
 * searches) are passed through byte-for-byte, so this is a no-op for them.
 */

type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Rewrite a single SSE `data:` payload if it is a partial_json-less input_json_delta. */
function repairDataLine(jsonText: string): string | null {
  // Cheap pre-checks before paying for JSON.parse.
  if (!jsonText.includes('"input_json_delta"')) return null;
  if (jsonText.includes('"partial_json"')) return null;
  try {
    const obj = JSON.parse(jsonText) as Record<string, unknown>;
    const delta = obj["delta"] as Record<string, unknown> | undefined;
    if (delta && delta["type"] === "input_json_delta" && typeof delta["partial_json"] !== "string") {
      delta["partial_json"] = "";
      return JSON.stringify(obj);
    }
  } catch {
    // Not valid JSON on its own 鈥?leave untouched.
  }
  return null;
}

/**
 * Wrap a fetch so that text/event-stream response bodies have their
 * `input_json_delta` events normalized (see module docstring). Non-streaming
 * responses and non-event-stream bodies pass straight through.
 */
export function makeAnthropicSSERepairFetch(
  baseFetch: FetchLike = globalThis.fetch.bind(globalThis),
): FetchLike {
  return async (url, init) => {
    const resp = await baseFetch(url, init);
    const contentType = resp.headers.get("content-type") || "";
    if (!resp.body || !contentType.includes("text/event-stream")) {
      return resp;
    }

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buf = "";

    // A TransformStream driven by `pipeThrough` lets the runtime own the pump
    // and backpressure. (An earlier hand-rolled ReadableStream+pull busy-spun on
    // the live chunk cadence 鈥?empty keep-alive frames during Kimi's server-side
    // search re-triggered pull without ever enqueuing 鈥?and swallowed aborts.)
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buf += decoder.decode(chunk, { stream: true });
        let out = "";
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const rawLine = buf.slice(0, nl + 1); // includes the trailing "\n"
          buf = buf.slice(nl + 1);
          const body = rawLine.replace(/\r?\n$/, "");
          if (body.startsWith("data:")) {
            const fixed = repairDataLine(body.slice(5).trim());
            if (fixed !== null) {
              const ending = rawLine.endsWith("\r\n") ? "\r\n" : "\n";
              out += `data: ${fixed}${ending}`;
              continue;
            }
          }
          out += rawLine;
        }
        if (out) controller.enqueue(encoder.encode(out));
      },
      flush(controller) {
        if (buf) controller.enqueue(encoder.encode(buf));
      },
    });

    // Re-wrap with clean headers: the body has been decoded and re-encoded, so
    // the original content-length / content-encoding no longer apply and would
    // make the consumer hang or double-decode. Preserve only content-type.
    return new Response(resp.body.pipeThrough(transform), {
      status: resp.status,
      statusText: resp.statusText,
      headers: { "content-type": contentType },
    });
  };
}
