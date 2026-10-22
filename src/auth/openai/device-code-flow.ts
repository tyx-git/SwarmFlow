/** 设备码登录流程（SSH / 无头环境备选）。 */

import { browser } from "../../platform/index.js";

import { AUTH_TIMEOUT_MS, CLIENT_ID, DEVICE_CODE_URL, DEVICE_POLL_URL, DEVICE_REDIRECT_URI, DEVICE_VERIFY_URL, TOKEN_URL } from "./endpoints.js";
import { fetchForm, fetchJson } from "./http.js";
import { type OAuthTokens } from "./token-store.js";
import { type HeadlessOAuthOptions } from "./types.js";

// =============================================================================
// 常量
// =============================================================================

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
