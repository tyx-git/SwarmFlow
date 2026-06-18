/**
 * RPC method bindings for the init wizard.
 *
 * When `swarmflow --server` detects no provider configuration, it enters
 * init mode instead of throwing. These RPC methods let a GUI
 * webview drive the init wizard through the same stdio NDJSON channel.
 *
 * Once `init.finish` is called, the server bootstraps a Session and
 * transitions to normal session-rpc mode.
 */

import type { RpcServer } from "./rpc-transport.js";
import { InitService, type ModelSelection } from "../lifecycle/init-service.js";
import type { ModelTierEntry } from "../config/persistence.js";

export interface InitRpcOptions {
  readonly server: RpcServer;
  readonly onInitComplete: () => Promise<void>;
}

function expectObject(params: unknown, method: string): Record<string, unknown> {
  if (params == null) return {};
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new Error(`${method}: params must be an object`);
  }
  return params as Record<string, unknown>;
}

function expectString(params: Record<string, unknown>, key: string, method: string): string {
  const v = params[key];
  if (typeof v !== "string") throw new Error(`${method}: '${key}' must be a string`);
  return v;
}

function optString(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === "string" ? v : undefined;
}

export function registerInitRpc(opts: InitRpcOptions): { dispose: () => void } {
  const { server, onInitComplete } = opts;
  const service = new InitService();

  server.on("init.checkConfig", () => {
    return service.checkConfigStatus();
  });

  server.on("init.listProviders", () => {
    return service.listProviderPresets();
  });

  server.on("init.configureApiKeyProvider", (params) => {
    const p = expectObject(params, "init.configureApiKeyProvider");
    const providerId = expectString(p, "providerId", "init.configureApiKeyProvider");
    const apiKey = expectString(p, "apiKey", "init.configureApiKeyProvider");
    return service.configureApiKeyProvider(providerId, apiKey);
  });

  server.on("init.configureManagedProvider", (params) => {
    const p = expectObject(params, "init.configureManagedProvider");
    const providerId = expectString(p, "providerId", "init.configureManagedProvider");
    const apiKey = expectString(p, "apiKey", "init.configureManagedProvider");
    return service.configureManagedProvider(providerId, apiKey);
  });

  server.on("init.discoverLocalModels", async (params) => {
    const p = expectObject(params, "init.discoverLocalModels");
    const providerId = expectString(p, "providerId", "init.discoverLocalModels");
    const baseUrl = expectString(p, "baseUrl", "init.discoverLocalModels");
    const apiKey = optString(p, "apiKey");
    return service.configureLocalProvider(providerId, baseUrl, apiKey);
  });

  server.on("init.saveLocalProvider", (params) => {
    const p = expectObject(params, "init.saveLocalProvider");
    const providerId = expectString(p, "providerId", "init.saveLocalProvider");
    const baseUrl = expectString(p, "baseUrl", "init.saveLocalProvider");
    const modelId = expectString(p, "modelId", "init.saveLocalProvider");
    const contextLength = typeof p["contextLength"] === "number" ? p["contextLength"] : undefined;
    const apiKey = optString(p, "apiKey");
    service.saveLocalProvider(providerId, baseUrl, modelId, contextLength, apiKey);
    return { ok: true };
  });

  server.on("init.buildModelPickerTree", (params) => {
    const p = expectObject(params, "init.buildModelPickerTree");
    const current = p["currentSelection"] as ModelSelection | undefined;
    return service.buildModelPickerTree(current ?? undefined);
  });

  server.on("init.resolveModelSelection", (params) => {
    const p = expectObject(params, "init.resolveModelSelection");
    const target = expectString(p, "target", "init.resolveModelSelection");
    return service.resolveModelSelection(target);
  });

  server.on("init.getThinkingLevels", (params) => {
    const p = expectObject(params, "init.getThinkingLevels");
    const modelId = expectString(p, "modelId", "init.getThinkingLevels");
    return {
      all: service.getThinkingLevels(modelId),
      tierEligible: service.getTierEligibleThinkingLevels(modelId),
    };
  });

  server.on("init.getSearchApiOptions", () => {
    return service.getSearchApiOptions();
  });

  server.on("init.saveSearchApiKey", (params) => {
    const p = expectObject(params, "init.saveSearchApiKey");
    const envVar = expectString(p, "envVar", "init.saveSearchApiKey");
    const apiKey = expectString(p, "apiKey", "init.saveSearchApiKey");
    service.saveSearchApiKey(envVar, apiKey);
    return { ok: true };
  });

  server.on("init.finish", async (params) => {
    const p = expectObject(params, "init.finish");

    const modelSelection = p["modelSelection"] as ModelSelection | undefined;
    const thinkingLevel = optString(p, "thinkingLevel");
    const tierConfig = p["tierConfig"] as Record<string, ModelTierEntry> | undefined;

    service.saveConfiguration({ modelSelection, thinkingLevel, tierConfig });

    // Transition to session mode
    setImmediate(() => {
      void onInitComplete();
    });

    return { ok: true };
  });

  // OAuth flows 鈥?return device code info for the webview to display
  server.on("init.startOAuthFlow", async (params) => {
    const p = expectObject(params, "init.startOAuthFlow");
    const providerId = expectString(p, "providerId", "init.startOAuthFlow");

    if (providerId === "openai-codex") {
      const { deviceCodeLogin, saveOAuthTokens, hasOAuthTokens } = await import("../auth/openai-oauth.js");
      if (hasOAuthTokens()) {
        return { status: "already_authenticated", providerId };
      }
      const tokens = await deviceCodeLogin();
      saveOAuthTokens(tokens);
      return { status: "authenticated", providerId };
    }

    if (providerId === "copilot") {
      const { deviceCodeLoginCLI, saveGitHubTokens, hasGitHubTokens } = await import("../auth/github-copilot-oauth.js");
      if (hasGitHubTokens()) {
        return { status: "already_authenticated", providerId };
      }
      const tokens = await deviceCodeLoginCLI();
      saveGitHubTokens(tokens);
      return { status: "authenticated", providerId };
    }

    throw new Error(`init.startOAuthFlow: unknown OAuth provider: ${providerId}`);
  });

  return {
    dispose: () => {
      // RPC handlers are attached to the server; they'll be cleaned up
      // when the server is closed or when session-rpc replaces them.
    },
  };
}
