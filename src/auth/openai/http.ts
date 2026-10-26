/** 带超时的 OAuth HTTP 请求（JSON 与表单两种编码）。 */

import { HTTP_TIMEOUT_MS } from "../../network/http-timeout.js";

// =============================================================================
// 常量
// =============================================================================

/** 带超时控制的 JSON 请求封装。 */
export async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    const data = (await resp.json()) as Record<string, unknown>;
    return { status: resp.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

/** 发送 form-encoded 请求的便捷封装。 */
export async function fetchForm(
  url: string,
  body: Record<string, string>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

// =============================================================================
// Session 辅助函数
// =============================================================================
