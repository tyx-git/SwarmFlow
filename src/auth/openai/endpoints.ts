/** OpenAI OAuth 端点、客户端标识与超时常量。 */

// =============================================================================
// 常量
// =============================================================================

const ISSUER = "https://auth.openai.com";

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export const TOKEN_URL = `${ISSUER}/oauth/token`;

export const AUTHORIZE_URL = `${ISSUER}/oauth/authorize`;

export const DEVICE_CODE_URL = `${ISSUER}/api/accounts/deviceauth/usercode`;

export const DEVICE_POLL_URL = `${ISSUER}/api/accounts/deviceauth/token`;

export const DEVICE_VERIFY_URL = `${ISSUER}/codex/device`;

export const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`;

export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

// PKCE 浏览器流程
export const PKCE_CALLBACK_PORT = 1455;

export const PKCE_CALLBACK_HOST = "127.0.0.1";

export const PKCE_REDIRECT_URI = `http://localhost:${PKCE_CALLBACK_PORT}/auth/callback`;

export const PKCE_SCOPES = "openid profile email offline_access";

/** 在令牌实际过期前 2 分钟刷新。 */
export const REFRESH_SKEW_SECONDS = 120;

/** 等待用户完成登录的最大时间。 */
export const AUTH_TIMEOUT_MS = 15 * 60 * 1000; // 15 分钟

/** 单次 HTTP 请求超时。 */
export const HTTP_TIMEOUT_MS = 15_000;

// =============================================================================
// 类型
// =============================================================================
