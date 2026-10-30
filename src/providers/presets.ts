/** 设置界面与运行时模型选择共享的 provider 元数据。 */

import {
  type ProviderSpec,
  credentialEnvVar,
  FACTORY_PROVIDER_SPECS,
} from "./provider-specs.js";

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

export const PROVIDER_PRESETS = deriveProviderPresets(FACTORY_PROVIDER_SPECS);

export function findProviderPreset(providerId: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === providerId);
}
