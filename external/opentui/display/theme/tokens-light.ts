import type { DisplayThemeTokens } from "./types.js";
import { DARK_TOKENS } from "./tokens-dark.js";

/**
 * Light mode token palette. Designed to render on a transparent background
 * inside a light terminal — text is a deep cool gray, surfaces are slightly
 * darker than the page, accent is a deeply saturated blue.
 *
 * Color choices follow the same hue families as DARK_TOKENS so brand identity
 * is preserved across modes. Lightness is inverted (dark text on light surfaces)
 * and saturation is increased where needed to clear the 4.5:1 contrast bar
 * against a white terminal background.
 *
 * Conservative first pass — readable everywhere, may not be pixel-perfect.
 */
export const LIGHT_TOKENS: DisplayThemeTokens = {
  colors: {
    userBg: "#eef0f3cc",        // raised surface w/ 80% alpha for subtle blend
    userWash: "#0969da33",      // accent @ ~20% — faint scannable wash
    border: "#d0d7de",          // standard divider
    scrollbarThumb: "#1f2328",
    scrollbarTrack: "#afb8c1",
    text: "#1f2328",            // primary fg
    dim: "#656d76",             // secondary fg — readable but quieter
    muted: "#afb8c1",           // tertiary fg — close to surface
    accent: "#0969da",          // deep saturated blue (brand)
    accentDim: "#5a7eaf",       // dimmed accent for inactive tabs
    orange: "#bc4c00",
    red: "#cf222e",
    yellow: "#9a6700",          // olive — pure yellow is unreadable on white
    green: "#1a7f37",
    cyan: "#0e7490",
    workingStatus: "#0969da",
    waitingStatus: "#9a6700",
    errorStatus: "#cf222e",
  },
  // spacing / layout are mode-agnostic; clone from dark.
  spacing: DARK_TOKENS.spacing,
  layout: DARK_TOKENS.layout,
  branding: {
    logoLines: DARK_TOKENS.branding.logoLines,
    // Single-hue luminance ramp (indigo, bright → dim, top → bottom); all stops ≥3:1 on white.
    logoGradient: ["#6b63ea", "#5d54e7", "#5249e6", "#4f46e5", "#4439c8", "#3a30ad", "#312892"],
    sidebarWordmark: DARK_TOKENS.branding.sidebarWordmark,
    sidebarGradientIndices: DARK_TOKENS.branding.sidebarGradientIndices,
  },
  markdown: {
    codeBorder: "#d0d7de",
    codeBorderHover: "#8c959f",
    codeLabelForeground: "#656d76",
    codeCopyForeground: "#afb8c1",
    codeCopyFlash: "#0969da",
    codeForeground: "#1f2328",
    syntax: {
      // Same hue families as dark, deepened for white background.
      keyword: "#b35900",       // orange (was dark #e0a050)
      string: "#1a7f37",        // green (was dark #8aad6a)
      function: "#8250df",      // purple-mauve (was dark #d0a0d0)
      type: "#9a6700",          // gold (was dark #e8c468)
      number: "#bc4c00",        // peach/orange (was dark #d08770)
      comment: "#6e7781",       // slate (was dark #5a5565) — flipped lightness
      operator: "#656d76",      // cool gray (was dark #9098a8) — flipped
      literal: "#0a4f4a",       // teal (was dark #6aa8a0)
      variable: "#1f2328",      // default text (was dark #b0b8c4) — flipped
      headingPrimary: "#0a5db8",
      headingSecondary: "#1a7ce0",
      raw: "#6f42c1",           // purple (was dark #b4a0ec)
    },
    hljs: {
      "hljs-keyword": "#b35900",
      "hljs-built_in": "#0a4f4a",
      "hljs-type": "#9a6700",
      "hljs-literal": "#0a4f4a",
      "hljs-number": "#bc4c00",
      "hljs-string": "#1a7f37",
      "hljs-subst": "#1f2328",
      "hljs-symbol": "#bc4c00",
      "hljs-class": "#9a6700",
      "hljs-function": "#8250df",
      "hljs-title": "#8250df",
      "hljs-title.function_": "#8250df",
      "hljs-title.class_": "#9a6700",
      "hljs-params": "#1f2328",
      "hljs-comment": "#6e7781",
      "hljs-doctag": "#656d76",
      "hljs-meta": "#656d76",
      "hljs-meta-keyword": "#b35900",
      "hljs-meta-string": "#1a7f37",
      "hljs-section": "#0a5db8",
      "hljs-tag": "#b35900",
      "hljs-name": "#cf222e",
      "hljs-attr": "#9a6700",
      "hljs-attribute": "#9a6700",
      "hljs-variable": "#1f2328",
      "hljs-bullet": "#bc4c00",
      "hljs-code": "#1f2328",
      "hljs-formula": "#bc4c00",
      "hljs-link": "#0a4f4a",
      "hljs-quote": "#6e7781",
      "hljs-selector-tag": "#cf222e",
      "hljs-selector-id": "#9a6700",
      "hljs-selector-class": "#8250df",
      "hljs-selector-attr": "#9a6700",
      "hljs-selector-pseudo": "#8250df",
      "hljs-template-tag": "#b35900",
      "hljs-template-variable": "#cf222e",
      "hljs-addition": "#1a7f37",
      "hljs-deletion": "#cf222e",
      "hljs-regexp": "#bc4c00",
    },
  },
  presentation: {
    thinkingColor: "#0550ae",
    successColor: "#1a7f37",
    errorColor: "#cf222e",
    toolNameColor: "#0969da",
    modelProviderColors: {
      openai: "#0a8060",          // slightly deeper than dark's #10a37f
      "openai-codex": "#0a8060",
      kimi: "#0284c7",            // deeper than dark's #38bdf8
      "kimi-cn": "#0284c7",
      "kimi-code": "#0284c7",
      minimax: "#db2777",         // deeper than dark's #f472b6
      "minimax-cn": "#db2777",
      glm: "#4f46e5",             // deeper than dark's #818cf8
      "glm-intl": "#4f46e5",
      "glm-code": "#4f46e5",
      "glm-intl-code": "#4f46e5",
      openrouter: "#9333ea",      // deeper than dark's #c084fc
      lmstudio: "#4b5563",        // neutral gray must darken on white
      omlx: "#4b5563",
      ollama: "#4b5563",
      anthropic: "#bf6500",       // beige unreadable on white; use brand burnt orange
    },
  },
};
