/** BaseProvider 抽象合约：发送、凭据刷新与 401/403 重发一次。 */

import { isUnauthorizedError } from "../network/retry.js";
import { ProviderResponse } from "./response.js";
import { type Message, type SendMessageOptions, type ToolDef } from "./types.js";

/**
 * 每个提供者适配器必须实现的接口。
 */
export abstract class BaseProvider {
  /**
   * 此提供者是否要求 user/assistant 角色严格交替。
   * 为 true 时，渲染管线会合并连续的同角色消息。
   */
  readonly requiresAlternatingRoles: boolean = false;

  /**
   * compact 检测如何计算 token 预算。
   * - "subtract_output": budget = contextLength - maxOutputTokens（默认）
   * - "full_context": budget = contextLength，仅检查 inputTokens
   */
  readonly budgetCalcMode: "subtract_output" | "full_context" = "subtract_output";

  /**
   * 向模型发送消息并返回统一响应。
   */
  abstract sendMessage(
    messages: Message[],
    tools?: ToolDef[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse>;

  /**
   * 凭据被上游拒绝（401/403）时刷新一次。
   *
   * 返回 true 表示凭据已更新、请求值得原样重发；返回 false 表示这个适配器
   * 没有可刷新的凭据（静态 API key），错误照原样抛给用户。
   *
   * 只有 OAuth 型适配器需要覆盖它。长会话里 access token 中途过期是常态，
   * 没有这条路径整轮就直接报废。
   */
  protected async _reauthenticate(): Promise<boolean> {
    return false;
  }

  /**
   * 带可选流式回调的异步发送。
   *
   * 使用完整 options 对象委托给 `sendMessage`，其中包括
   * 流式回调和中止信号。每个提供者的 `sendMessage`
   * 会检查 `onTextChunk`/`onReasoningChunk`，存在时路由到其
   * 流式实现。
   *
   * 额外负责 401/403 的"刷新凭据→原样重发一次"。重试环（network/retry）
   * 故意不认 4xx：凭据不刷新时重发多少次都是同一个错误，所以这里只发一次，
   * 失败就抛。
   */
  async asyncSendMessage(
    messages: Message[],
    tools?: ToolDef[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    let firstError: unknown;
    try {
      return await this.sendMessage(messages, tools, options);
    } catch (err) {
      if (!isUnauthorizedError(err)) throw err;
      firstError = err;
    }

    if (options?.signal?.aborted) throw firstError;
    if (!await this._reauthenticate()) throw firstError;
    if (options?.signal?.aborted) throw firstError;

    // 重发一次。刷新失败或仍然 401 都直接抛给调用方——4xx 不在退避重试环的
    // 识别范围内，所以不会有第三次尝试。
    return await this.sendMessage(messages, tools, options);
  }
}
