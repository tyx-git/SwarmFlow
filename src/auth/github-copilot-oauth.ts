/**
 * GitHub Copilot OAuth (GitHub Device Flow).
 *
 * Single login method: Device Flow. GitHub doesn't offer a PKCE browser flow
 * for the public VS Code Copilot client_id we reuse.
 *
 * Token lifecycle: the VS Code Copilot GitHub App (`Iv1.b507a08c87ecfe98`)
 * has "Expire user authorization tokens" **disabled**, so the device flow
 * returns only `access_token` (a `ghu_`-prefixed, non-expiring user-to-server
 * token) 鈥?no `expires_in`, no `refresh_token`. We therefore don't track an
 * expiry or maintain a refresh loop; the token is used directly until GitHub
 * invalidates it (user revokes the app), at which point `copilotTokenManager`
 * sees a 401 from `/copilot_internal/v2/token` and the user is prompted to
 * re-authenticate via `swarmflow oauth login copilot`.
 *
 * Persistence in `~/.swarmflow/state/oauth.json` under the `github_copilot` field,
 * alongside `openai_codex`. Sync file I/O primitives are shared with
 * `openai-oauth.ts` via `loadAuthStore` / `saveAuthStore`.
 *
 * No external dependencies beyond Node 18+ built-in fetch.
 */

import {
  loadAuthStore,
  saveAuthStore,
  type OAuthProgress,
  type HeadlessOAuthOptions,
} from "./openai-oauth.js";

// =============================================================================
// Constants
// =============================================================================

/**
 * Public VS Code Copilot client_id. Used by copilot.vim, copilot.lua,
 * ericc-ch/copilot-api, and every reverse-engineered Copilot client. Not a
 * secret 鈥?published in editor extension source trees for years.
 */
const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const SCOPE = "read:user";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

/**
 * Mimic a recent VS Code + Copilot Chat extension so that /copilot_internal/*
 * endpoints don't reject us based on editor-identification headers.
 */
export const VSCODE_VERSION = "1.104.3";
export const COPILOT_CHAT_VERSION = "0.26.7";
export const GITHUB_API_VERSION = "2025-04-01";

/** Editor-identification headers required by api.github.com/copilot_internal/*. */
export const COPILOT_EDITOR_HEADERS: Readonly<Record<string, string>> = {
  "editor-version": `vscode/${VSCODE_VERSION}`,
  "editor-plugin-version": `copilot-chat/${COPILOT_CHAT_VERSION}`,
  "user-agent": `GitHubCopilotChat/${COPILOT_CHAT_VERSION}`,
  "x-github-api-version": GITHUB_API_VERSION,
};

/** Maximum time to wait for the user to complete device authorization. */
const AUTH_TIMEOUT_MS = 15 * 60 * 1000;

/** Timeout for individual HTTP requests. */
const HTTP_TIMEOUT_MS = 15_000;

// =============================================================================
// Types
// =============================================================================

/**
 * Persisted GitHub Copilot credentials.
 *
 * Only `access_token` is tracked: the token issued by this GitHub App is
 * non-expiring and no refresh_token is returned, so there is nothing else to
 * store.
 */
export interface GitHubOAuthTokens {
  access_token: string;
}

// =============================================================================
// Store I/O
// =============================================================================

export function loadGitHubTokens(): GitHubOAuthTokens | null {
  const store = loadAuthStore();
  const gh = store.github_copilot;
  if (!gh) return null;
  if (typeof gh.access_token !== "string" || !gh.access_token.trim()) return null;
  return { access_token: gh.access_token };
}

