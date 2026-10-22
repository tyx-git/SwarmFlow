/** Codex 与 GitHub Copilot 的 OAuth 登录/登出/状态命令。 */

import { hasOAuthTokens, readOAuthAccessToken, clearOAuthTokens } from "../../auth/openai/token-store.js";
import { isTokenExpiring } from "../../auth/openai/jwt.js";
import { hasGitHubTokens, clearGitHubTokens } from "../../auth/github-copilot-oauth.js";

import { providerText } from "./presentation.js";
import { type CommandContext } from "../types.js";

export async function cmdCodex(ctx: CommandContext, args: string): Promise<void> {
  const t = providerText(ctx.swarmflowHomeDir);
  const sub = args.trim().toLowerCase();

  if (sub === "login" || sub === "") {
    const token = readOAuthAccessToken();
    const loggedIn = hasOAuthTokens() && token && !isTokenExpiring(token);
    if (loggedIn && sub !== "login") {
      ctx.showMessage(t.get(["Commands", "/provider", "oauth", "codexAlready"]));
      return;
    }
    if (ctx.requestOAuthLogin) {
      const tokens = await ctx.requestOAuthLogin("codex");
      if (!tokens) {
        ctx.showMessage(t.get(["Commands", "/provider", "oauth", "loginCancelled"]));
      }
    } else {
      ctx.showMessage(t.get(["Commands", "/provider", "oauth", "unavailable"]));
    }
    return;
  }

  if (sub === "logout") {
    clearOAuthTokens();
    ctx.showMessage(t.get(["Commands", "/provider", "oauth", "codexCleared"]));
    return;
  }

  if (sub === "status") {
    const token = readOAuthAccessToken();
    if (!token || !hasOAuthTokens()) {
      ctx.showMessage(t.get(["Commands", "/provider", "oauth", "notLoggedIn"]));
      return;
    }
    if (isTokenExpiring(token)) {
      ctx.showMessage(t.get(["Commands", "/provider", "oauth", "expiring"]));
    } else {
      ctx.showMessage(t.get(["Commands", "/provider", "oauth", "loggedIn"]));
    }
    return;
  }

  ctx.showMessage(t.get(["Commands", "/provider", "oauth", "unknownCodex"], { action: sub }));
}

// ------------------------------------------------------------------
// /副驾驶员命令
// ------------------------------------------------------------------

export async function cmdCopilot(ctx: CommandContext, args: string): Promise<void> {
  const t = providerText(ctx.swarmflowHomeDir);
  const sub = args.trim().toLowerCase();

  if (sub === "login" || sub === "") {
    if (hasGitHubTokens() && sub !== "login") {
      ctx.showMessage(t.get(["Commands", "/provider", "oauth", "copilotAlready"]));
      return;
    }
    if (ctx.requestOAuthLogin) {
      const result = await ctx.requestOAuthLogin("copilot");
      if (!result) {
        ctx.showMessage(t.get(["Commands", "/provider", "oauth", "loginCancelled"]));
      }
    } else {
      ctx.showMessage(t.get(["Commands", "/provider", "oauth", "unavailable"]));
    }
    return;
  }

  if (sub === "logout") {
    clearGitHubTokens();
    // 删除每个帐户的模型可见性缓存，以便将来登录
    // 不同的计划不会继承错误的隐藏模型集。
    try {
      const { clearCopilotModelsCache } = await import(
        "../../providers/copilot-models-cache.js"
      );
      clearCopilotModelsCache();
    } catch {
      // 忽略
    }
    ctx.showMessage(t.get(["Commands", "/provider", "oauth", "copilotCleared"]));
    return;
  }

  if (sub === "status") {
    if (!hasGitHubTokens()) {
      ctx.showMessage(t.get(["Commands", "/provider", "oauth", "notLoggedIn"]));
      return;
    }
    ctx.showMessage(t.get(["Commands", "/provider", "oauth", "loggedIn"]));
    return;
  }

  ctx.showMessage(t.get(["Commands", "/provider", "oauth", "unknownCopilot"], { action: sub }));
}

// ------------------------------------------------------------------
// /review——代码审查
// ------------------------------------------------------------------
