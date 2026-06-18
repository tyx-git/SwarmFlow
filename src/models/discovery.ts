/**
 * Dynamic model discovery for local inference servers.
 *
 * Fetches available models from an OpenAI-compatible `/v1/models` endpoint
 * exposed by servers like oMLX and LM Studio.
 */

export interface DiscoveredModel {
  id: string;
  /** Context length reported by the server, if available. */
  contextLength?: number;
}

/**
 * Fetch available models from a local server's `/v1/models` endpoint.
 *
 * @param baseUrl  The base URL including `/v1`, e.g. `http://localhost:8000/v1`
 * @param timeoutMs  Request timeout in milliseconds (default 5000)
 * @returns Array of discovered models, or empty array on failure.
 */
export async function fetchModelsFromServer(
  baseUrl: string,
  timeoutMs = 5000,
  apiKey = "local",
): Promise<DiscoveredModel[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) return [];

    const body = (await resp.json()) as {
      data?: Array<Record<string, unknown>>;
    };

    if (!body.data || !Array.isArray(body.data)) return [];

    return body.data
      .filter((m) => typeof m["id"] === "string" && m["id"])
      .map((m) => {
        const model: DiscoveredModel = { id: m["id"] as string };
        // Some servers report context length in various fields
        const ctxLen =
          (m["context_length"] as number) ??
          (m["max_model_len"] as number) ??
          (m["context_window"] as number);
        if (typeof ctxLen === "number" && ctxLen > 0) {
          model.contextLength = ctxLen;
        }
        return model;
      });
  } catch {
    return [];
  }
}
