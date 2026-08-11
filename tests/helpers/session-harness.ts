/**
 * Shared harness for session-runtime characterization tests.
 *
 * Drives a REAL Session through the REAL Agent tool loop against a scripted
 * provider, so ask suspension/resume/interrupt/compact mechanics exercise the
 * production code paths. Only the provider (model output) is scripted.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "../../src/agents/agent.js";
import type { ToolExecutor } from "../../src/agents/tool-loop.js";
import type { ApprovalRequest } from "../../src/ask.js";
import { SessionStore } from "../../src/config/persistence.js";
import {
  BaseProvider,
  ProviderResponse,
  Usage,
  type Message,
  type ToolCall,
  type ToolDef,
} from "../../src/providers/base.js";
import { Session } from "../../src/session.js";

export interface ScriptedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ScriptedRound {
  text?: string;
  toolCalls?: ScriptedToolCall[];
  /** Runs when the provider receives this round's request, before emitting events. */
  onCall?: (messages: Array<Record<string, unknown>>) => void;
}

export class ScriptedProvider extends BaseProvider {
  rounds: ScriptedRound[] = [];
  /** Messages received per provider call, in call order. */
  calls: Array<Array<Record<string, unknown>>> = [];

  async sendMessage(
    messages: Message[],
    _tools?: ToolDef[],
    options?: { onToolCallClosed?: (call: ToolCall) => void; signal?: AbortSignal },
  ): Promise<ProviderResponse> {
    const index = this.calls.length;
    this.calls.push(structuredClone(messages) as Array<Record<string, unknown>>);
    const round = this.rounds[index] ?? { text: "(unscripted round)" };
    round.onCall?.(messages as unknown as Array<Record<string, unknown>>);
    for (const tc of round.toolCalls ?? []) {
      options?.onToolCallClosed?.({
        id: tc.id,
        name: tc.name,
        rawArguments: JSON.stringify(tc.arguments),
        arguments: tc.arguments,
        parseError: null,
      });
    }
    return new ProviderResponse({
      text: round.text ?? "",
      usage: new Usage(50, 5),
    });
  }

  get callCount(): number {
    return this.calls.length;
  }

  private _messageTexts(roleFilter: string): string[] {
    const texts: string[] = [];
    for (const call of this.calls) {
      for (const message of call) {
        if (message["role"] !== roleFilter) continue;
        const content = message["content"];
        if (typeof content === "string") {
          texts.push(content);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            const text = (block as Record<string, unknown>)["text"];
            if (typeof text === "string") texts.push(text);
          }
        }
      }
    }
    return texts;
  }

  /** Whether any user-role message the model saw contains the needle. */
  sawUserText(needle: string): boolean {
    return this._messageTexts("user").some((text) => text.includes(needle));
  }

  /** Whether any tool_result message the model saw contains the needle. */
  sawToolResultText(needle: string): boolean {
    return this._messageTexts("tool_result").some((text) => text.includes(needle));
  }
}

/**
 * Agent-shaped object that runs the real tool loop against a scripted provider.
 * Mirrors the fields Agent.prototype.asyncRunWithMessages reads from `this`.
 */
export function makeScriptedAgentObject(
  provider: ScriptedProvider,
  opts?: { name?: string; tools?: ToolDef[]; maxToolRounds?: number },
): Record<string, unknown> {
  return {
    name: opts?.name ?? "Primary",
    description: "",
    systemPrompt: "Test agent.",
    tools: [...(opts?.tools ?? [])],
    maxToolRounds: opts?.maxToolRounds ?? 8,
    modelConfig: {
      name: "test-model",
      provider: "openai",
      model: "gpt-test",
      apiKey: "sk-test",
      maxTokens: 256,
      contextLength: 8192,
      supportsMultimodal: false,
    },
    _provider: provider,
    replaceModelConfig(next: Record<string, unknown>) {
      (this as Record<string, unknown>)["modelConfig"] = next;
    },
    asyncRunWithMessages: Agent.prototype.asyncRunWithMessages,
  };
}

export interface SessionHarness {
  session: Session;
  provider: ScriptedProvider;
  projectRoot: string;
  /** Escape hatch for staging/observing private runtime state in characterization tests. */
  internals: any;
  dispose: () => void;
}

export interface HarnessOptions {
  rounds?: ScriptedRound[];
  tools?: ToolDef[];
  toolExecutorOverrides?: Record<string, ToolExecutor>;
  maxToolRounds?: number;
}

export function makeScriptedSession(opts: HarnessOptions = {}): SessionHarness {
  const projectRoot = mkdtempSync(join(tmpdir(), "swarmflow-harness-project-"));
  const baseDir = mkdtempSync(join(tmpdir(), "swarmflow-harness-store-"));

  const provider = new ScriptedProvider();
  provider.rounds = opts.rounds ?? [];

  const primaryAgent = makeScriptedAgentObject(provider, {
    tools: opts.tools,
    maxToolRounds: opts.maxToolRounds,
  });

  const store = new SessionStore({ baseDir, projectPath: projectRoot });
  store.createSession();

  const config = {
    mcpServerConfigs: [],
    agentModels: {},
    modelTiers: {},
    subAgentInheritMcp: false,
    subAgentInheritHooks: false,
    getModel: (name: string) => ({
      name,
      provider: "openai",
      model: "gpt-test",
      apiKey: "sk-test",
      maxTokens: 256,
      contextLength: 8192,
      supportsMultimodal: false,
    }),
  };

  const session = new Session({
    primaryAgent: primaryAgent as never,
    config: config as never,
    store,
    projectRoot,
    toolExecutorOverrides: opts.toolExecutorOverrides ?? {},
  });

  return {
    session,
    provider,
    projectRoot,
    internals: session as any,
    dispose: () => {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

/**
 * Replace the session's tool preflight gate so the named tool raises an
 * approval ask exactly once. Everything else passes. Returns a holder whose
 * `.ask` is populated when the gate fires (the same object the runtime
 * stores, so its id can be used with resolveApprovalAsk).
 */
export function stageApprovalGate(
  harness: SessionHarness,
  toolName: string,
): { ask: ApprovalRequest | null } {
  const holder: { ask: ApprovalRequest | null } = { ask: null };
  let fired = false;
  harness.internals._beforeToolExecute = async (ctx: { toolName: string }) => {
    if (ctx.toolName !== toolName || fired) return undefined;
    fired = true;
    const ask: ApprovalRequest = {
      id: "approval-test-1",
      kind: "approval",
      createdAt: new Date().toISOString(),
      source: { agentId: "Primary" },
      summary: `Allow ${toolName}?`,
      roundIndex: undefined,
      payload: {
        toolCallId: "",
        toolName,
        toolSummary: `Primary is calling ${toolName}`,
        permissionClass: "write_potent",
        offers: [{ type: "tool_once", label: "Allow once" }],
      },
      options: ["Allow once", "Deny"],
    };
    holder.ask = ask;
    return { kind: "ask", ask };
  };
  return holder;
}

export async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Minimal ToolDef for tools that only need to exist in the loop's tool map. */
export function testToolDef(name: string): ToolDef {
  return {
    name,
    description: `test tool ${name}`,
    parameters: { type: "object", properties: {} },
  } as ToolDef;
}
