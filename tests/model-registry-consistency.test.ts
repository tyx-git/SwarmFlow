import { describe, expect, it } from "bun:test";

import {
  FACTORY_MODEL_SPECS,
  FACTORY_PROVIDER_SPECS,
  isThinkingSpec,
  modelSpecIds,
  providerModelEffectiveId,
  resolveProviderWireAxes,
} from "../src/model-registry.js";
import { normalizeModelId } from "../src/config.js";
import {
  resolveSealedSchema,
  resolveThinkingEncryption,
  resolveTransportProtocol,
} from "../src/thinking-artifact.js";

/**
 * Consistency invariants for the model/provider registry. Unlike the
 * characterization snapshots (which lock current OUTPUT), these assert
 * structural truths that must hold for any future edit to the JSON data.
 */
describe("model registry consistency", () => {
  it("model id + alias spellings are globally unique", () => {
    const seen = new Map<string, string>();
    for (const spec of FACTORY_MODEL_SPECS) {
      for (const id of modelSpecIds(spec)) {
        expect(seen.has(id)).toBe(false);
        seen.set(id, spec.id);
      }
    }
  });

  it("every model has a positive context length and a non-empty display name", () => {
    for (const spec of FACTORY_MODEL_SPECS) {
      expect(spec.contextLength).toBeGreaterThan(0);
      expect(spec.displayName.trim().length).toBeGreaterThan(0);
    }
  });

  it("thinking support iff there is a non-off/none thinking level", () => {
    for (const spec of FACTORY_MODEL_SPECS) {
      const hasRealLevel = spec.thinkingLevels.some((l) => l !== "off" && l !== "none");
      expect(isThinkingSpec(spec)).toBe(hasRealLevel);
    }
  });

  it("every provider model ref resolves a known spec or carries an explicit label", () => {
    const knownIds = new Set(FACTORY_MODEL_SPECS.flatMap(modelSpecIds));
    for (const p of FACTORY_PROVIDER_SPECS) {
      for (const ref of p.models) {
        const ok = (ref.spec !== undefined && knownIds.has(ref.spec))
          || (ref.label !== undefined && ref.label.trim().length > 0);
        expect(ok).toBe(true);
      }
    }
  });
});

describe("provider wire-axis data matches thinking-artifact (anti-drift)", () => {
  // The authoritative three-axis logic lives in thinking-artifact. providers.json
  // mirrors it as ProviderSpec.wire. This guards the mirror against drift: for
  // every provider × model, resolveProviderWireAxes(spec.wire, model) must equal
  // the thinking-artifact resolvers. If a new provider's wire data is wrong, this
  // fails loudly instead of silently mis-routing reasoning.
  it("resolveProviderWireAxes equals resolve{Transport,Encryption,Sealed} for every provider×model", () => {
    for (const p of FACTORY_PROVIDER_SPECS) {
      // Use each exposed model plus a synthetic probe so even empty-model
      // providers (local servers) get their wire defaults checked.
      const probes = p.models.length > 0
        ? p.models.map(providerModelEffectiveId)
        : ["probe-model"];
      for (const model of probes) {
        const axes = resolveProviderWireAxes(p.wire, model);
        expect(axes.transport).toBe(resolveTransportProtocol(p.id, model));
        expect(axes.encryption).toBe(resolveThinkingEncryption(p.id, model));
        expect(axes.sealedSchema).toBe(resolveSealedSchema(p.id, model));
      }
    }
  });
});

describe("preset coverage", () => {
  // Provider model ids that intentionally have no ModelSpec. gpt-5-mini's exact
  // specs (output tokens / thinking levels) couldn't be sourced reliably, so it
  // stays spec-less rather than carry invented data.
  const SPECLESS_OK = new Set(["gpt-5-mini"]);

  it("every provider model id maps to a known spec (normalized), except known spec-less ones", () => {
    const knownIds = new Set(FACTORY_MODEL_SPECS.flatMap(modelSpecIds));
    const orphans: string[] = [];
    for (const p of FACTORY_PROVIDER_SPECS) {
      for (const ref of p.models) {
        const id = providerModelEffectiveId(ref);
        if (knownIds.has(id) || knownIds.has(normalizeModelId(id))) continue;
        if (SPECLESS_OK.has(id)) continue;
        orphans.push(`${p.id}:${id}`);
      }
    }
    expect(orphans).toEqual([]);
  });
});
