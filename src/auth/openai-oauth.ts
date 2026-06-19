/**
 * OpenAI OAuth（ChatGPT 账户登录）。
 *
 * 两种登录方式：
 *   1. 浏览器登录（PKCE）——推荐，一键授权
 *   2. 设备码——SSH/无头环境备选
 *
 * Token 持久化到 ~/.swarmflow/state/oauth.json，支持自动刷新。
 * 无外部依赖——使用 Node.js 18+ 内置 fetch、crypto、http。
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
// 常量
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

// PKCE 浏览器流程
const PKCE_CALLBACK_PORT = 1455;
const PKCE_CALLBACK_HOST = "127.0.0.1";
const PKCE_REDIRECT_URI = `http://localhost:${PKCE_CALLBACK_PORT}/auth/callback`;
const PKCE_SCOPES = "openid profile email offline_access";

/** 在令牌实际过期前 2 分钟刷新。 */
const REFRESH_SKEW_SECONDS = 120;

/** 等待用户完成登录的最大时间。 */
const AUTH_TIMEOUT_MS = 15 * 60 * 1000; // 15 分钟

/** 单次 HTTP 请求超时。 */
const HTTP_TIMEOUT_MS = 15_000;

// =============================================================================
// 类型
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
    /** 令牌获取时间的 ISO 时间戳（仅用于显示）。 */
    obtained_at: string;
  };
}

// =============================================================================
// Auth Store（同步文件 I/O）
// =============================================================================

/** 返回 oauth.json 文件路径。 */
function authStorePath(): string {
  return join(getSwarmflowHomeDir(), "state", "oauth.json");
}

/** 同步加载 oauth.json。若文件不存在或解析失败，返回空存储。 */
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

/**
 * 同步保存 oauth.json。
 * mode 0o600 将此令牌文件（OpenAI Codex + GitHub Copilot 访问/刷新令牌）
 * 限制为 POSIX 下仅所有者可读写。
 * 在 Windows 上 mode 只切换只读属性——0o600 位不映射到 NTFS ACL，
 * 保密性依赖从 %USERPROFILE% 继承的默认 ACL
 *（已排除其他标准用户）。可接受剩余风险；
 * 若要收紧需在 PAL 中使用显式 ACL 助手（icacls / SetNamedSecurityInfo）。
 */
