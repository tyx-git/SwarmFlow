/**
 * 提供者传输的共享默认 base URL。
 *
 * 由提供者注册表（FACTORY_PROVIDER_SPECS）派生；少数不是 picker 预设的有效
 * provider id（openai-chat、kimi-ai 别名）在这里保留显式回退。Config 解析和
 * 提供者子类都会读取这里，因此传输迁移不会漂移出重复的回退。
 */

import { EFFECTIVE_PROVIDER_SPECS } from "../providers/registry-effective.js";

/** 对于有效但不是 picker 预设的 provider id 的 base-url 回退。 */
const EXTRA_BASE_URLS: Record<string, string> = {
  "openai-chat": "https://api.openai.com/v1",
  "kimi-ai": "https://api.moonshot.ai/anthropic",
};

export const PROVIDER_DEFAULT_BASE_URLS: Record<string, string> = (() => {
  const out: Record<string, string> = { ...EXTRA_BASE_URLS };
  for (const spec of EFFECTIVE_PROVIDER_SPECS) {
    if (spec.defaultBaseUrl !== undefined) out[spec.id] = spec.defaultBaseUrl;
  }
  return out;
})();

export function getProviderDefaultBaseUrl(providerId: string): string | undefined {
  return PROVIDER_DEFAULT_BASE_URLS[providerId];
}
