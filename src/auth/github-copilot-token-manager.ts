/**
 * GitHub Copilot short-lived API token manager.
 *
 * Copilot has a two-tier token architecture:
 *   1. Long-lived GitHub OAuth token (~8 hours, refreshable via refresh_token)
 *   2. Short-lived Copilot API token (~25 minutes, minted on demand)
 *
 * The Copilot API token is what goes into Authorization: Bearer <token>
 * headers when calling api.individual.githubcopilot.com/*. It must be
 * exchanged from the long-lived GitHub token by hitting
 * GET api.github.com/copilot_internal/v2/token.
 *
 * This manager keeps the short-lived token in memory (never written to disk)
 * and refreshes it automatically when expiry approaches. Concurrent callers
 * share a single in-flight refresh to avoid thundering-herd.
 */

import {
  getGitHubAccessToken,
  COPILOT_EDITOR_HEADERS,
} from "./github-copilot-oauth.js";

// =============================================================================
// Constants
// =============================================================================

const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

/** Refresh the short-lived Copilot API token 60 seconds before its stated expiry. */
const REFRESH_SKEW_SECONDS = 60;

const HTTP_TIMEOUT_MS = 15_000;

// =============================================================================
// Types
// =============================================================================

export interface CopilotApiToken {
  /** The short-lived token to put in `Authorization: Bearer`. */
  token: string;
  /** Absolute expiry in seconds since epoch (from the server response). */
  expiresAt: number;
  /** Base URL for Copilot API requests (e.g. https://api.individual.githubcopilot.com). */
  endpointApi: string;
}

// =============================================================================
// Token Manager
// =============================================================================

class CopilotTokenManager {
  private _cached: CopilotApiToken | null = null;
  private _inflight: Promise<CopilotApiToken> | null = null;

  /**
   * Get a valid short-lived Copilot API token.
   * - Returns cached if still fresh.
   * - Otherwise refreshes via /copilot_internal/v2/token.
   * - Concurrent callers share the same in-flight refresh.
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
   * Discard the cached token, forcing the next getToken() call to re-fetch.
   * Call this on 401 responses from Copilot API endpoints.
   */
  invalidate(): void {
    this._cached = null;
  }

  private _isExpiring(t: CopilotApiToken): boolean {
    const now = Math.floor(Date.now() / 1000);
    return t.expiresAt <= now + REFRESH_SKEW_SECONDS;
  }

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

/** Shared singleton used by all Copilot provider instances. */
export const copilotTokenManager = new CopilotTokenManager();
