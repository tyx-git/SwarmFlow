import type { CommandRegistry } from "../commands/registry.js";

/** 等待项保存原始命令，而不是作为模型可见的用户消息投递。 */
export interface DeferredCommand {
  text: string;
  session: object;
}

/** 只有显式允许等待的命令可以在工作中进入命令等待项。 */
export function enqueueDeferredCommand(
  registry: Pick<CommandRegistry, "lookup">,
  activeSession: object,
  input: string,
  current: DeferredCommand | null,
  hasQueuedUserInput: boolean,
): DeferredCommand | null {
  const text = input.trim();
  const name = text.split(/\s/, 1)[0] ?? "";
  if (registry.lookup(name)?.executionMode !== "queued") return null;
  if (current || hasQueuedUserInput) return null;
  return { text, session: activeSession };
}

/** 工作与自动续跑都结束后，才能把等待项交给命令处理器。 */
export function takeReadyDeferredCommand(
  item: DeferredCommand | null,
  activeSession: object,
  canRun: boolean,
): string | null {
  if (!item || item.session !== activeSession || !canRun) return null;
  return item.text;
}
