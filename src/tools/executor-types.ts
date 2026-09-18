/**
 * 工具执行器的共享类型。
 *
 * 放在专用文件中以避免 `src/tools/basic.ts`
 * 和 `src/agents/tool-loop.ts` 之间的循环依赖。
 */

import type { ToolResult } from "../providers/base.js";

/**
 * 传递给工具执行器的按调用运行时上下文。
 *
 * 保存会话中各个工具调用之间不同的值 — 不同于 `basic.ts`
 * 中的按会话静态 `ExecuteToolContext`，后者保存的值
 *（如 `projectRoot`）在会话期间是固定的。
 */
export interface ToolExecutorContext {
  /**
   * 当前轮次的中止信号。能够有意义地中途取消的执行器
   * （目前有 `bash` 和 `web_fetch`）应监听此信号；
   * 其他执行器可以忽略它。工具循环在执行器返回后还会
   * 重新检查 `signal.aborted`，因此无法取消的工具
   * 仍会在其下一次自然退出时解除循环阻塞。
   */
  signal?: AbortSignal;
}

/**
 * 工具执行器接收参数字典和可选的运行时上下文，
 * 并返回纯字符串或 ToolResult。可以是同步或异步的。
 */
export type ToolExecutor = (
  args: Record<string, unknown>,
  ctx?: ToolExecutorContext,
) => ToolResult | string | Promise<ToolResult | string>;