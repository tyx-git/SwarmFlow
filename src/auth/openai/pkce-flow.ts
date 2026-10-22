/** 浏览器 PKCE 登录：本地回调服务、授权跳转与无头变体。 */

import { createHash, randomBytes } from "node:crypto";

import { createServer, type Server } from "node:http";

import { browser } from "../../platform/index.js";
import { getUiCommonColors } from "../../config/ui-colors.js";

import { AUTHORIZE_URL, AUTH_TIMEOUT_MS, CLIENT_ID, PKCE_CALLBACK_HOST, PKCE_CALLBACK_PORT, PKCE_REDIRECT_URI, PKCE_SCOPES, TOKEN_URL } from "./endpoints.js";
import { fetchForm } from "./http.js";
import { type OAuthTokens } from "./token-store.js";
import { type HeadlessOAuthOptions } from "./types.js";

// =============================================================================
// 常量
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
  const colors = getUiCommonColors().oauthCallback;
  return `<!DOCTYPE html><html><head><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;
align-items:center;height:100vh;margin:0;background:${colors.background}}
.card{text-align:center;padding:2rem;border-radius:12px;background:${colors.surface};
box-shadow:0 2px 8px ${colors.shadow}}h1{margin:0 0 .5rem;font-size:1.5rem}
p{color:${colors.text};margin:0}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

// =============================================================================
// 无头 OAuth 流程（UI 无关，回调驱动）
// =============================================================================

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
