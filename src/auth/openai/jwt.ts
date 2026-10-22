/** 访问令牌的 JWT 解析、账号 ID 提取与过期判断。 */

import { REFRESH_SKEW_SECONDS } from "./endpoints.js";

// =============================================================================
// 常量
// =============================================================================

/** 解码 JWT payload（不验证签名，仅提取声明）。 */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2) return {};
  let payload = parts[1];
  payload += "=".repeat((4 - (payload.length % 4)) % 4);
  try {
    const raw = Buffer.from(payload, "base64url").toString("utf-8");
    const claims = JSON.parse(raw);
    return typeof claims === "object" && claims !== null ? claims : {};
  } catch {
    return {};
  }
}

/**
 * 从 codex OAuth 访问令牌中提取 ChatGPT 账户 ID。
 * ChatGPT 用户可属于多个账户（个人/工作区/org）；
 * codex 后端使用 ChatGPT-Account-Id 请求头选择哪个账户计费并应用配额。
 * ID 位于 JWT 的 chatgpt_account_id 声明中，
 * 可能嵌套在 https://api.openai.com/auth 下或位于顶层，
 * 取决于令牌形态。
 */
export function getCodexAccountId(accessToken: string): string | undefined {
  if (typeof accessToken !== "string" || !accessToken) return undefined;
  const claims = decodeJwtPayload(accessToken);
  const auth = claims["https://api.openai.com/auth"];
  const fromAuth = (auth && typeof auth === "object")
    ? (auth as Record<string, unknown>)["chatgpt_account_id"]
    : undefined;
  const fromTop = claims["chatgpt_account_id"];
  const orgs = claims["organizations"];
  const fromOrg = (Array.isArray(orgs) && orgs[0] && typeof orgs[0] === "object")
    ? (orgs[0] as Record<string, unknown>)["id"]
    : undefined;
  const id = fromAuth ?? fromTop ?? fromOrg;
  return typeof id === "string" && id ? id : undefined;
}

/**
 * 检查 OAuth 访问令牌是否即将过期。
 * 若令牌将在 skewSeconds 秒内过期或无法确定过期时间，返回 true。
 */
export function isTokenExpiring(
  accessToken: string,
  skewSeconds = REFRESH_SKEW_SECONDS,
): boolean {
  const claims = decodeJwtPayload(accessToken);
  const exp = claims["exp"];
  if (typeof exp !== "number") return false;
  return exp <= Math.floor(Date.now() / 1000) + Math.max(0, skewSeconds);
}

/** 从访问令牌中提取过期时间。 */
export function getTokenExpiry(accessToken: string): Date | null {
  const claims = decodeJwtPayload(accessToken);
  const exp = claims["exp"];
  if (typeof exp !== "number") return null;
  return new Date(exp * 1000);
}

// =============================================================================
// HTTP 辅助函数
// =============================================================================
