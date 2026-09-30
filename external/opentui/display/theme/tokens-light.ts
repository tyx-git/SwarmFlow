import type { DisplayThemeTokens } from "./types.js";
import { getThemeColors } from "./color-config.js";
import { THEME_STRUCTURE } from "./theme-structure.js";

/** Light theme structure combined with the canonical JSON color tokens. */
export const LIGHT_TOKENS: DisplayThemeTokens = {
  colors: getThemeColors("light").colors,
  spacing: THEME_STRUCTURE.spacing,
  layout: THEME_STRUCTURE.layout,
  branding: {
    ...THEME_STRUCTURE.branding,
    logoGradient: getThemeColors("light").branding.logoGradient,
  },
  markdown: getThemeColors("light").markdown,
  presentation: getThemeColors("light").presentation,
};
