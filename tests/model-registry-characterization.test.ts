import { describe, expect, it } from "bun:test";

import { PROVIDER_PRESETS } from "../src/provider-presets.js";
import {
  getContextLength,
  getExtendedCacheSupport,
  getHighestThinkingLevel,
  getModelMaxOutputTokens,
  getMultimodalSupport,
  getThinkingLevels,
  getThinkingSupport,
  getTierEligibleThinkingLevels,
  getWebSearchSupport,
  normalizeModelId,
} from "../src/config.js";
import { describeModel } from "../src/model-presentation.js";
import {
  effectiveSealedSchema,
  effectiveThinkingEncryption,
  effectiveTransportProtocol,
} from "../src/thinking-artifact.js";
import { getProviderDefaultBaseUrl } from "../src/provider-defaults.js";

/**
 * Phase 0 — characterization baseline for the model/provider registry refactor.
 *
 * Freezes the CURRENT output of every derived model/provider lookup so the
 * refactor (KNOWN_* tables / PROVIDER_PRESETS / label overrides / wire-axis
 * switches → single MODEL_SPECS / PROVIDER_SPECS data files) can prove
 * byte-for-byte equivalence. This test MUST keep passing unchanged across the
 * entire refactor; if it drifts, the derivation changed and that is a bug to
 * investigate, not a snapshot to bless.
 */
describe("model/provider derivation characterization (Phase 0 baseline)", () => {
  it("freezes per-(provider,model) capability + label + wire-axis derivation", () => {
    const rows: Record<string, unknown> = {};
    for (const preset of PROVIDER_PRESETS) {
      for (const model of preset.models) {
        const key = `${preset.id}::${model.key}`;
        const id = model.id;
        rows[key] = {
          id,
          normalized: normalizeModelId(id),
          contextLength: getContextLength(id),
          maxOutputTokens: getModelMaxOutputTokens(id),
          multimodal: getMultimodalSupport(id),
          thinking: getThinkingSupport(id),
          webSearch: getWebSearchSupport(id, undefined, preset.id),
          extendedCache: getExtendedCacheSupport(id),
          thinkingLevels: getThinkingLevels(id),
          tierThinkingLevels: getTierEligibleThinkingLevels(id),
          highestThinkingLevel: getHighestThinkingLevel(id),
          transport: effectiveTransportProtocol({ provider: preset.id, model: id }),
          encryption: effectiveThinkingEncryption({ provider: preset.id, model: id }),
          sealedSchema: effectiveSealedSchema({ provider: preset.id, model: id }),
          describe: describeModel({
            providerId: preset.id,
            selectionKey: model.key,
            modelId: id,
          }),
        };
      }
    }
    expect(rows).toMatchSnapshot();
  });

  it("freezes per-provider default base url", () => {
    const rows: Record<string, string | null> = {};
    for (const preset of PROVIDER_PRESETS) {
      rows[preset.id] = getProviderDefaultBaseUrl(preset.id) ?? null;
    }
    expect(rows).toMatchSnapshot();
  });
});
