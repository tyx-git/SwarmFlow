/** OAuth 流程的进度回调与无头登录选项类型。 */

// =============================================================================
// 常量
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
