/**
 * Shared default base URLs for provider transports.
 *
 * Derived from the provider registry (FACTORY_PROVIDER_SPECS); the few valid
 * provider ids that are not picker presets (openai-chat, the kimi-ai alias)
 * keep explicit fallbacks here. Both Config resolution and provider subclasses
 * read this so transport migration doesn't drift into duplicated fallbacks.
 */

import { EFFECTIVE_PROVIDER_SPECS } from "./providers/registry-effective.js";

/** Base-url fallbacks for provider ids that are valid but not picker presets. */
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
