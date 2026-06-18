import { describe, it, expect } from "bun:test";
import { parsePlanFile, formatPlanSnapshot } from "../src/plan-state.js";

describe("parsePlanFile", () => {
  it("parses all three checkpoint states", () => {
    const content = `# Plan

- [ ] First task
- [>] Second task in progress
- [x] Third task done
`;
    const result = parsePlanFile(content);
    expect(result).toEqual([
      { text: "First task", status: "pending" },
      { text: "Second task in progress", status: "active" },
      { text: "Third task done", status: "done" },
    ]);
  });

  it("handles uppercase X", () => {
    const result = parsePlanFile("- [X] Done task");
    expect(result).toEqual([{ text: "Done task", status: "done" }]);
  });

  it("ignores non-checkbox lines", () => {
    const content = `# My Plan

Some description text.

- [ ] Actual checkpoint
  This is a description under the checkpoint.
  More details here.

- [x] Another checkpoint

Random text at the end.
`;
    const result = parsePlanFile(content);
    expect(result).toEqual([
      { text: "Actual checkpoint", status: "pending" },
      { text: "Another checkpoint", status: "done" },
    ]);
  });

  it("returns empty array for empty content", () => {
    expect(parsePlanFile("")).toEqual([]);
  });

  it("returns empty array for content with no checkboxes", () => {
    expect(parsePlanFile("# Just a heading\n\nSome text.")).toEqual([]);
  });

  it("handles asterisk bullet markers", () => {
    const result = parsePlanFile("* [ ] Asterisk task");
    expect(result).toEqual([{ text: "Asterisk task", status: "pending" }]);
  });
});

describe("formatPlanSnapshot", () => {
  it("formats checkpoints into readable snapshot", () => {
    const checkpoints = [
      { text: "First task", status: "done" as const },
      { text: "Second task", status: "active" as const },
      { text: "Third task", status: "pending" as const },
    ];
    const result = formatPlanSnapshot(checkpoints);
    expect(result).toBe(
      "[Current Plan]\n" +
      "- [x] First task\n" +
      "- [>] Second task\n" +
      "- [ ] Third task",
    );
  });

  it("returns empty string for no checkpoints", () => {
    expect(formatPlanSnapshot([])).toBe("");
  });
});
