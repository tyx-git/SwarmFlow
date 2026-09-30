import type {
  DisplayThemeBrandingTokens,
  DisplayThemeLayoutTokens,
  DisplayThemeSpacingTokens,
} from "./types.js";

/** Theme data that is structural rather than color configuration. */
export const THEME_STRUCTURE: {
  spacing: DisplayThemeSpacingTokens;
  layout: DisplayThemeLayoutTokens;
  branding: Omit<DisplayThemeBrandingTokens, "logoGradient">;
} = {
  spacing: {
    screenPaddingY: 0,
    surfacePaddingX: 1,
    surfacePaddingY: 0,
  },
  layout: {
    inputMaxVisibleLines: 10,
    pickerVisibleRatio: 0.4,
    pickerMinVisible: 5,
    sidebarMinWidth: 30,
    sidebarMaxWidth: 50,
    minTerminalWidthForSidebar: 120,
  },
  branding: {
    logoLines: [
      "███████╗██╗    ██╗ █████╗ ██████╗ ███╗   ███╗███████╗██╗      ██████╗ ██╗    ██╗",
      "██╔════╝██║    ██║██╔══██╗██╔══██╗████╗ ████║██╔════╝██║     ██╔═══██╗██║    ██║",
      "███████╗██║ █╗ ██║███████║██████╔╝██╔████╔██║█████╗  ██║     ██║   ██║██║ █╗ ██║",
      "╚════██║██║███╗██║██╔══██║██╔══██╗██║╚██╔╝██║██╔══╝  ██║     ██║   ██║██║███╗██║",
      "███████║╚███╔███╔╝██║  ██║██║  ██║██║ ╚═╝ ██║██║     ███████╗╚██████╔╝╚███╔███╔╝",
      "╚══════╝ ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝╚═╝     ╚══════╝ ╚═════╝  ╚══╝╚══╝ ",
    ],
    sidebarWordmark: "SWARMFLOW",
    sidebarGradientIndices: [0, 1, 3, 5, 6],
  },
};
