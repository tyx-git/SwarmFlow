import { describe, expect, it } from "vitest";

import { buildToolResultPreview } from "../../src/agents/tool-loop/display.js";

describe("buildToolResultPreview", () => {
  it("prefers an explicit tui_preview without truncating it", () => {
    const text = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join("\n");
    const preview = buildToolResultPreview(
      { tui_preview: { text, dim: false } },
      "ignored",
      false,
    );

    expect(preview.text).toBe(text);
    expect(preview.dim).toBeUndefined();
  });

  it("truncates a successful result after 20 lines", () => {
    const content = Array.from({ length: 25 }, (_, index) => `line-${index + 1}`).join("\n");
    const preview = buildToolResultPreview({}, content, false);

    expect(preview.text).toBe(
      `${Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n")}\n... (5 more lines)`,
    );
    expect(preview.dim).toBe(true);
  });

  it("does not synthesize a preview for errors", () => {
    const preview = buildToolResultPreview({}, "ERROR: failed", true);
    expect(preview).toEqual({});
  });

  it("falls back when the explicit preview is blank", () => {
    const preview = buildToolResultPreview(
      { tui_preview: { text: "   " } },
      "ok",
      false,
    );
    expect(preview).toEqual({ text: "ok", dim: true });
  });
});