export function saveAuthStore(store: AuthStoreData): void {
  const p = authStorePath();
  const stateDir = join(getSwarmflowHomeDir(), "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(p, JSON.stringify(store, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/** 保存 OpenAI Codex OAuth 令牌到 oauth.json。 */
export function saveOAuthTokens(tokens: OAuthTokens): void {
  const store = loadAuthStore();
  store.openai_codex = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    last_refresh: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  saveAuthStore(store);
}

/** 从 oauth.json 删除 OpenAI Codex OAuth 令牌。 */
export function clearOAuthTokens(): void {
  const store = loadAuthStore();
  delete store.openai_codex;
  saveAuthStore(store);
}

/**
 * 读取存储的 OAuth 访问令牌（同步）。
 * 无存储时返回 null。
 */
export function readOAuthAccessToken(): string | null {
  const store = loadAuthStore();
  const token = store.openai_codex?.access_token;
  return typeof token === "string" && token.trim() !== "" ? token : null;
}

/** 检查 oauth.json 中是否存在 OAuth 令牌。 */
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
// JWT 辅助函数
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

/** 带超时控制的 JSON 请求封装。 */
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

/** 发送 form-encoded 请求的便捷封装。 */
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
// Session 辅助函数
// =============================================================================

/** 通过平台 browser provider 打开 URL（open / xdg-open / start）。 */
function openBrowser(url: string): void {
  browser.openUrl(url);
}

/** 检测是否在远程会话中（SSH）。 */
function isRemoteSession(): boolean {
  return Boolean(process.env["SSH_CLIENT"] || process.env["SSH_TTY"]);
}

// =============================================================================
// PKCE 辅助函数
// =============================================================================

/** 生成 PKCE code verifier（RFC 7636 推荐 43-128 字符）。 */
function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** 从 verifier 计算 PKCE code challenge（S256 方法）。 */
function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** 生成 OAuth state 参数（防 CSRF）。 */
function generateState(): string {
  return randomBytes(16).toString("hex");
}

// =============================================================================
// PKCE 浏览器 OAuth 流程
// =============================================================================

/**
 * 启动临时 HTTP 服务器监听 localhost 以捕获 OAuth 回调。
 * 返回一个 Promise，在收到授权码后 resolve。
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

/** OAuth 回调页面的简约 HTML。 */
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
// 无头 OAuth 流程（UI 无关，回调驱动）
// =============================================================================

/** 无头 OAuth 流程发送的进度事件。 */
export type OAuthProgress =
  | { phase: "browser_waiting"; url: string }
  | { phase: "device_code"; url: string; userCode: string }
  | { phase: "polling" }
  | { phase: "exchanging" }
  | { phase: "done" }
  | { phase: "error"; message: string };

export interface HeadlessOAuthOptions {
  /** 进度更新回调，用于 UI 渲染。 */
  onProgress?: (event: OAuthProgress) => void;
  /** 中止信号，用于取消流程（如用户按 Esc）。 */
  signal?: AbortSignal;
  /** 是否自动打开浏览器（非 SSH 下默认 true）。 */
  openBrowserAutomatically?: boolean;
}

/**
 * 无头 PKCE 浏览器登录——无 console.log，无 inquirer。
 * 打开浏览器（除非被禁止），启动回调服务器，返回令牌。
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
 * 无头设备码登录——无 console.log，无 inquirer。
 * 请求设备码，轮询授权结果，返回令牌。
 */
export async function deviceCodeLoginHeadless(
  opts?: HeadlessOAuthOptions,
): Promise<OAuthTokens> {
  const onProgress = opts?.onProgress ?? (() => {});
  const signal = opts?.signal;

  if (signal?.aborted) throw new Error("Cancelled");

  // 步骤 1：请求设备码
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

  // 步骤 2：轮询授权码。
  // 注意：有意不在此循环内发送 phase: "polling"。
  // device_code 阶段自己的渲染已经显示了 "Waiting for sign-in..."
  // 并附上 URL 和用户码；切换到 polling 会替换为裸露的状态行。
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

  // 步骤 3：用授权码换取令牌
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
// CLI 封装（console.log + inquirer，用于 `swarmflow oauth` 命令）
// =============================================================================

/** CLI 浏览器登录——封装 headless flow 并添加控制台输出。 */
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

/** CLI 设备码登录——封装 headless flow 并添加控制台输出。 */
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
// Token 刷新
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

type OAuthService = "codex" | "copilot";
type OAuthAction = "login" | "status" | "logout";

/** 判断错误是否由用户取消 prompt 导致。 */
function isUserCancel(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (
    (err as { name?: string }).name === "ExitPromptError" ||
    (err as { code?: string }).code === "ERR_USE_AFTER_CANCEL"
  );
}

// -----------------------------------------------------------------------------
// Codex（OpenAI ChatGPT）处理器
// -----------------------------------------------------------------------------

/** 询问用户选择登录方式（浏览器或设备码）。 */
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

/** Codex 登录流程：检查已有令牌 → 决定刷新或重新登录。 */
async function codexLogin(): Promise<void> {
  // 检查是否已登录
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

/** 返回 Codex 状态的多行描述。 */
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

/** 清除 Codex OAuth 令牌。 */
function codexLogout(): void {
  if (!hasOAuthTokens()) {
    console.log("  Codex: not logged in — nothing to clear.");
    return;
  }
  clearOAuthTokens();
  console.log("  Codex OAuth tokens cleared.");
}

// -----------------------------------------------------------------------------
// Copilot（GitHub）处理器
// -----------------------------------------------------------------------------

/** Copilot 登录：设备码流程 + 预热模型可见性缓存。 */
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

  // 预热 Copilot 模型可见性缓存，使下次 /model 打开时隐藏 Pro+ 独占模型
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

/** 返回 Copilot 状态的多行描述。 */
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

/** 清除 Copilot OAuth 令牌，并清除每个账户的模型可见性缓存。 */
function copilotLogout(): void {
  if (!hasGitHubTokens()) {
    console.log("  Copilot: not logged in — nothing to clear.");
    return;
  }
  clearGitHubTokens();
  // 同时清除 per-account 模型可见性缓存，避免不同账户登录后继承前一个计划的隐藏模型
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
// 服务选择器辅助函数
// -----------------------------------------------------------------------------

/** 交互式选择服务（codex / copilot）。 */
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

/** 打印所有 OAuth 服务状态。 */
function printStatusAll(): void {
  console.log("  swarmflow OAuth Status");
  console.log();
  for (const line of codexStatusLines()) console.log(line);
  console.log();
  for (const line of copilotStatusLines()) console.log(line);
  console.log();
  console.log(`  Auth store:   ${authStorePath()}`);
}

/** 将字符串规范化为 OAuthService。 */
function normalizeService(raw?: string): OAuthService | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "codex" || v === "openai" || v === "openai-codex" || v === "chatgpt") return "codex";
  if (v === "copilot" || v === "github" || v === "github-copilot") return "copilot";
  return null;
}

// -----------------------------------------------------------------------------
// 公共入口点
// -----------------------------------------------------------------------------

/**
 * `swarmflow oauth [action] [service]` 的入口点。
 *
 * 两个参数均可选。action 为空时默认 login。
 * service 为空时显示交互式选择器（status 除外，status 始终显示所有服务）。
 */
export async function oauthCommand(
  action?: string,
  service?: string,
): Promise<void> {
  const normalized = (action ?? "").trim().toLowerCase();
  const explicitService = normalizeService(service);

  console.log();
  console.log("  ┌──────────────────────────────────────────────┐");
  console.log("  │           swarmflow OAuth Login              │");
  console.log("  └──────────────────────────────────────────────┘");
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
      // logout：仅提供有存储令牌的服务
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
