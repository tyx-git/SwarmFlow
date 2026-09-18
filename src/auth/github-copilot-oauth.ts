/**
 * GitHub Copilot OAuth（GitHub Device Flow）。
 *
 * 唯一登录方式：Device Flow。GitHub 不为公开的 VS Code Copilot client_id
 * 提供 PKCE 浏览器流程。
 *
 * Token 生命周期：VS Code Copilot GitHub App（Iv1.b507a08c87ecfe98）关闭了
 * "Expire user authorization tokens"，因此设备流程只返回 access_token
 *（ghu_ 前缀的用户到服务器令牌，不过期）——无 expires_in，无 refresh_token。
 * 因此不追踪过期时间，也不维护刷新循环；令牌直接使用直到 GitHub 使其失效
 *（用户撤销 App），此时 copilotTokenManager 收到来自 /copilot_internal/v2/token
 * 的 401，用户通过 `swarmflow oauth login copilot` 重新认证。
 *
 * 持久化在 ~/.swarmflow/state/oauth.json 的 github_copilot 字段，
 * 与 openai_codex 共存。通过 loadAuthStore / saveAuthStore 共享同步文件 I/O。
 *
 * 仅依赖 Node.js 18+ 内置 fetch，无外部依赖。
 */

import {
  loadAuthStore,
  saveAuthStore,
  type OAuthProgress,
  type HeadlessOAuthOptions,
} from "./openai-oauth.js";

// =============================================================================
// 常量
// =============================================================================

/**
 * 公开的 VS Code Copilot client_id。
 * 被 copilot.vim、copilot.lua、ericc-h/copilot-api 及所有逆向 Copilot 客户端使用。
 * 非密钥——已在编辑器扩展源码中公开多年。
 */
const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const SCOPE = "read:user";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

/**
 * 模拟最新 VS Code + Copilot Chat 扩展，
 * 使 /copilot_internal/* 端点不因编辑器标识头拒绝我们。
 */
export const VSCODE_VERSION = "1.104.3";
export const COPILOT_CHAT_VERSION = "0.26.7";
export const GITHUB_API_VERSION = "2025-04-01";

/** api.github.com/copilot_internal/* 需要的编辑器标识头。 */
export const COPILOT_EDITOR_HEADERS: Readonly<Record<string, string>> = {
  "editor-version": `vscode/${VSCODE_VERSION}`,
  "editor-plugin-version": `copilot-chat/${COPILOT_CHAT_VERSION}`,
  "user-agent": `GitHubCopilotChat/${COPILOT_CHAT_VERSION}`,
  "x-github-api-version": GITHUB_API_VERSION,
};

/** 等待用户完成设备授权的最大时间。 */
const AUTH_TIMEOUT_MS = 15 * 60 * 1000;

/** 单次 HTTP 请求超时。 */
const HTTP_TIMEOUT_MS = 15_000;

// =============================================================================
// 类型
// =============================================================================

/**
 * 持久化的 GitHub Copilot 凭证。
 *
 * 仅追踪 access_token：该 GitHub App 颁发的令牌不过期，
 * 不返回 refresh_token，所以没有其他需要存储的内容。
 */
export interface GitHubOAuthTokens {
  access_token: string;
}

// =============================================================================
// 存储 I/O
// =============================================================================

/** 从 oauth.json 加载 GitHub Copilot 凭证。 */
export function loadGitHubTokens(): GitHubOAuthTokens | null {
  const store = loadAuthStore();
  const gh = store.github_copilot;
  if (!gh) return null;
  if (typeof gh.access_token !== "string" || !gh.access_token.trim()) return null;
  return { access_token: gh.access_token };
}

/** 将 GitHub Copilot 凭证保存到 oauth.json。 */
export function saveGitHubTokens(tokens: GitHubOAuthTokens): void {
  const store = loadAuthStore();
  store.github_copilot = {
    access_token: tokens.access_token,
    obtained_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  saveAuthStore(store);
}

/** 从 oauth.json 删除 GitHub Copilot 凭证。 */
export function clearGitHubTokens(): void {
  const store = loadAuthStore();
  delete store.github_copilot;
  saveAuthStore(store);
}

/** 检查是否已存储 GitHub Copilot 凭证。 */
export function hasGitHubTokens(): boolean {
  return loadGitHubTokens() !== null;
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
    let data: Record<string, unknown> = {};
    try {
      data = (await resp.json()) as Record<string, unknown>;
    } catch {
      // 非 JSON 响应体 — 保持 data 为空
    }
    return { status: resp.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

// =============================================================================
// 设备代码流程（无头）
// =============================================================================

/**
 * 无头 GitHub 设备码登录。
 * 通过 onProgress 发送进度信号，支持 signal 取消，返回令牌。
 *
 * 注：复用 openai-oauth.ts 的 OAuthProgress 联合类型。
 * 只发送 device_code、exchanging、done、error 阶段——不发送 polling
 *（见下方 "Waiting for sign-in..." 注释）和 browser_waiting
 *（设备流程无浏览器回调服务器）。
 */
export async function deviceCodeLoginHeadless(
  opts?: HeadlessOAuthOptions,
): Promise<GitHubOAuthTokens> {
  const onProgress: (event: OAuthProgress) => void =
    opts?.onProgress ?? (() => {});
  const signal = opts?.signal;

  if (signal?.aborted) throw new Error("Cancelled");

  // 步骤 1：请求设备代码
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

  // 步骤 2：轮询授权结果
  const deadline = Math.min(
    Date.now() + AUTH_TIMEOUT_MS,
    Date.now() + expiresIn * 1000,
  );
  let currentInterval = interval;

  // 注意：有意不在此循环内发送 phase: "polling"。
  // device_code 阶段自己的渲染已经显示了 "Waiting for sign-in..."
  // 并附上 URL 和用户码；切换到 polling 会替换为裸露的状态行，
  // 在用户复制之前抹掉验证码。
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

    // GitHub 即使在 pending 状态也返回 200，通过 error 字段标识。
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
// CLI 封装（控制台输出）
// =============================================================================

/**
 * 基于无头设备流程的 CLI 封装，带控制台输出。
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
// 存储令牌访问器
// =============================================================================

/**
 * 返回存储的 GitHub 访问令牌，若无存储则抛出错误。
 * 无刷新步骤——详见文件头部说明。
 *
 * 若 GitHub 后续使令牌失效（用户撤销 App），
 * 使用该令牌的调用方会收到 Copilot 端点的 401，
 * 应提示用户"运行 `swarmflow oauth` 重新认证"。
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
