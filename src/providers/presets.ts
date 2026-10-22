/** Shared provider metadata used by settings and runtime model selection. */

import {
  type ProviderSpec,
  credentialEnvVar,
} from "./provider-specs.js";
import { EFFECTIVE_PROVIDER_SPECS } from "../providers/registry-effective.js";

export interface ProviderPreset {
  id: string;
  name: string;
  envVar: string;
  group?: string;
  groupLabel?: string;
  subLabel?: string;
  localServer?: boolean;
  defaultBaseUrl?: string;
}

export function deriveProviderPresets(specs: readonly ProviderSpec[]): ProviderPreset[] {
  return specs.map((spec) => {
    const preset: ProviderPreset = {
      id: spec.id,
      name: spec.name,
      envVar: credentialEnvVar(spec.credential),
    };
    if (spec.group) {
      preset.group = spec.group.id;
      preset.groupLabel = spec.group.label;
      preset.subLabel = spec.group.subLabel;
    }
    if (spec.localServer) {
      preset.localServer = true;
      if (spec.defaultBaseUrl !== undefined) preset.defaultBaseUrl = spec.defaultBaseUrl;
    }
    return preset;
  });
}

export const PROVIDER_PRESETS = deriveProviderPresets(EFFECTIVE_PROVIDER_SPECS);

export function findProviderPreset(providerId: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === providerId);
}
