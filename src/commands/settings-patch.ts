/** 把部分配置更新写回全局 settings.json；失败返回 false 而不抛错，由调用方决定如何提示。 */

import type { SwarmflowSettings } from "../config/settings/types.js";

import { saveGlobalSettingsPatch } from "../config/settings/io.js";

/**
 * 把部分配置更新持久化到全局 settings.json。
 * 读取现有配置，合并补丁后写回。
 */
export function persistSettingsPatch(patch: Partial<SwarmflowSettings>, homeDir?: string): boolean {
  try {
    saveGlobalSettingsPatch(patch, homeDir);
    return true;
  } catch {
    return false;
  }
}
