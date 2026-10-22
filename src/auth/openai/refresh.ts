/** 访问令牌刷新与过期前自动续期入口。 */

import { CLIENT_ID, TOKEN_URL } from "./endpoints.js";
import { fetchForm } from "./http.js";
import { isTokenExpiring } from "./jwt.js";
import { type OAuthTokens, loadAuthStore, saveOAuthTokens } from "./token-store.js";

// =============================================================================
// 常量
// =============================================================================

/** 用 refresh_token 换取新的 access_token。 */
export async function refreshAccessToken(
  refreshToken: string,
): Promise<OAuthTokens> {
  const { status, data } = await fetchForm(TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });

  if (status !== 200) {
    const errDesc =
      typeof data["error_description"] === "string"
        ? data["error_description"]
        : typeof data["message"] === "string"
          ? data["message"]
          : `status ${status}`;
    const errCode = typeof data["error"] === "string" ? data["error"] : "";
    const reloginHint =
      errCode === "invalid_grant" || errCode === "invalid_token"
        ? " Run 'swarmflow oauth' to re-authenticate."
        : "";
    throw new Error(`Token refresh failed: ${errDesc}.${reloginHint}`);
  }

  const accessToken = String(data["access_token"] ?? "");
  if (!accessToken) {
    throw new Error(
      "Token refresh response missing access_token. Run 'swarmflow oauth' to re-authenticate.",
    );
  }

  const newRefreshToken =
    typeof data["refresh_token"] === "string" && data["refresh_token"]
      ? String(data["refresh_token"])
      : refreshToken;

  const tokens: OAuthTokens = {
    access_token: accessToken,
    refresh_token: newRefreshToken,
  };

  saveOAuthTokens(tokens);
  return tokens;
}

// =============================================================================
// 组合：确保令牌新鲜
// =============================================================================

/**
 * 确保返回有效的 access_token。
 * 若无存储或即将过期，自动刷新后返回。
 */
export async function ensureFreshToken(): Promise<string> {
  const store = loadAuthStore();
  const codex = store.openai_codex;
  if (
    !codex ||
    typeof codex.access_token !== "string" ||
    !codex.access_token.trim() ||
    typeof codex.refresh_token !== "string" ||
    !codex.refresh_token.trim()
  ) {
    throw new Error(
      "No OpenAI OAuth credentials stored. Run 'swarmflow oauth' to log in.",
    );
  }

  if (isTokenExpiring(codex.access_token)) {
    const refreshed = await refreshAccessToken(codex.refresh_token);
    return refreshed.access_token;
  }

  return codex.access_token;
}

/**
 * 上游拒绝了 `staleToken`（401）后强制换取新令牌。
 *
 * 令牌"还没过期"就被拒绝是常态（服务端撤销、异地重新登录），此时
 * ensureFreshToken 会原样返回同一个坏令牌，只有强制刷新能自救。
 * 若磁盘上的令牌已被并行刷新改掉（子代理与主代理同时 401），直接复用
 * 那个结果——重复刷新会撞上一次性 refresh_token 的轮换竞态。
 *
 * 返回 null 表示没有可用的 refresh_token（需要重新登录）。刷新自身的
 * 失败会向上抛出："Token refresh failed: ... Run 'swarmflow oauth'"
 * 比原始的 401 更可操作。
 */
export async function forceRefreshToken(staleToken?: string): Promise<string | null> {
  const codex = loadAuthStore().openai_codex;
  const current = codex?.access_token?.trim();
  const used = staleToken?.trim();
  if (current && current !== used) return current;

  const refreshToken = codex?.refresh_token?.trim();
  if (!refreshToken) return null;
  const refreshed = await refreshAccessToken(refreshToken);
  return refreshed.access_token;
}

// =============================================================================
// CLI 命令：`swarmflow oauth [action] [service]`
// =============================================================================
//
// 支持两种 OAuth 服务：
//   - codex    ——OpenAI ChatGPT 登录（已有）
//   - copilot  ——GitHub Copilot 设备码流程（新增）
//
// 命令形式：
//   swarmflow oauth                    ——选择器：service × action
//   swarmflow oauth login              ——选择器：service
//   swarmflow oauth logout             ——选择器：清除哪个服务
//   swarmflow oauth status             ——显示所有服务状态
//   swarmflow oauth login codex        ——直接登录 codex
//   swarmflow oauth login copilot      ——直接登录 copilot
//   swarmflow oauth logout codex       ——直接登出 codex
//   swarmflow oauth logout copilot     ——直接登出 copilot
//
// 兼容：之前运行过 `swarmflow oauth` 或 `swarmflow oauth login` 的用户
// 现在会看到 2 项选择器，多一次按键。
// =============================================================================
