import type { ModelDescriptor } from "../../../../src/models/presentation.js";
import type { DisplayTheme } from "../theme/index.js";

export function resolveModelNameColor(
  descriptor: ModelDescriptor | null,
  theme: DisplayTheme,
): string {
  if (!descriptor) return theme.colors.accent;
  return theme.presentation.modelProviderColors[descriptor.providerId]
    ?? theme.presentation.modelProviderColors[descriptor.brandKey]
    ?? theme.colors.accent;
}

/**
 * 选择器行首色标的颜色：按 provider id 或品牌家族 id 命中主题品牌色，
 * 未命中（未登记的厂商、纯动作行）退化为 muted，保持色标列连续。
 */
export function resolveSpineColor(theme: DisplayTheme, key: string | undefined): string {
  if (!key) return theme.colors.muted;
  return theme.presentation.modelProviderColors[key] ?? theme.colors.muted;
}
