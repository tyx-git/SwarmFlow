import type { DisplayThemeLayoutTokens } from "../theme/index.js";

/**
 * Convert an untrusted layout value to a finite number.
 *
 * Yoga may briefly report NaN/Infinity while a terminal is being resized;
 * native OpenTUI calls require ordinary finite numeric arguments.
 */
export function finiteNumber(value: unknown, fallback = 0): number {
  const safeFallback = typeof fallback === "number" && Number.isFinite(fallback) ? fallback : 0;
  return typeof value === "number" && Number.isFinite(value) ? value : safeFallback;
}

/** Return a finite integer suitable for a terminal coordinate or extent. */
export function finiteInteger(value: unknown, fallback = 0): number {
  return Math.trunc(finiteNumber(value, fallback));
}

export function clamp(value: number, min: number, max: number): number {
  const safeMin = finiteNumber(min, 0);
  const safeMax = Math.max(safeMin, finiteNumber(max, safeMin));
  return Math.min(Math.max(finiteNumber(value, safeMin), safeMin), safeMax);
}

/** Clamp a value after normalizing all inputs to finite integers. */
export function clampInteger(value: unknown, min: number, max: number): number {
  const safeMin = finiteInteger(min, 0);
  const safeMax = Math.max(safeMin, finiteInteger(max, safeMin));
  return Math.min(Math.max(finiteInteger(value, safeMin), safeMin), safeMax);
}

export function computePickerMaxVisible(
  terminalHeight: number,
  layout: DisplayThemeLayoutTokens,
): number {
  const safeHeight = finiteInteger(terminalHeight, 0);
  const ratio = finiteNumber(layout.pickerVisibleRatio, 0);
  const minVisible = Math.max(1, finiteInteger(layout.pickerMinVisible, 1));
  return Math.max(
    minVisible,
    Math.floor(safeHeight * ratio - 4),
  );
}

export function getSidebarWidth(
  terminalWidth: number,
  layout: DisplayThemeLayoutTokens,
): number {
  return clamp(
    Math.floor(finiteNumber(terminalWidth, 0) * 0.26),
    layout.sidebarMinWidth,
    layout.sidebarMaxWidth,
  );
}
