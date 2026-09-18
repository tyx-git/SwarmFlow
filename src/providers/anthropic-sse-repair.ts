/**
 * 非合规 Anthropic 协议供应商的 SSE 流修复。
 *
 * 一些暴露 Anthropic /v1/messages 兼容端点的供应商会发出畸形流式事件。
 * 此处防护的具体场景（Kimi / Moonshot `/anthropic`，2026-05 实机验证）：
 *
 *   当模型触发退化的服务端 web_search（例如在简单回合前置一个空搜索）时，
 *   Kimi 会发出完全没有 `partial_json` 字段的 `input_json_delta` 事件：
 *
 *       data: {"type":"content_block_delta","index":1,
 *              "delta":{"type":"input_json_delta"}}
 *
 *   Anthropic SDK 的流累加器会执行 `jsonBuf += event.delta.partial_json`，
 *   其结果是字符串 `"" + undefined === "undefined"`，随后把
 *   `"undefined"` 交给 partial-JSON 解析器。这会抛出
 *   `JSON Parse error: Unexpected EOF`，拒绝整个流并以回合错误暴露给用户。
 *   真实（非空）的 web_search 会发送正确的 `partial_json` 并正常工作 —
 *   只有空搜索场景会崩溃。
 *
 * 修复方式：透明地重写任何缺少字符串 `partial_json` 的 `input_json_delta` 事件，
 * 让它携带 `partial_json: ""`。随后 SDK 计算 `"" + "" === ""`，
 * 跳过解析，流正常完成。已经携带 `partial_json` 的事件（所有合规供应商，
 * 以及 Kimi 的真实搜索）会逐字节透传，因此对它们是 no-op。
 */

type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** 如果单个 SSE `data:` 负载是缺少 partial_json 的 input_json_delta，则重写它。 */
function repairDataLine(jsonText: string): string | null {
  // 在付出 JSON.parse 成本前做廉价预检查。
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
    // 自身不是有效 JSON — 保持不变。
  }
  return null;
}

/**
 * 包装 fetch，使 text/event-stream 响应体中的 `input_json_delta` 事件被规范化
 *（见模块文档字符串）。非流式响应和非 event-stream body 会直接透传。
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

    // 由 `pipeThrough` 驱动的 TransformStream 让运行时拥有 pump 和背压。
    //（早先手写的 ReadableStream+pull 会在实时 chunk 节奏上忙等 — Kimi
    // 服务端搜索期间的空 keep-alive 帧会反复触发 pull 却从不 enqueue —
    // 还会吞掉 abort。）
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buf += decoder.decode(chunk, { stream: true });
        let out = "";
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const rawLine = buf.slice(0, nl + 1); // 包含尾随的 "\n"
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

    // 使用干净头重新包装：body 已被解码并重新编码，
    // 原始 content-length / content-encoding 不再适用，可能让消费者挂起或重复解码。
    // 只保留 content-type。
    return new Response(resp.body.pipeThrough(transform), {
      status: resp.status,
      statusText: resp.statusText,
      headers: { "content-type": contentType },
    });
  };
}
