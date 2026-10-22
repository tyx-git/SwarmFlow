/** OAuth 令牌类型与 ~/.swarmflow/state/oauth.json 的读写。 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { getSwarmflowHomeDir } from "../../config/home-dir.js";

// =============================================================================
// 常量
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
export function authStorePath(): string {
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
