import { describe, expect, it } from "bun:test";

import { PROVIDER_PRESETS } from "../src/provider-presets.js";
import { MANAGED_PROVIDER_CREDENTIAL_SPECS } from "../src/managed-provider-credentials.js";

/**
 * Phase 2 characterization — locks the provider-side structures NOT already
 * covered by the Phase 0 model snapshot (which covers capabilities, three-axis,
 * base urls, and describeModel labels). Here: the full PROVIDER_PRESETS shape
 * and the managed-credential specs. Must stay byte-identical when these are
 * rederived from PROVIDER_SPECS.
 */
describe("provider registry characterization (Phase 2 baseline)", () => {
  it("freezes PROVIDER_PRESETS structure", () => {
    expect(PROVIDER_PRESETS).toMatchSnapshot();
  });

  it("freezes managed-credential specs (order-independent by providerId)", () => {
    // Order is functionally irrelevant (all access is by-id lookup); the
    // meaningful invariant is same providers → same env vars. Snapshot the
    // by-id object so Bun's alphabetical key serialization is order-stable.
    const byId = Object.fromEntries(
      MANAGED_PROVIDER_CREDENTIAL_SPECS.map((s) => [s.providerId, s]),
    );
    expect(byId).toMatchSnapshot();
  });
});
