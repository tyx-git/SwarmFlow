import { describe, expect, it } from "vitest";

import { PROVIDER_PRESETS } from "../src/providers/presets.js";
import { MANAGED_PROVIDER_CREDENTIAL_SPECS } from "../src/config/managed-provider-credentials.js";

describe("provider metadata", () => {
  it("contains connection metadata but no packaged model catalog", () => {
    expect(PROVIDER_PRESETS.length).toBeGreaterThan(0);
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.id).toBeTruthy();
      expect(preset.name).toBeTruthy();
      expect(Object.prototype.hasOwnProperty.call(preset, "models")).toBe(false);
    }
  });

  it("keeps managed credential slots provider-specific", () => {
    const ids = new Set(MANAGED_PROVIDER_CREDENTIAL_SPECS.map((spec) => spec.providerId));
    expect(ids.has("glm")).toBe(true);
    expect(ids.has("glm-code")).toBe(true);
    expect(ids.has("qwen-us")).toBe(true);
  });
});
