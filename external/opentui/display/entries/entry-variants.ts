import type { DisplayTheme } from "../theme/index.js";

export function getSystemEntryColor(
  severity: "info" | "error" | "compact" | "interrupted" | "sub_agent" | "no_reply",
  theme: DisplayTheme,
): string {
  switch (severity) {
    case "error":
      return theme.colors.red;
    case "interrupted":
      return theme.colors.yellow;
    case "info":
    case "compact":
    case "sub_agent":
    case "no_reply":
      return theme.colors.dim;
    default:
      return theme.colors.dim;
  }
}

export function getActivityIndicatorColor(
  {
    active,
    error,
    interrupted,
  }: {
    active: boolean;
    error: boolean;
    interrupted?: boolean;
  },
  theme: DisplayTheme,
  kind: "thinking" | "tool",
): string {
  if (active) {
    return kind === "thinking"
      ? theme.presentation.thinkingColor
      : theme.presentation.toolNameColor;
  }
  if (error) {
    return theme.presentation.errorColor;
  }
  if (interrupted) {
    return theme.colors.waitingStatus;
  }
  return theme.presentation.successColor;
}
