import type { SyntaxStyle } from "@opentui/core";

export type ThemeMode = "dark" | "light";

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly (infer U)[]
    ? readonly U[]
    : T[K] extends Record<string, unknown>
      ? DeepPartial<T[K]>
      : T[K];
};

export interface DisplayThemeColorTokens {
  userBg: string;
  /** Faint accent wash behind user messages — a scannable anchor while
   * scrolling without the weight of the old solid surface. Expect an
   * #RRGGBBAA accent at very low alpha. */
  userWash: string;
  border: string;
  scrollbarThumb: string;
  scrollbarTrack: string;
  text: string;
  dim: string;
  muted: string;
  accent: string;
  accentDim: string;
  orange: string;
  red: string;
  yellow: string;
  green: string;
  cyan: string;
  workingStatus: string;
  waitingStatus: string;
  errorStatus: string;
}

export interface DisplayThemeSpacingTokens {
  screenPaddingX: number;
  screenPaddingY: number;
  screenGap: number;
  sectionGap: number;
  contentInset: number;
  surfacePaddingX: number;
  surfacePaddingY: number;
  inlineResultIndent: number;
}

export interface DisplayThemeLayoutTokens {
  inputMaxVisibleLines: number;
  pickerVisibleRatio: number;
  pickerMinVisible: number;
  sidebarMinWidth: number;
  sidebarMaxWidth: number;
  sidebarCollapsedWidth: number;
  minTerminalWidthForSidebar: number;
}

export interface DisplayThemeBrandingTokens {
  logoLines: readonly string[];
  logoGradient: readonly string[];
  sidebarWordmark: string;
  sidebarGradientIndices: readonly number[];
}

export interface DisplayThemeMarkdownTokens {
  codeBorder: string;
  codeBorderHover: string;
  codeLabelForeground: string;
  codeCopyForeground: string;
  codeCopyFlash: string;
  codeForeground: string;
  syntax: {
    keyword: string;
    string: string;
    function: string;
    type: string;
    number: string;
    comment: string;
    operator: string;
    literal: string;
    variable: string;
    headingPrimary: string;
    headingSecondary: string;
    raw: string;
  };
  hljs: Record<string, string>;
}

export interface DisplayThemePresentationTokens {
  thinkingColor: string;
  successColor: string;
  errorColor: string;
  toolNameColor: string;
  modelProviderColors: Record<string, string>;
}

export interface DisplayThemeTokens {
  colors: DisplayThemeColorTokens;
  spacing: DisplayThemeSpacingTokens;
  layout: DisplayThemeLayoutTokens;
  branding: DisplayThemeBrandingTokens;
  markdown: DisplayThemeMarkdownTokens;
  presentation: DisplayThemePresentationTokens;
}

export interface DisplayTheme {
  /** Resolved theme mode: "dark" or "light". Useful for branching by mode. */
  mode: ThemeMode;
  tokens: DisplayThemeTokens;
  colors: DisplayThemeColorTokens;
  spacing: DisplayThemeSpacingTokens;
  layout: DisplayThemeLayoutTokens;
  branding: DisplayThemeBrandingTokens;
  markdown: DisplayThemeMarkdownTokens;
  presentation: DisplayThemePresentationTokens;
  markdownStyle: SyntaxStyle;
}
