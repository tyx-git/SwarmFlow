/**
 * OpenAI OAuth for ChatGPT account login.
 *
 * Two login methods:
 *   1. Browser login (PKCE) 鈥?recommended, opens browser for one-click auth
 *   2. Device code 鈥?fallback for SSH / headless environments
 *
 * Token persistence in ~/.swarmflow/state/oauth.json with automatic refresh.
 * No external dependencies 鈥?uses Node 18+ built-in fetch, crypto, http.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { confirm, select } from "@inquirer/prompts";
import { browser } from "../platform/index.js";
import { getSwarmflowHomeDir } from "../lib/home-path.js";
import {
  deviceCodeLoginCLI as copilotDeviceCodeLoginCLI,
  saveGitHubTokens,
  clearGitHubTokens,
  hasGitHubTokens,
} from "./github-copilot-oauth.js";

// =============================================================================
// Constants
// =============================================================================

const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = `${ISSUER}/oauth/token`;
const AUTHORIZE_URL = `${ISSUER}/oauth/authorize`;
const DEVICE_CODE_URL = `${ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_POLL_URL = `${ISSUER}/api/accounts/deviceauth/token`;
const DEVICE_VERIFY_URL = `${ISSUER}/codex/device`;
const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`;
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

// PKCE browser flow
const PKCE_CALLBACK_PORT = 1455;
const PKCE_CALLBACK_HOST = "127.0.0.1";
const PKCE_REDIRECT_URI = `http://localhost:${PKCE_CALLBACK_PORT}/auth/callback`;
const PKCE_SCOPES = "openid profile email offline_access";

/** Refresh the access token 2 minutes before it actually expires. */
const REFRESH_SKEW_SECONDS = 120;

/** Maximum time to wait for the user to complete login. */
const AUTH_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

/** Timeout for individual HTTP requests. */
const HTTP_TIMEOUT_MS = 15_000;

// =============================================================================
// Types
// =============================================================================

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
}

export interface AuthStoreData {
  version: 1;
  openai_codex?: {
    access_token: string;
    refresh_token: string;
    last_refresh: string;
  };
  github_copilot?: {
    access_token: string;
    /** ISO timestamp of when the token was obtained (for display only). */
    obtained_at: string;
  };
}

// =============================================================================
// Auth store (sync file I/O)
// =============================================================================

function authStorePath(): string {
  return join(getSwarmflowHomeDir(), "state", "oauth.json");
}

export function loadAuthStore(): AuthStoreData {
  const p = authStorePath();
  if (!existsSync(p)) return { version: 1 };
  try {
    const raw = readFileSync(p, "utf-8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object" && data.version === 1) {
      return data as AuthStoreData;
    }
    return { version: 1 };
  } catch {
    return { version: 1 };
  }
}

