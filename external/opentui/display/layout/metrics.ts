import type { DisplayThemeLayoutTokens } from "../theme/index.js";

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function computePickerMaxVisible(
  terminalHeight: number,
  layout: DisplayThemeLayoutTokens,
): number {
  return Math.max(
    layout.pickerMinVisible,
    Math.floor(terminalHeight * layout.pickerVisibleRatio - 4),
  );
}

export function getSidebarWidth(
  terminalWidth: number,
  layout: DisplayThemeLayoutTokens,
): number {
  return clamp(
    Math.floor(terminalWidth * 0.26),
    layout.sidebarMinWidth,
    layout.sidebarMaxWidth,
  );
}
