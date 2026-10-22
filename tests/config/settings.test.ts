import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS } from "../../src/config/compact-thresholds.js";

describe("settings module", () => {
  it("exposes the automatic compact thresholds", () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      compact_before_turn: 85,
      compact_mid_turn: 90,
    });
    expect(DEFAULT_THRESHOLDS.compact_before_turn).toBeLessThanOrEqual(
      DEFAULT_THRESHOLDS.compact_mid_turn,
    );
  });
});
