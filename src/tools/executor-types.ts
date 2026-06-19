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
   * Abort signal for the current turn. Executors that can meaningfully
   * cancel mid-flight (currently `bash` and `web_fetch`) should listen
   * to it; others may ignore it. The tool-loop additionally re-checks
   * `signal.aborted` after the executor returns, so a tool that cannot
   * be cancelled will still unblock the loop at its next natural exit.
   */
  signal?: AbortSignal;
}

/**
 * A tool executor receives the arguments dict and an optional runtime
 * context, and returns either a plain string or a ToolResult. May be
 * synchronous or asynchronous.
 */
export type ToolExecutor = (
  args: Record<string, unknown>,
  ctx?: ToolExecutorContext,
) => ToolResult | string | Promise<ToolResult | string>;