export function saveGitHubTokens(tokens: GitHubOAuthTokens): void {
  const store = loadAuthStore();
  store.github_copilot = {
    access_token: tokens.access_token,
    obtained_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  saveAuthStore(store);
}

export function clearGitHubTokens(): void {
  const store = loadAuthStore();
  delete store.github_copilot;
  saveAuthStore(store);
}

export function hasGitHubTokens(): boolean {
  return loadGitHubTokens() !== null;
}

// =============================================================================
// HTTP
// =============================================================================

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    let data: Record<string, unknown> = {};
    try {
      data = (await resp.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON body 鈥?leave data empty.
    }
    return { status: resp.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

// =============================================================================
// Device code flow (headless)
// =============================================================================

/**
 * Headless GitHub Device Flow login.
 * Emits progress via onProgress, honors signal for cancellation, returns tokens.
 *
 * Note: reuses `OAuthProgress` union from openai-oauth.ts. We only emit
 * `device_code`, `exchanging`, `done`, `error` phases 鈥?never `polling`
 * (see the "Waiting for sign-in..." comment below) and never
 * `browser_waiting` (device flow has no browser callback server).
 */
export async function deviceCodeLoginHeadless(
  opts?: HeadlessOAuthOptions,
): Promise<GitHubOAuthTokens> {
  const onProgress: (event: OAuthProgress) => void =
    opts?.onProgress ?? (() => {});
  const signal = opts?.signal;

  if (signal?.aborted) throw new Error("Cancelled");

  // Step 1: request device code
  const deviceResp = await fetchJson(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE }),
  });
  if (deviceResp.status !== 200) {
    throw new Error(`Device code request failed: HTTP ${deviceResp.status}`);
  }

  const deviceCode = String(deviceResp.data["device_code"] ?? "");
  const userCode = String(deviceResp.data["user_code"] ?? "");
  const verificationUri = String(
    deviceResp.data["verification_uri"] ?? "https://github.com/login/device",
  );
  const interval = Math.max(3, Number(deviceResp.data["interval"]) || 5);
  const expiresIn = Number(deviceResp.data["expires_in"]) || 900;

  if (!deviceCode || !userCode) {
    throw new Error("Device code response missing required fields.");
  }

  onProgress({ phase: "device_code", url: verificationUri, userCode });

  // Step 2: poll for authorization
  const deadline = Math.min(
    Date.now() + AUTH_TIMEOUT_MS,
    Date.now() + expiresIn * 1000,
  );
  let currentInterval = interval;

  // NOTE: we intentionally do NOT emit `phase: "polling"` inside this loop.
  // The `device_code` phase's own rendering already shows "Waiting for
  // sign-in..." alongside the URL and user code; switching to `polling` would
  // replace that display with a bare status line, erasing the code before
  // the user could copy it.
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Cancelled");
    await new Promise((r) => setTimeout(r, currentInterval * 1000));
    if (signal?.aborted) throw new Error("Cancelled");

    const pollResp = await fetchJson(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    // GitHub returns 200 even for pending states, with `error` field set.
    const accessToken =
      typeof pollResp.data["access_token"] === "string"
        ? String(pollResp.data["access_token"])
        : "";
    const errorCode =
      typeof pollResp.data["error"] === "string"
        ? String(pollResp.data["error"])
        : "";

    if (accessToken) {
      onProgress({ phase: "exchanging" });
      onProgress({ phase: "done" });
      return { access_token: accessToken };
    }

    if (errorCode === "authorization_pending") {
      continue;
    }
    if (errorCode === "slow_down") {
      currentInterval += 5;
      continue;
    }

    const errorDesc =
      typeof pollResp.data["error_description"] === "string"
        ? String(pollResp.data["error_description"])
        : errorCode || `status ${pollResp.status}`;
    throw new Error(`Device auth failed: ${errorDesc}`);
  }

  throw new Error("Login timed out before user completed authorization.");
}

// =============================================================================
// CLI wrapper (console output)
// =============================================================================

/**
 * CLI wrapper around the headless device flow with console output.
 */
export async function deviceCodeLoginCLI(): Promise<GitHubOAuthTokens> {
  return deviceCodeLoginHeadless({
    onProgress: (event) => {
      switch (event.phase) {
        case "device_code":
          console.log();
          console.log("  To continue, follow these steps:");
          console.log();
          console.log("  1. Open this URL in your browser:");
          console.log(`     \x1b[94m${event.url}\x1b[0m`);
          console.log();
          console.log("  2. Enter this code:");
          console.log(`     \x1b[94m${event.userCode}\x1b[0m`);
          console.log();
          console.log("  Waiting for sign-in... (press Ctrl+C to cancel)");
          break;
      }
    },
  });
}

// =============================================================================
// Stored-token accessor
// =============================================================================

/**
 * Return the stored GitHub access token, or throw if no credentials are
 * stored. There is no refresh step 鈥?see the file header for why.
 *
 * If GitHub later invalidates the token (user revokes the app), callers that
 * use it will see a 401 from Copilot's endpoints and should surface the
 * "Run `swarmflow oauth` to re-authenticate" hint.
 */
export function getGitHubAccessToken(): string {
  const tokens = loadGitHubTokens();
  if (!tokens) {
    throw new Error(
      "No GitHub Copilot credentials stored. Run 'swarmflow oauth' to log in.",
    );
  }
  return tokens.access_token;
}
