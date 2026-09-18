import type { SyntaxStyle } from "@opentui/core";

export type ThemeMode = "dark" | "light" | "default" | "dracula" | "brief";

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
  diffAdditionBg: string;
  diffDeletionBg: string;
  /** Thinking entry label and body text color. */
  thinkingText: string;
  /** Tool argument/suffix/path text color. */
  toolArg: string;
  /** Tool result body text color. */
  toolResultBody: string;
  /** Tool body border and connector color. */
  toolBar: string;
  /** User input prompt marker color (❯ at the front of user input). */
  userPrompt: string;
  /** 弱化文本：工具结果正文、非活动行的说明文字。 */
  textFaint: string;
  /** 次级文本：非活动条目的标题与正文，比 textFaint 更亮一档。 */
  textSecondary: string;
  /** 徽标：子代理面板指示器（前景 / 常态底色 / 展开态底色）。 */
  badgeAgentFg: string;
  badgeAgentBg: string;
  badgeAgentBgActive: string;
  /** 徽标：后台 shell 指示器。 */
  badgeShellFg: string;
  badgeShellBg: string;
  /** 徽标：todo / checkpoint 指示器。 */
  badgeTodoFg: string;
  badgeTodoBg: string;
  badgeTodoBgActive: string;
  /** 权限模式 read_only 的指示色（yolo 复用 red，其余复用 accent）。 */
  permissionReadOnly: string;
  /** Todo 清单三态：已完成 / 进行中 / 未开始的标记符与文本。 */
  todoDoneMark: string;
  todoDoneText: string;
  todoActiveMark: string;
  todoActiveText: string;
  todoPendingMark: string;
  todoPendingText: string;
  /** 危险操作 chip（如停止后台 shell）的底色与前景。 */
  dangerChipBg: string;
  dangerChipFg: string;
  /** 输入框文本光标颜色。 */
  cursor: string;
}

export interface DisplayThemeSpacingTokens {
  screenPaddingY: number;
  surfacePaddingX: number;
  surfacePaddingY: number;
}

export interface DisplayThemeLayoutTokens {
  inputMaxVisibleLines: number;
  pickerVisibleRatio: number;
  pickerMinVisible: number;
  sidebarMinWidth: number;
  sidebarMaxWidth: number;
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
  /** Resolved theme mode. Useful for branching by mode. */
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
