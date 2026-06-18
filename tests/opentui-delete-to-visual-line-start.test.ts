import { describe, expect, it } from "bun:test";

import { getDeleteToVisualLineStartAction } from "../opentui-src/input/delete-to-visual-line-start.js";

describe("opentui composer delete-to-visual-line-start", () => {
  it("deletes the previous newline when already at logical line start after the first line", () => {
    expect(getDeleteToVisualLineStartAction(
      { row: 1, col: 0 },
      { logicalRow: 1, logicalCol: 0 },
    )).toBe("delete-to-line-start");
  });

  it("does nothing at the start of the buffer", () => {
    expect(getDeleteToVisualLineStartAction(
      { row: 0, col: 0 },
      { logicalRow: 0, logicalCol: 0 },
    )).toBe("noop");
  });

  it("deletes to logical line start when the visual line starts at column 0", () => {
    expect(getDeleteToVisualLineStartAction(
      { row: 1, col: 5 },
      { logicalRow: 1, logicalCol: 0 },
    )).toBe("delete-to-line-start");
  });

  it("selects and deletes back to the current visual line start for wrapped lines", () => {
    expect(getDeleteToVisualLineStartAction(
      { row: 0, col: 25 },
      { logicalRow: 0, logicalCol: 20 },
    )).toBe("delete-visual-selection");
  });
});
