import type { DisplayThemeTokens } from "./types.js";
import { getThemeColors } from "./color-config.js";
import { THEME_STRUCTURE } from "./theme-structure.js";

/** Dark theme structure combined with the canonical JSON color tokens. */
export const DARK_TOKENS: DisplayThemeTokens = {
  colors: getThemeColors("dark").colors,
  spacing: THEME_STRUCTURE.spacing,
  layout: THEME_STRUCTURE.layout,
  branding: {
    ...THEME_STRUCTURE.branding,
    logoGradient: getThemeColors("dark").branding.logoGradient,
  },
  markdown: getThemeColors("dark").markdown,
  presentation: getThemeColors("dark").presentation,
};
