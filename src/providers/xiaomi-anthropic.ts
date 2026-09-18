/**
 * Xiaomi（MiMo）Anthropic 兼容提供者。
 *
 * 端点：
 *   - 按量付费（全球）：https://api.xiaomimimo.com/anthropic
 *   - Token 计划（中国）：https://token-plan-cn.xiaomimimo.com/anthropic
 *   - Token 计划（新加坡）：https://token-plan-sgp.xiaomimimo.com/anthropic
 *   - Token 计划（欧洲）：https://token-plan-ams.xiaomimimo.com/anthropic
 *
 * 根据官方文档，API 通过标准 Anthropic 形状支持文本、图像、函数调用和
 * 深度思考。Thinking 通过 `thinking.type` 简单开/关 — 供应商不暴露 effort 子级。
 *
 * 不发送 `cache_control` 标记（与其他开源供应商家族一致；如果 Xiaomi 未来
 * 添加显式缓存支持，我们可以通过标志启用）。
 */

import { getProviderDefaultBaseUrl } from "../providers/defaults.js";
import { BaseAnthropicProvider } from "./anthropic-base.js";

export class XiaomiAnthropicProvider extends BaseAnthropicProvider {
  protected override _defaultBaseUrl(): string {
    return getProviderDefaultBaseUrl(this._config.provider) ?? "https://api.xiaomimimo.com/anthropic";
  }
}
