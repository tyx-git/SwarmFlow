export interface LogicalCursorPosition {
  row: number;
  col: number;
}

export interface VisualLineStartPosition {
  logicalRow: number;
  logicalCol: number;
}

export type DeleteToVisualLineStartAction =
  | "noop"
  | "delete-to-line-start"
  | "delete-visual-selection";

export function getDeleteToVisualLineStartAction(
  cursor: LogicalCursorPosition,
  visualStart: VisualLineStartPosition,
): DeleteToVisualLineStartAction {
  if (visualStart.logicalRow === cursor.row && visualStart.logicalCol === cursor.col) {
    return cursor.row > 0 ? "delete-to-line-start" : "noop";
  }

  if (visualStart.logicalRow === cursor.row && visualStart.logicalCol === 0) {
    return "delete-to-line-start";
  }

  return "delete-visual-selection";
}
