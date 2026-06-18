/**
 * Xiaomi (MiMo) Anthropic-compatible provider.
 *
 * Endpoints:
 *   - Pay-as-you-go (global):  https://api.xiaomimimo.com/anthropic
 *   - Token Plan (CN):         https://token-plan-cn.xiaomimimo.com/anthropic
 *   - Token Plan (Singapore):  https://token-plan-sgp.xiaomimimo.com/anthropic
 *   - Token Plan (Europe):     https://token-plan-ams.xiaomimimo.com/anthropic
 *
 * Per official docs the API supports text, image, function calls, and
 * deep thinking through standard Anthropic shape. Thinking is a simple
 * on/off via `thinking.type` 鈥?the vendor does not expose effort sub-levels.
 *
 * No `cache_control` marker is sent (consistent with the rest of the
 * open-source vendor family; if Xiaomi adds explicit cache support later
 * we can opt in via a flag).
 */

import { getProviderDefaultBaseUrl } from "../providers/defaults.js";
import { BaseAnthropicProvider } from "./anthropic-base.js";

export class XiaomiAnthropicProvider extends BaseAnthropicProvider {
  protected override _defaultBaseUrl(): string {
    return getProviderDefaultBaseUrl(this._config.provider) ?? "https://api.xiaomimimo.com/anthropic";
  }
}
