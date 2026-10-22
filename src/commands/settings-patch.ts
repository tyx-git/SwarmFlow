/** 把部分配置更新写回全局 settings.json；失败返回 false 而不抛错，由调用方决定如何提示。 */

import type { SwarmflowSettings } from "../config/settings/types.js";

import { saveGlobalSettingsPatch } from "../config/settings/io.js";

/**
 * Persist a partial settings update to global settings.json.
 * Reads existing settings, merges the patch, and writes back.
 */
export function persistSettingsPatch(patch: Partial<SwarmflowSettings>, homeDir?: string): boolean {
  try {
    saveGlobalSettingsPatch(patch, homeDir);
    return true;
  } catch {
    return false;
  }
}
