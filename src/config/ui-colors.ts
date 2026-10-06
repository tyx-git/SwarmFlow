import colorTable from "../../assets/ui-colors/color.json" with { type: "json" };

/** Shared colors used outside the OpenTUI theme renderer. */
export interface UiColorCommonTokens {
  workingStatus: string;
  workedStatus: string;
  commandSwitchEchoText: string;
  taskOpenText: string;
  taskActiveText: string;
  taskDoneText: string;
  taskIdText: string;
  transparent: string;
  syntaxCommentExempt: readonly string[];
  browserDesign: {
    background: string;
    text: string;
    heading: string;
    surface: string;
    border: string;
    goalStrong: string;
    note: string;
    badge: string;
  };
  oauthCallback: {
    background: string;
    surface: string;
    text: string;
    shadow: string;
  };
  buildConsole: {
    header: string;
    step: string;
    success: string;
    warning: string;
    title: string;
  };
  openTuiCore: {
    transparent: string;
    black: string;
    white: string;
    focusBorder: string;
    lineNumber: string;
    diffAddedBackground: string;
    diffRemovedBackground: string;
    diffAddedSign: string;
    diffRemovedSign: string;
    error: string;
    selectFocusedBackground: string;
    selectSelectedBackground: string;
    selectSelectedText: string;
    selectDescription: string;
    selectSelectedDescription: string;
    selectIndicator: string;
    tabArrow: string;
    sliderThumb: string;
    sliderTrack: string;
    placeholder: string;
    timeToFirstDraw: string;
    invalidColor: string;
    namedColors: Record<string, string>;
    console: {
      info: string;
      warning: string;
      error: string;
      debug: string;
      default: string;
      background: string;
      titleBar: string;
      titleBarText: string;
      cursor: string;
      selection: string;
      copyButton: string;
    };
  };
}

interface ColorTable {
  Theme?: {
    Common?: Partial<UiColorCommonTokens>;
  };
}

const HEX_COLOR = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
const CONSOLE_COLOR = /^(?:Black|DarkBlue|DarkGreen|DarkCyan|DarkRed|DarkMagenta|DarkYellow|Gray|DarkGray|Blue|Green|Cyan|Red|Magenta|Yellow|White)$/;
const REQUIRED_KEYS: Array<keyof UiColorCommonTokens> = [
  "workingStatus",
  "workedStatus",
  "commandSwitchEchoText",
  "taskOpenText",
  "taskActiveText",
  "taskDoneText",
  "taskIdText",
  "transparent",
  "syntaxCommentExempt",
  "browserDesign",
  "oauthCallback",
  "buildConsole",
  "openTuiCore",
];

function validateColorTree(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (!HEX_COLOR.test(value) && !(path.startsWith("Theme.Common.buildConsole.") && CONSOLE_COLOR.test(value))) {
      throw new Error(`color.json: ${path} must be a #RRGGBB or #RRGGBBAA color`);
    }
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

let commonCache: UiColorCommonTokens | null = null;

export function getUiCommonColors(): UiColorCommonTokens {
  if (commonCache) return commonCache;
  const common = (colorTable as ColorTable).Theme?.Common;
  if (!common) throw new Error("color.json: missing Theme.Common");
  for (const key of REQUIRED_KEYS) {
    if (common[key] === undefined) throw new Error(`color.json: missing Theme.Common.${key}`);
  }
  validateColorTree(common, "Theme.Common");
  commonCache = common as UiColorCommonTokens;
  return commonCache;
}
