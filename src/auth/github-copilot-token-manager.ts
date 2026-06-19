/**
 * GitHub Copilot 短生命周期 API Token 管理器。
 *
 * Copilot 采用双层 Token 架构：
 *   1. 长生命周期 GitHub OAuth 令牌（约 8 小时，可通过 refresh_token 刷新）
 *   2. 短生命周期 Copilot API 令牌（约 25 分钟，按需铸造）
 *
 * Copilot API 令牌是调用 api.individual.githubcopilot.com/* 时
 * 放在 Authorization: Bearer <token> 头中的令牌。
 * 通过 GET api.github.com/copilot_internal/v2/token
 * 从长生命周期 GitHub 令牌换取。
 *
 * 此管理器将短生命周期令牌保留在内存中（从不写入磁盘），
 * 并在即将过期时自动刷新。并发调用方共享单个进行中的刷新请求，
 * 避免雷鸣群（thundering-herd）问题。
 */

import {
  getGitHubAccessToken,
  COPILOT_EDITOR_HEADERS,
} from "./github-copilot-oauth.js";

// =============================================================================
// 常量
// =============================================================================

const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

/** 在声明的过期时间前 60 秒刷新短生命周期 Copilot API 令牌。 */
const REFRESH_SKEW_SECONDS = 60;

const HTTP_TIMEOUT_MS = 15_000;

// =============================================================================
// 类型
// =============================================================================

export interface CopilotApiToken {
  /** 放入 Authorization: Bearer 的短生命周期令牌。 */
  token: string;
  /** 绝对过期时间（自 epoch 以来的秒数，来自服务器响应）。 */
  expiresAt: number;
  /** Copilot API 请求的 Base URL（如 https://api.individual.githubcopilot.com）。 */
  endpointApi: string;
}

// =============================================================================
// Token 管理器
// =============================================================================

class CopilotTokenManager {
  /** 缓存的令牌（内存中）。 */
  private _cached: CopilotApiToken | null = null;
  /** 进行中的刷新 Promise（防止并发刷新）。 */
  private _inflight: Promise<CopilotApiToken> | null = null;

  /**
   * 获取有效的短生命周期 Copilot API 令牌。
   * - 若缓存仍有效则直接返回。
   * - 否则通过 /copilot_internal/v2/token 刷新。
   * - 并发调用方共享同一个进行中的刷新。
   */
  async getToken(): Promise<CopilotApiToken> {
    if (this._cached && !this._isExpiring(this._cached)) {
      return this._cached;
    }
    if (this._inflight) {
      return this._inflight;
    }
    this._inflight = this._fetchFresh().finally(() => {
      this._inflight = null;
    });
    return this._inflight;
  }

  /**
   * 丢弃缓存令牌，强制下次 getToken() 调用重新获取。
   * 在 Copilot API 端点返回 401 时调用。
   */
  invalidate(): void {
    this._cached = null;
  }

  /** 检查令牌是否即将过期。 */
  private _isExpiring(t: CopilotApiToken): boolean {
    const now = Math.floor(Date.now() / 1000);
    return t.expiresAt <= now + REFRESH_SKEW_SECONDS;
  }

  /** 向 Copilot Token 端点请求新的短生命周期令牌。 */
  private async _fetchFresh(): Promise<CopilotApiToken> {
    const githubToken = getGitHubAccessToken();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

    let resp: Response;
    try {
      resp = await fetch(COPILOT_TOKEN_URL, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `token ${githubToken}`,
          ...COPILOT_EDITOR_HEADERS,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!resp.ok) {
      const hint =
        resp.status === 401 || resp.status === 403
          ? " Run 'swarmflow oauth' to re-authenticate."
          : "";
      throw new Error(
        `Failed to mint Copilot API token: HTTP ${resp.status}.${hint}`,
      );
    }

    let data: Record<string, unknown>;
    try {
      data = (await resp.json()) as Record<string, unknown>;
    } catch {
      throw new Error("Copilot API token response was not valid JSON.");
    }

    const token = String(data["token"] ?? "");
    const expiresAt = Number(data["expires_at"]) || 0;
    const endpoints = data["endpoints"];
    const endpointApi =
      endpoints && typeof endpoints === "object" && "api" in endpoints
        ? String((endpoints as Record<string, unknown>)["api"] ?? "")
        : "";

    if (!token || !expiresAt || !endpointApi) {
      throw new Error(
        "Copilot API token response missing required fields (token / expires_at / endpoints.api).",
      );
    }

    const fresh: CopilotApiToken = { token, expiresAt, endpointApi };
    this._cached = fresh;
    return fresh;
  }
}

/** 所有 Copilot Provider 实例共享的单例。 */
export const copilotTokenManager = new CopilotTokenManager();
