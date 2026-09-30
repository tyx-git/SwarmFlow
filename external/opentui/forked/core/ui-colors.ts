import colorTable from "../../../../assets/ui-colors/color.json" with { type: "json" };

export const OPEN_TUI_CORE_COLORS = (colorTable as {
  Theme: { Common: { openTuiCore: Record<string, any> } };
}).Theme.Common.openTuiCore;

export const OPEN_TUI_TRANSPARENT = OPEN_TUI_CORE_COLORS.transparent;
