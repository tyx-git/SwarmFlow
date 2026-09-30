import colorTable from "../../../../assets/ui-colors/color.json" with { type: "json" };
import type {
  DisplayThemeColorTokens,
  DisplayThemeMarkdownTokens,
  DisplayThemePresentationTokens,
} from "./types.js";
import { getUiCommonColors, type UiColorCommonTokens } from "../../../../src/config/ui-colors.js";
export type { UiColorCommonTokens } from "../../../../src/config/ui-colors.js";

interface ColorThemeEntry {
  colors: DisplayThemeColorTokens;
  branding: { logoGradient: readonly string[] };
  markdown: DisplayThemeMarkdownTokens;
  presentation: DisplayThemePresentationTokens;
}

interface ColorTable {
  Theme?: {
    Common?: Partial<UiColorCommonTokens>;
    Brief?: ColorThemeEntry;
    Dark?: ColorThemeEntry;
    Light?: ColorThemeEntry;
  };
}

type ColorTheme = NonNullable<ColorTable["Theme"]>;

const HEX_COLOR = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
const CONSOLE_COLOR = /^(?:Black|DarkBlue|DarkGreen|DarkCyan|DarkRed|DarkMagenta|DarkYellow|Gray|DarkGray|Blue|Green|Cyan|Red|Magenta|Yellow|White)$/;
function assertColor(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || (!HEX_COLOR.test(value) && !(path.startsWith("Theme.Common.buildConsole.") && CONSOLE_COLOR.test(value)))) {
    throw new Error(`color.json: ${path} must be a #RRGGBB or #RRGGBBAA color`);
  }
}

function validateColorTree(value: unknown, path: string): void {
  if (typeof value === "string") {
    assertColor(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateColorTree(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    validateColorTree(child, `${path}.${key}`);
  }
}

let validatedTheme: ColorTheme | null = null;

function getTheme(): ColorTheme {
  if (validatedTheme) return validatedTheme;
  const theme = (colorTable as ColorTable).Theme;
  if (!theme) throw new Error("color.json: missing Theme object");
  validateColorTree(theme, "Theme");
  validatedTheme = theme;
  return validatedTheme;
}

function getThemeEntry(mode: "Brief" | "Dark" | "Light"): ColorThemeEntry {
  const entry = getTheme()[mode];
  if (!entry) throw new Error(`color.json: missing Theme.${mode}`);
  return entry;
}

export function getThemeColors(mode: "brief" | "dark" | "light"): ColorThemeEntry {
  return getThemeEntry(mode[0].toUpperCase() + mode.slice(1) as "Brief" | "Dark" | "Light");
}

export function getCommonColors(): UiColorCommonTokens {
  return getUiCommonColors();
}
