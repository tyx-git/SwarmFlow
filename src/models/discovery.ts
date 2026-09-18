/**
 * 本地推理服务器的动态模型发现。
 *
 * 从 oMLX 和 LM Studio 等服务器暴露的 OpenAI 兼容 `/v1/models` 端点
 * 获取可用模型。
 */

export interface DiscoveredModel {
  id: string;
  /** 服务器报告的上下文长度（如果有）。*/
  contextLength?: number;
}

/**
 * 从本地服务器的 `/v1/models` 端点获取可用模型。
 *
 * @param baseUrl  包含 `/v1` 的基础 URL，例如 `http://localhost:8000/v1`
 * @param timeoutMs  请求超时（毫秒）（默认 5000）
 * @returns 发现的模型数组，或失败时返回空数组。
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
        // 一些服务器在各种字段中报告上下文长度
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
