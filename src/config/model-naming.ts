/**
 * 模型标识符的规范化与用户可见标签格式化。
 */


// ------------------------------------------------------------------
// 辅助函数
// ------------------------------------------------------------------

/**
 * 去除 OpenRouter 风格模型 ID 的供应商前缀。
 * 例如 "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6"
 * 如果模型 ID 不包含 "/"，则原样返回。
 */
export function normalizeModelId(model: string): string {
  const idx = model.lastIndexOf("/");
  return idx >= 0 ? model.slice(idx + 1) : model;
}

/** 格式化简短的用户可见模型标签，用于状态栏等 UI 界面 */
export function formatDisplayModelName(provider: string | undefined, model: string | undefined): string {
  const safeProvider = String(provider ?? "").trim();
  const safeModel = String(model ?? "").trim();
  if (!safeModel) return safeProvider;
  if (safeProvider === "openrouter") {
    return `openrouter/${normalizeModelId(safeModel)}`;
  }
  return safeModel;
}

/** 格式化带提供商前缀的用户可见模型标签，用于状态消息 */
export function formatScopedModelName(provider: string | undefined, model: string | undefined): string {
  const safeProvider = String(provider ?? "").trim();
  const safeModel = String(model ?? "").trim();
  if (!safeProvider) return formatDisplayModelName(undefined, safeModel);
  if (!safeModel) return safeProvider;
  if (safeProvider === "openrouter") {
    return `openrouter/${normalizeModelId(safeModel)}`;
  }
  return `${safeProvider}/${safeModel}`;
}

