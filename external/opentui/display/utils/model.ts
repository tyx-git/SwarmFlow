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
