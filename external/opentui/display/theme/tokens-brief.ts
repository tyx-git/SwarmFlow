import type { DisplayThemeTokens } from "./types.js";
import { getThemeColors } from "./color-config.js";
import { THEME_STRUCTURE } from "./theme-structure.js";

/** Brief theme structure combined with the canonical JSON color tokens. */
export const BRIEF_TOKENS: DisplayThemeTokens = {
  colors: getThemeColors("brief").colors,
  spacing: THEME_STRUCTURE.spacing,
  layout: THEME_STRUCTURE.layout,
  branding: {
    ...THEME_STRUCTURE.branding,
    logoGradient: getThemeColors("brief").branding.logoGradient,
  },
  markdown: getThemeColors("brief").markdown,
  presentation: getThemeColors("brief").presentation,
};
