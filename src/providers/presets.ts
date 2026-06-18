/**
 * Shared provider/model catalog used by setup and runtime model picker.
 *
 * PROVIDER_PRESETS is now DERIVED from the provider registry
 * (assets/model-registry/providers.json via FACTORY_PROVIDER_SPECS). This file
 * keeps the preset shape + the lookup helpers consumers rely on; the data lives
 * in the registry. See Docs/provider-model-maintainability-plan.md.
 */

import {
  type ProviderSpec,
  credentialEnvVar,
  modelSpecIds,
  providerModelEffectiveId,
  providerModelKey,
} from "./models/registry.js";
import {
  EFFECTIVE_MODEL_SPECS,
  EFFECTIVE_PROVIDER_SPECS,
} from "./providers/registry-effective.js";

export interface ProviderPresetModel {
  /** Stable selector used by `/model` and init choices. */
  key: string;
  /** Actual API model ID sent to the provider. */
  id: string;
  /** Human-friendly label used in docs and init. */
  label: string;
  /** Optional note appended in `/model` picker labels. */
  optionNote?: string;
  /** Backward-compatible selector aliases. */
  aliases?: string[];
  /** Raw config overrides merged into generated/runtime model configs. */
  config?: Record<string, unknown>;
}

export interface ProviderPreset {
  id: string;
  name: string;
  envVar: string;
  models: ProviderPresetModel[];
  /** Group key for three-level picker grouping. */
  group?: string;
  /** Display label for the group parent node in the picker. */
  groupLabel?: string;
  /** Display label for this preset within its group (middle level). */
  subLabel?: string;
  /** Whether this is a local inference server. */
  localServer?: boolean;
  /** Default base URL for local servers. */
  defaultBaseUrl?: string;
}

/** model id (incl. alias spellings) 鈫?displayName, for inheriting labels on spec refs. */
const DISPLAY_NAME_BY_ID: ReadonlyMap<string, string> = new Map(
  EFFECTIVE_MODEL_SPECS.flatMap((s) => modelSpecIds(s).map((id) => [id, s.displayName] as const)),
);

/**
 * Project ProviderSpec[] into the legacy ProviderPreset[] shape consumers expect.
 * Optional fields are added conditionally (never set to undefined) so the shape
 * is byte-identical to the old hand-written literals.
 */
export function deriveProviderPresets(specs: readonly ProviderSpec[]): ProviderPreset[] {
  return specs.map((s) => {
    const models = s.models.map((ref) => {
      const m: ProviderPresetModel = {
        key: providerModelKey(ref),
        id: providerModelEffectiveId(ref),
        label: ref.label ?? DISPLAY_NAME_BY_ID.get(ref.spec ?? "") ?? providerModelEffectiveId(ref),
      };
      if (ref.optionNote !== undefined) m.optionNote = ref.optionNote;
      if (ref.aliases !== undefined) m.aliases = [...ref.aliases];
      if (ref.config !== undefined) m.config = ref.config;
      return m;
    });
    const preset: ProviderPreset = {
      id: s.id,
      name: s.name,
      envVar: credentialEnvVar(s.credential),
      models,
    };
    if (s.group) {
      preset.group = s.group.id;
      preset.groupLabel = s.group.label;
      preset.subLabel = s.group.subLabel;
    }
    if (s.localServer) {
      preset.localServer = true;
      if (s.defaultBaseUrl !== undefined) preset.defaultBaseUrl = s.defaultBaseUrl;
    }
    return preset;
  });
}

export const PROVIDER_PRESETS: ProviderPreset[] = deriveProviderPresets(EFFECTIVE_PROVIDER_SPECS);

export function findProviderPreset(providerId: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === providerId);
}

export function findProviderPresetModel(
  providerId: string,
  selection: string,
): ProviderPresetModel | undefined {
  const preset = findProviderPreset(providerId);
  if (!preset) return undefined;
  return preset.models.find((model) =>
    model.key === selection
      || model.id === selection
      || Boolean(model.aliases?.includes(selection))
  );
}

export function buildProviderPresetRawConfig(
  providerId: string,
  model: ProviderPresetModel,
  apiKey: string,
): Record<string, unknown> {
  return {
    provider: providerId,
    model: model.id,
    api_key: apiKey,
    ...(model.config ?? {}),
  };
}