export function saveAuthStore(store: AuthStoreData): void {
  const p = authStorePath();
  const stateDir = join(getSwarmflowHomeDir(), "state");
  mkdirSync(stateDir, { recursive: true });
  // mode 0o600 restricts this token file (OpenAI Codex + GitHub Copilot
  // access/refresh tokens) to the owner on POSIX. On Windows `mode` only
  // toggles the read-only attribute 鈥?the 0o600 bits don't map to NTFS
  // ACLs 鈥?so confidentiality there relies on the default ACL inherited
  // from %USERPROFILE% (which already excludes other standard users).
  // Accepted residual risk; tightening would need an explicit ACL helper
  // (icacls / SetNamedSecurityInfo) in the PAL 鈥?see decisions.md L-4.
  writeFileSync(p, JSON.stringify(store, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export function saveOAuthTokens(tokens: OAuthTokens): void {
  const store = loadAuthStore();
  store.openai_codex = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    last_refresh: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  saveAuthStore(store);
}

export function clearOAuthTokens(): void {
  const store = loadAuthStore();
  delete store.openai_codex;
  saveAuthStore(store);
}

/**
 * Read the stored OAuth access token (sync).
 * Returns null if no tokens are stored.
 */
export function readOAuthAccessToken(): string | null {
  const store = loadAuthStore();
  const token = store.openai_codex?.access_token;
  return typeof token === "string" && token.trim() !== "" ? token : null;
}

/** Check whether OAuth tokens exist in the auth store. */
export function hasOAuthTokens(): boolean {
  const store = loadAuthStore();
  const codex = store.openai_codex;
  return Boolean(
    codex &&
    typeof codex.access_token === "string" && codex.access_token.trim() !== "" &&
    typeof codex.refresh_token === "string" && codex.refresh_token.trim() !== "",
  );
}

// =============================================================================
// JWT helpers
// =============================================================================

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
 * Extract the ChatGPT account id from a codex OAuth access token. ChatGPT users
 * can belong to multiple accounts (personal / workspace / org); the codex backend
 * uses the `ChatGPT-Account-Id` request header to pick which one bills + applies
 * its quota. The id lives in the `chatgpt_account_id` claim, nested under either
 * `https://api.openai.com/auth` or at the top level depending on token shape.
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
 * Check whether an OAuth access token is about to expire.
 * Returns true if the token will expire within `skewSeconds` seconds,
 * or if the expiry cannot be determined.
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

export function getTokenExpiry(accessToken: string): Date | null {
  const claims = decodeJwtPayload(accessToken);
  const exp = claims["exp"];
  if (typeof exp !== "number") return null;
  return new Date(exp * 1000);
}

// =============================================================================
// HTTP helpers
// =============================================================================

async function fetchJson(
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

async function fetchForm(
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
// Session helpers
// =============================================================================

function openBrowser(url: string): void {
  // Routes through the platform browser provider (open / xdg-open /
  // start). All failure modes are swallowed inside the provider so
  // the user just sees the printed URL fall back to "please copy
  // this manually".
  browser.openUrl(url);
}

function isRemoteSession(): boolean {
  return Boolean(process.env["SSH_CLIENT"] || process.env["SSH_TTY"]);
}

// =============================================================================
// PKCE helpers
// =============================================================================

function generateCodeVerifier(): string {
  // 32 random bytes 鈫?43 base64url chars (RFC 7636 recommends 43-128)
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function generateState(): string {
  return randomBytes(16).toString("hex");
}

// =============================================================================
// PKCE Browser OAuth flow
// =============================================================================

/**
 * Start a temporary HTTP server on localhost to capture the OAuth callback.
 * Returns a promise that resolves with the authorization code.
 */
function waitForCallback(
  expectedState: string,
): { promise: Promise<string>; server: Server } {
  let resolvePromise: (code: string) => void;
  let rejectPromise: (err: Error) => void;

  const promise = new Promise<string>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const server = createServer({ keepAliveTimeout: 1 }, (req, res) => {
    res.setHeader("Connection", "close");
    const url = new URL(req.url ?? "/", `http://${PKCE_CALLBACK_HOST}:${PKCE_CALLBACK_PORT}`);

    if (url.pathname !== "/auth/callback") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      const desc = url.searchParams.get("error_description") || error;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(callbackHtml("Login Failed", `Error: ${desc}. You can close this tab.`));
      rejectPromise(new Error(`OAuth error: ${desc}`));
      return;
    }

    if (!code || state !== expectedState) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(callbackHtml("Login Failed", "Invalid callback. Please try again."));
      rejectPromise(new Error("Invalid OAuth callback: missing code or state mismatch."));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(callbackHtml("Login Successful", "You can close this tab and return to the terminal."));
    resolvePromise(code);
  });

  server.listen(PKCE_CALLBACK_PORT, PKCE_CALLBACK_HOST);

  return { promise, server };
}

function callbackHtml(title: string, message: string): string {
  return `<!DOCTYPE html><html><head><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;
align-items:center;height:100vh;margin:0;background:#f9fafb}
.card{text-align:center;padding:2rem;border-radius:12px;background:#fff;
box-shadow:0 2px 8px rgba(0,0,0,.1)}h1{margin:0 0 .5rem;font-size:1.5rem}
p{color:#666;margin:0}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

// =============================================================================
// Headless OAuth flows (UI-agnostic, callback-driven)
// =============================================================================

/** Progress events emitted by headless OAuth flows. */
export type OAuthProgress =
  | { phase: "browser_waiting"; url: string }
  | { phase: "device_code"; url: string; userCode: string }
  | { phase: "polling" }
  | { phase: "exchanging" }
  | { phase: "done" }
  | { phase: "error"; message: string };

export interface HeadlessOAuthOptions {
  /** Called with progress updates for UI rendering. */
  onProgress?: (event: OAuthProgress) => void;
  /** AbortSignal to cancel the flow (e.g. user presses Esc). */
  signal?: AbortSignal;
  /** Whether to auto-open the browser (default: true for non-SSH). */
  openBrowserAutomatically?: boolean;
}

/**
 * Headless PKCE browser login 鈥?no console.log, no inquirer.
 * Opens browser (unless suppressed), starts callback server, returns tokens.
 */
export async function browserLoginHeadless(
  opts?: HeadlessOAuthOptions,
): Promise<OAuthTokens> {
  const onProgress = opts?.onProgress ?? (() => {});
  const signal = opts?.signal;
  const autoOpen = opts?.openBrowserAutomatically ?? !isRemoteSession();

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: PKCE_REDIRECT_URI,
    scope: PKCE_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "swarmflow",
  });
  const authorizeUrl = `${AUTHORIZE_URL}?${params.toString()}`;

  const { promise: codePromise, server } = waitForCallback(state);
  const cleanup = () => {
    try {
      server.closeAllConnections();
      server.close();
    } catch { /* ignore */ }
  };

  try {
    if (signal?.aborted) throw new Error("Cancelled");

    if (autoOpen) openBrowser(authorizeUrl);
    onProgress({ phase: "browser_waiting", url: authorizeUrl });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Login timed out after 15 minutes.")), AUTH_TIMEOUT_MS);
    });
    const cancelPromise = signal
      ? new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
        })
      : new Promise<never>(() => {});

    const code = await Promise.race([codePromise, timeoutPromise, cancelPromise]);
    cleanup();

    onProgress({ phase: "exchanging" });
    const { status, data } = await fetchForm(TOKEN_URL, {
      grant_type: "authorization_code",
      code,
      redirect_uri: PKCE_REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
    });

    if (status !== 200) {
      const detail = typeof data["error_description"] === "string"
        ? data["error_description"]
        : `status ${status}`;
      throw new Error(`Token exchange failed: ${detail}`);
    }

    const accessToken = String(data["access_token"] ?? "");
    const refreshToken = String(data["refresh_token"] ?? "");
    if (!accessToken) throw new Error("Token exchange did not return an access_token.");

    onProgress({ phase: "done" });
    return { access_token: accessToken, refresh_token: refreshToken };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * Headless device code login 鈥?no console.log, no inquirer.
 * Requests device code, polls for authorization, returns tokens.
 */
export async function deviceCodeLoginHeadless(
  opts?: HeadlessOAuthOptions,
): Promise<OAuthTokens> {
  const onProgress = opts?.onProgress ?? (() => {});
  const signal = opts?.signal;

  if (signal?.aborted) throw new Error("Cancelled");

  // Step 1: Request device code
  let deviceData: Record<string, unknown>;
  try {
    const { status, data } = await fetchJson(DEVICE_CODE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID }),
    });
    if (status !== 200) throw new Error(`Device code request returned status ${status}.`);
    deviceData = data;
  } catch (err) {
    throw new Error(`Failed to request device code: ${err instanceof Error ? err.message : String(err)}`);
  }

  const userCode = String(deviceData["user_code"] ?? "");
  const deviceAuthId = String(deviceData["device_auth_id"] ?? "");
  const pollInterval = Math.max(3, Number(deviceData["interval"]) || 5);

  if (!userCode || !deviceAuthId) throw new Error("Device code response missing required fields.");

  onProgress({ phase: "device_code", url: DEVICE_VERIFY_URL, userCode });

  // Step 2: Poll for authorization code.
  // NOTE: we intentionally do NOT emit `phase: "polling"` inside this loop.
  // The `device_code` phase's own rendering already shows "Waiting for
  // sign-in..." alongside the URL and user code; switching to `polling` would
  // replace that display with a bare status line, erasing the code before
  // the user could copy it.
  const deadline = Date.now() + AUTH_TIMEOUT_MS;
  let codeResp: Record<string, unknown> | null = null;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Cancelled");
    await new Promise((r) => setTimeout(r, pollInterval * 1000));

    try {
      const { status, data } = await fetchJson(DEVICE_POLL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
      });

      if (status === 200) { codeResp = data; break; }
      if (status === 403 || status === 404) { continue; }
      throw new Error(`Device auth polling returned status ${status}.`);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") continue;
      throw err;
    }
  }

  if (codeResp === null) throw new Error("Login timed out after 15 minutes.");

  // Step 3: Exchange authorization code for tokens
  const authorizationCode = String(codeResp["authorization_code"] ?? "");
  const codeVerifierFromResp = String(codeResp["code_verifier"] ?? "");
  if (!authorizationCode || !codeVerifierFromResp) {
    throw new Error("Device auth response missing authorization_code or code_verifier.");
  }

  onProgress({ phase: "exchanging" });
  let tokenData: Record<string, unknown>;
  try {
    const { status, data } = await fetchForm(TOKEN_URL, {
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: DEVICE_REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: codeVerifierFromResp,
    });
    if (status !== 200) throw new Error(`Token exchange returned status ${status}.`);
    tokenData = data;
  } catch (err) {
    throw new Error(`Token exchange failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const accessToken = String(tokenData["access_token"] ?? "");
  const refreshToken = String(tokenData["refresh_token"] ?? "");
  if (!accessToken) throw new Error("Token exchange did not return an access_token.");

  onProgress({ phase: "done" });
  return { access_token: accessToken, refresh_token: refreshToken };
}

// =============================================================================
// CLI wrappers (console.log + inquirer for `swarmflow oauth` command)
// =============================================================================

/**
 * CLI browser login 鈥?wraps headless flow with console output.
 */
export async function browserLogin(): Promise<OAuthTokens> {
  return browserLoginHeadless({
    openBrowserAutomatically: !isRemoteSession(),
    onProgress: (event) => {
      switch (event.phase) {
        case "browser_waiting":
          console.log();
          if (isRemoteSession()) {
            console.log("  Open this URL in your browser:");
          } else {
            console.log("  Opening browser for authentication...");
            console.log("  If the browser didn't open, visit:");
          }
          console.log(`  \x1b[94m${event.url}\x1b[0m`);
          console.log();
          console.log("  Waiting for authorization... (press Ctrl+C to cancel)");
          break;
      }
    },
  });
}

/**
 * CLI device code login 鈥?wraps headless flow with console output.
 */
export async function deviceCodeLogin(): Promise<OAuthTokens> {
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
// Token refresh
// =============================================================================

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
// Composite: ensure fresh token
// =============================================================================

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

// =============================================================================
// CLI command: `swarmflow oauth [action] [service]`
// =============================================================================
//
// Supports two OAuth services:
//   - codex    鈥?OpenAI ChatGPT login (existing)
//   - copilot  鈥?GitHub Copilot device flow (new)
//
// Command forms:
//   swarmflow oauth                    鈫?picker: service 脳 action
//   swarmflow oauth login              鈫?picker: service
//   swarmflow oauth logout             鈫?picker: which service to clear
//   swarmflow oauth status             鈫?show all services' statuses
//   swarmflow oauth login codex        鈫?direct
//   swarmflow oauth login copilot      鈫?direct
//   swarmflow oauth logout codex       鈫?direct
//   swarmflow oauth logout copilot     鈫?direct
//
// Back-compat: users who previously ran `swarmflow oauth` or
// `swarmflow oauth login` now see a 2-item picker with one extra keystroke.
// =============================================================================

type OAuthService = "codex" | "copilot";
type OAuthAction = "login" | "status" | "logout";

function isUserCancel(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (
    (err as { name?: string }).name === "ExitPromptError" ||
    (err as { code?: string }).code === "ERR_USE_AFTER_CLOSE"
  );
}

// -----------------------------------------------------------------------------
// Codex (OpenAI ChatGPT) handlers
// -----------------------------------------------------------------------------

async function codexPerformLogin(): Promise<OAuthTokens> {
  const method = await select({
    message: "Login method",
    choices: [
      { name: "Browser login (recommended)", value: "browser" },
      { name: "Device code (SSH / headless)", value: "device" },
    ],
  });

  if (method === "browser") {
    return browserLogin();
  }
  return deviceCodeLogin();
}

async function codexLogin(): Promise<void> {
  // Check if already logged in
  if (hasOAuthTokens()) {
    const token = readOAuthAccessToken()!;
    const expiry = getTokenExpiry(token);
    const expiryStr = expiry ? expiry.toLocaleString() : "unknown";
    const expired = expiry ? expiry.getTime() < Date.now() : false;
    const tokenStatus = expired ? "expired" : "valid";

    console.log(`  Existing Codex login found (token ${tokenStatus}, expires: ${expiryStr})`);
    try {
      const reLogin = await confirm({
        message: "Re-authenticate with a new login?",
        default: false,
      });
      if (!reLogin) {
        if (expired || isTokenExpiring(token)) {
          console.log("  Refreshing token...");
          try {
            await ensureFreshToken();
            console.log("  Token refreshed successfully.");
          } catch (err) {
            console.error(
              `  Token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            console.log("  Please re-authenticate.");
          }
        } else {
          console.log("  Using existing login.");
        }
        return;
      }
    } catch (err) {
      if (isUserCancel(err)) {
        console.log("\n  Cancelled.");
        return;
      }
      throw err;
    }
  }

  const tokens = await codexPerformLogin();
  saveOAuthTokens(tokens);
  console.log();
  console.log("  Codex login successful!");
  console.log("  OAuth tokens saved to ~/.swarmflow/state/oauth.json");
  console.log();
  console.log(
    "  To use with swarmflow, run 'swarmflow init' and select",
  );
  console.log("  'OpenAI (ChatGPT Login)'.");
  console.log("  If it is already configured, you can switch to it later with '/model'.");
  console.log();
}

function codexStatusLines(): string[] {
  const lines: string[] = [];
  lines.push("  OpenAI ChatGPT (Codex)");
  if (!hasOAuthTokens()) {
    lines.push("    Status:       not logged in");
    return lines;
  }
  const token = readOAuthAccessToken()!;
  const expiry = getTokenExpiry(token);
  const expiryStr = expiry ? expiry.toLocaleString() : "unknown";
  const expired = expiry ? expiry.getTime() < Date.now() : false;
  const expiring = isTokenExpiring(token);

  const store = loadAuthStore();
  const lastRefresh = store.openai_codex?.last_refresh ?? "unknown";

  lines.push(`    Status:       ${expired ? "expired" : expiring ? "expiring soon" : "active"}`);
  lines.push(`    Expires:      ${expiryStr}`);
  lines.push(`    Last refresh: ${lastRefresh}`);
  return lines;
}

function codexLogout(): void {
  if (!hasOAuthTokens()) {
    console.log("  Codex: not logged in 鈥?nothing to clear.");
    return;
  }
  clearOAuthTokens();
  console.log("  Codex OAuth tokens cleared.");
}

// -----------------------------------------------------------------------------
// Copilot (GitHub) handlers
// -----------------------------------------------------------------------------

async function copilotLogin(): Promise<void> {
  if (hasGitHubTokens()) {
    console.log("  Existing Copilot login found (long-lived token).");
    try {
      const reLogin = await confirm({
        message: "Re-authenticate with a new login?",
        default: false,
      });
      if (!reLogin) {
        console.log("  Using existing login.");
        return;
      }
    } catch (err) {
      if (isUserCancel(err)) {
        console.log("\n  Cancelled.");
        return;
      }
      throw err;
    }
  }

  const tokens = await copilotDeviceCodeLoginCLI();
  saveGitHubTokens(tokens);

  // Prime the Copilot model-visibility cache so the picker hides Pro+
  // exclusive models on the next /model open. Best-effort 鈥?a failure here
  // just means the picker falls back to showing all models optimistically.
  try {
    const { refreshCopilotModelsCache } = await import(
      "../providers/copilot-models-cache.js"
    );
    await refreshCopilotModelsCache();
  } catch {
    // ignore
  }

  console.log();
  console.log("  Copilot login successful!");
  console.log("  GitHub OAuth tokens saved to ~/.swarmflow/state/oauth.json");
  console.log();
  console.log(
    "  To use with swarmflow, run 'swarmflow init' and select",
  );
  console.log("  'GitHub Copilot'.");
  console.log("  If it is already configured, you can switch to it later with '/model'.");
  console.log();
}

function copilotStatusLines(): string[] {
  const lines: string[] = [];
  lines.push("  GitHub Copilot");
  if (!hasGitHubTokens()) {
    lines.push("    Status:       not logged in");
    return lines;
  }
  const store = loadAuthStore();
  const obtainedAt = store.github_copilot?.obtained_at ?? "unknown";
  lines.push("    Status:       active (long-lived token)");
  lines.push(`    Obtained:     ${obtainedAt}`);
  return lines;
}

function copilotLogout(): void {
  if (!hasGitHubTokens()) {
    console.log("  Copilot: not logged in 鈥?nothing to clear.");
    return;
  }
  clearGitHubTokens();
  // Also drop the per-account model visibility cache so a later login for a
  // different account doesn't inherit the previous plan's hidden models.
  void import("../providers/copilot-models-cache.js").then((m) => {
    try {
      m.clearCopilotModelsCache();
    } catch {
      // ignore
    }
  });
  console.log("  Copilot OAuth tokens cleared.");
}

// -----------------------------------------------------------------------------
// Service picker helpers
// -----------------------------------------------------------------------------

async function pickService(
  message: string,
  options: { codex: boolean; copilot: boolean },
): Promise<OAuthService | null> {
  const choices: Array<{ name: string; value: OAuthService }> = [];
  if (options.codex) choices.push({ name: "OpenAI ChatGPT (Codex)", value: "codex" });
  if (options.copilot) choices.push({ name: "GitHub Copilot", value: "copilot" });

  if (choices.length === 0) return null;
  if (choices.length === 1) return choices[0]!.value;

  try {
    return await select({ message, choices });
  } catch (err) {
    if (isUserCancel(err)) return null;
    throw err;
  }
}

function printStatusAll(): void {
  console.log("  swarmflow OAuth Status");
  console.log();
  for (const line of codexStatusLines()) console.log(line);
  console.log();
  for (const line of copilotStatusLines()) console.log(line);
  console.log();
  console.log(`  Auth store:   ${authStorePath()}`);
}

function normalizeService(raw?: string): OAuthService | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "codex" || v === "openai" || v === "openai-codex" || v === "chatgpt") return "codex";
  if (v === "copilot" || v === "github" || v === "github-copilot") return "copilot";
  return null;
}

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

/**
 * Entry point for `swarmflow oauth [action] [service]`.
 *
 * Both arguments are optional. If action is empty, defaults to `login`.
 * If service is empty, shows an interactive picker (unless `status`, which
 * always displays all services).
 */
export async function oauthCommand(
  action?: string,
  service?: string,
): Promise<void> {
  const normalized = (action ?? "").trim().toLowerCase();
  const explicitService = normalizeService(service);

  console.log();
  console.log("  鈺斺晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晽");
  console.log("  鈺?          swarmflow OAuth Login          鈺?);
  console.log("  鈺氣晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨暆");
  console.log();

  let act: OAuthAction;
  switch (normalized) {
    case "":
    case "login":
      act = "login";
      break;
    case "status":
      act = "status";
      break;
    case "logout":
      act = "logout";
      break;
    default:
      console.log(`  Unknown action: ${normalized}`);
      console.log("  Usage: swarmflow oauth [login|status|logout] [codex|copilot]");
      return;
  }

  if (act === "status") {
    printStatusAll();
    return;
  }

  let chosen: OAuthService | null = explicitService;

  if (!chosen) {
    if (act === "login") {
      chosen = await pickService("Which service to log in to?", {
        codex: true,
        copilot: true,
      });
    } else {
      // logout: only offer services that have tokens stored
      const hasCodex = hasOAuthTokens();
      const hasCopilot = hasGitHubTokens();
      if (!hasCodex && !hasCopilot) {
        console.log("  Not logged in to any service.");
        return;
      }
      chosen = await pickService("Which service to log out of?", {
        codex: hasCodex,
        copilot: hasCopilot,
      });
    }
  }

  if (!chosen) {
    console.log("  Cancelled.");
    return;
  }

  if (act === "login") {
    if (chosen === "codex") await codexLogin();
    else await copilotLogin();
  } else {
    // act === "logout"
    if (chosen === "codex") codexLogout();
    else copilotLogout();
  }
}
