/** `swarmflow oauth` 子命令：Codex 与 GitHub Copilot 的 login/status/logout 交互与终端输出。 */

import { confirm, select } from "@inquirer/prompts";
import { browser } from "../platform/index.js";

import {
  deviceCodeLoginCLI as copilotDeviceCodeLoginCLI,
  saveGitHubTokens,
  clearGitHubTokens,
  hasGitHubTokens,
} from "./github-copilot-oauth.js";
import { deviceCodeLogin } from "./openai/device-code-flow.js";
import { getTokenExpiry, isTokenExpiring } from "./openai/jwt.js";
import { browserLogin } from "./openai/pkce-flow.js";
import { ensureFreshToken } from "./openai/refresh.js";
import { type OAuthTokens, authStorePath, clearOAuthTokens, hasOAuthTokens, loadAuthStore, readOAuthAccessToken, saveOAuthTokens } from "./openai/token-store.js";

// =============================================================================
// 常量
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
