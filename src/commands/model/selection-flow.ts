/** 模型选择交互流程：就绪检查、选择器取值、结果解析。 */

import type { CommandPickerPresentation } from "../../ui/picker.js";

import { resolveModelSelection as resolveModelSelectionCore, type ResolvedModelSelection, parseProviderModelTarget } from "../../models/selection.js";
import { isManagedProvider } from "../../config/managed-provider-credentials.js";
import { ensureManagedProviderCredential } from "../../providers/credential-flow.js";

import { hasOAuthTokens, readOAuthAccessToken } from "../../auth/openai/token-store.js";
import { isTokenExpiring } from "../../auth/openai/jwt.js";
import { ensureFreshToken } from "../../auth/openai/refresh.js";
import { hasGitHubTokens } from "../../auth/github-copilot-oauth.js";

import { type ModelPickerOverrides, flatModelOptionsWithTree, modelOptionsWithTree } from "./picker-options.js";
import { createCommandPromptAdapter } from "../provider/credentials.js";
import { cmdModelLocalDiscover } from "../provider/discovery.js";
import { type CommandContext } from "../types.js";

export function resolveModelSelection(
  session: any,
  target: string,
) {
  return resolveModelSelectionCore(session, target);
}

async function ensureModelSelectionReady(
  ctx: CommandContext,
  target: string,
): Promise<ResolvedModelSelection | undefined> {
  const parsedTarget = parseProviderModelTarget(target);
  const adapter = createCommandPromptAdapter(ctx);

  if (parsedTarget?.provider === "openai-codex") {
    const existingToken = readOAuthAccessToken();
    if (hasOAuthTokens() && existingToken && isTokenExpiring(existingToken)) {
      try {
        await ensureFreshToken();
        ctx.session.config?.invalidateModelsByProvider?.("openai-codex");
        if (ctx.session.primaryAgent?.modelConfig?.provider === "openai-codex") {
          ctx.session.reloadCurrentModelConfig?.();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.session.appendErrorMessage?.(
          `OAuth token refresh failed: ${message}`,
          "oauth_refresh",
        );
      }
    }

    const currentToken = readOAuthAccessToken();
    const needsLogin = !hasOAuthTokens()
      || (currentToken && isTokenExpiring(currentToken));
    if (needsLogin && ctx.requestOAuthLogin) {
      const tokens = await ctx.requestOAuthLogin("codex");
      if (!tokens) return undefined;
      ctx.session.config?.invalidateModelsByProvider?.("openai-codex");
      if (ctx.session.primaryAgent?.modelConfig?.provider === "openai-codex") {
        ctx.session.reloadCurrentModelConfig?.();
      }
    } else if (needsLogin) {
      throw new Error(
        "OpenAI OAuth token is missing or expired.\n" +
        "Run 'swarmflow oauth' to log in.",
      );
    }
  }

  if (parsedTarget?.provider === "copilot" && !hasGitHubTokens()) {
    if (ctx.requestOAuthLogin) {
      const tokens = await ctx.requestOAuthLogin("copilot");
      if (!tokens) return undefined;
    } else {
      throw new Error(
        "Not logged in to GitHub Copilot.\n" +
        "Run 'swarmflow oauth' to log in.",
      );
    }
  }

  try {
    return resolveModelSelection(ctx.session, target);
  } catch (err) {
      if (parsedTarget && isManagedProvider(parsedTarget.provider) && adapter) {
      const result = await ensureManagedProviderCredential(
        parsedTarget.provider,
        adapter,
        { mode: "model", allowReplaceExisting: false, homeDir: ctx.swarmflowHomeDir },
      );
      if (result.status === "skipped") return undefined;
      return resolveModelSelection(ctx.session, target);
    }
    throw err;
  }
}

export async function pickResolvedModelSelection(
  ctx: CommandContext,
  opts?: {
    initialTarget?: string;
    treeOverrides?: ModelPickerOverrides;
    flatMessage?: string;
    picker?: CommandPickerPresentation;
  },
): Promise<ResolvedModelSelection | undefined> {
  let target = opts?.initialTarget?.trim() ?? "";

  while (true) {
    if (!target) {
      if (ctx.promptCommandPicker) {
        target = (await ctx.promptCommandPicker(
          modelOptionsWithTree({ session: ctx.session, store: ctx.store }, opts?.treeOverrides),
          opts?.picker,
        ))?.value ?? "";
      } else if (ctx.promptSelect) {
        const choice = await ctx.promptSelect({
          message: opts?.flatMessage ?? "Select model",
          options: flatModelOptionsWithTree({ session: ctx.session, store: ctx.store }, opts?.treeOverrides),
        });
        target = choice ?? "";
      } else {
        throw new Error("Interactive model selection is not available in this UI.");
      }
      if (!target) return undefined;
    }

    if (target.endsWith(":__discover__")) {
      await cmdModelLocalDiscover(ctx, target.split(":")[0]);
      target = "";
      continue;
    }

    return ensureModelSelectionReady(ctx, target);
  }
}
