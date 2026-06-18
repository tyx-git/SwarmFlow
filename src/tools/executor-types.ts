/**
 * Shared types for tool executors.
 *
 * Kept in a dedicated file to avoid circular dependencies between
 * `src/tools/basic.ts` and `src/agents/tool-loop.ts`.
 */

import type { ToolResult } from "../providers/base.js";

/**
 * Per-call runtime context passed to a tool executor.
 *
 * Holds values that vary between individual tool invocations within a
 * session 鈥?distinct from the per-session static `ExecuteToolContext`
 * in `basic.ts`, which holds values like `projectRoot` that are fixed
 * for the duration of a session.
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
