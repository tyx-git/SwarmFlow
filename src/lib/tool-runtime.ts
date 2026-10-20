/**
 * ToolRuntime —— 三层工具执行管道。
 *
 * 分离了之前在 Session 中交错的三个关注点：
 *
 *   Catalog  ——模型看到哪些工具？
 *   Gate     ——这个特定调用能否执行？（权限钩子）
 *   Executor ——实际的工具实现
 *
 * Session 创建 ToolRuntime 并将工具管理委托给它。
 * Gate 层是未来权限系统的插入点。
 */

import type { ToolDef } from "../providers/base.js";
import { TASK_CONTROL_TOOLS, TASK_TOOLS } from "../tools/tasks.js";
import type { ToolExecutor } from "../tools/executor-types.js";
import type { ToolPreflightContext, ToolPreflightDecision } from "../agents/tool-loop.js";
import type { ApprovalOffer, InvocationAssessment } from "../permissions/types.js";
import {
  SPAWN_TOOL,
  KILL_AGENT_TOOL,
  CHECK_STATUS_TOOL,
  AWAIT_EVENT_TOOL,
  ASK_TOOL,
} from "../tools/comm.js";
import {
  executeTool,
  KILL_SHELL_TOOL,
  type AdoptShellFn,
} from "../tools/basic.js";
import type { SessionCapabilities } from "../session-capabilities.js";
import type { MCPClientManager } from "../clients/mcp-client.js";
import { setArgRepairSink } from "../tools/arg-repair.js";

// 一次性连接工具输入修复遥测。通过环境变量控制，默认静默；
// 启用后可观察各 (tool,key) 的修复形态——这是模型在特定工具契约上
// 发生漂移的领先指标。
if (process.env.SWARMFLOW_TOOL_REPAIR_DEBUG === "1") {
  setArgRepairSink(({ tool, key, kind }) => {
    console.error(`tool_input_repaired:${tool} key=${key} kind=${kind}`);
  });
}
import type { Agent } from "../agents/agent.js";

// ------------------------------------------------------------------
// 门控类型定义
// ------------------------------------------------------------------

export type GateDecision =
  | { kind: "allow" }
  | { kind: "deny"; message: string }
  | { kind: "ask"; question: string; toolCallId: string; offers: ApprovalOffer[]; assessment: InvocationAssessment };

export interface GateAdvisor {
  evaluate(ctx: ToolPreflightContext): GateDecision | Promise<GateDecision>;
}

// ------------------------------------------------------------------
// Catalog ——模型看到哪些工具
// ------------------------------------------------------------------

/**
 * 构建固定的 skill 元工具定义。
 *
 * skills 目录存放于 system prompt，而不是工具描述中：工具 schema 必须在
 * 安装/删除 skill 时保持字节稳定，否则整个 tools 前缀的提示缓存都会失效。
 */
export function buildSkillToolDef(): ToolDef {
  return {
    name: "skill",
    description:
      "Invoke a skill by name. The skill's full instructions are returned for you to follow.\n\n" +
      "The skills currently available to you, if any, are listed in the system prompt under " +
      "\"Available Skills\".",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The skill name to invoke.",
        },
        arguments: {
          type: "string",
          description:
            "Arguments to pass to the skill (e.g. file path, module name). " +
            "Referenced via $ARGUMENTS in the skill instructions.",
        },
      },
      required: ["name"],
    },
    summaryTemplate: "{agent} is invoking skill {name}",
    tuiPolicy: { partialReveal: { completeArgs: ["name"] } },
  };
}

/**
 * 根据能力配置确保通信工具存在于工具数组中。
 * 就地修改传入的数组。
 */
export function ensureCommTools(
  tools: ToolDef[],
  capabilities: SessionCapabilities,
): void {
  const existing = new Set(tools.map((t) => t.name));
  const wanted: ToolDef[] = [];
  if (capabilities.includeSpawnTool) wanted.push(SPAWN_TOOL);
  if (capabilities.includeKillTool) wanted.push(KILL_AGENT_TOOL);
  if (capabilities.includeCheckStatusTool) wanted.push(CHECK_STATUS_TOOL);
  if (capabilities.includeAwaitEventTool) wanted.push(AWAIT_EVENT_TOOL);
  if (capabilities.includeKillShellTool) wanted.push(KILL_SHELL_TOOL);
  if (capabilities.includeAskTool) wanted.push(ASK_TOOL);
  // 注意：没有 reload 分支。重新加载是用户显式命令（/reload），
  // 模型链路已被移除；reloadConfigurationFromCommand() 不经过此处。
  for (const toolDef of wanted) {
    if (!existing.has(toolDef.name)) {
      tools.push(toolDef);
    }
  }
}

/**
 * 按能力确保任务工具存在于工具数组中。
 *
 * 必须在子会话约束（subagent-factory 的 COMM_TOOL_NAMES 剥离）**之后**调用：
 * 子 Session 的构造函数会按 CHILD_SESSION_CAPABILITIES 重新追加。剥离名单与
 * capability 必须保持一致：名单里保留的工具要真正消失，capability 就必须为
 * false；反之，需要授予子会话的工具应从名单移除。
 *
 * 就地修改传入的数组。
 */
export function ensureTaskTools(
  tools: ToolDef[],
  capabilities: SessionCapabilities,
): void {
  const existing = new Set(tools.map((t) => t.name));
  const wanted: ToolDef[] = [];
  if (capabilities.includeTaskTools) wanted.push(...TASK_TOOLS);
  if (capabilities.includeTaskControl) wanted.push(...TASK_CONTROL_TOOLS);
  for (const toolDef of wanted) {
    if (!existing.has(toolDef.name)) {
      tools.push(toolDef);
    }
  }
}

/**
 * 根据能力确保固定的 skill 工具存在/缺失。
 * 就地修改传入数组（filter+push 模式需要重新赋值）。
 * 返回新的工具数组。
 */
export function ensureSkillTool(
  tools: ToolDef[],
  capabilities: SessionCapabilities,
): ToolDef[] {
  if (!capabilities.includeSkillTools) {
    return tools.filter((t) => t.name !== "skill");
  }
  const filtered = tools.filter((t) => t.name !== "skill");
  filtered.push(buildSkillToolDef());
  return filtered;
}

// ------------------------------------------------------------------
// 执行器构建器 ——构建 name→executor 字典
// ------------------------------------------------------------------

export interface ExecutorDeps {
  projectRoot: string;
  getSessionArtifactsDir: () => string;
  supportsMultimodal: boolean;
  /* 会话拥有的通信工具执行器（execAsk， execSpawn等） */
  commExecutors: Record<string, ToolExecutor>;
  /* 会话拥有的任务清单执行器（task_create / task_list / task_get / task_update / task_resume） */
  taskExecutors?: Record<string, ToolExecutor>;
  /* 额外的覆盖（例如，从构造函数选项） */
  overrides?: Record<string, ToolExecutor>;
  /* 在文件写入后调用（例如用于自定义写入后的副作用）。 */
  onFileWrite?: (filePath: string) => void;
  /* 从权限规则中获取已批准的外部路径前缀的动态getter。 */
  getApprovedExternalPrefixes?: () => string[];
  /* 将超时的同步bash进程移交给后台shell管理器。 */
  adoptShell?: AdoptShellFn;
  /* 本会话是否拥有某个工具；用于让提示文案匹配真实能力。 */
  hasTools?: (name: string) => boolean;
}

export function buildToolExecutors(deps: ExecutorDeps): Record<string, ToolExecutor> {
  const {
    projectRoot,
    getSessionArtifactsDir,
    supportsMultimodal,
    commExecutors,
    taskExecutors = {},
    overrides = {},
    onFileWrite,
    getApprovedExternalPrefixes,
    adoptShell,
    hasTools,
  } = deps;

  const scopedBuiltin = (toolName: string): ToolExecutor =>
    (args, rtCtx) => executeTool(toolName, args, {
      projectRoot,
      externalPathAllowlist: [
        getSessionArtifactsDir(),
        ...(getApprovedExternalPrefixes?.() ?? []),
      ],
      sessionArtifactsDir: getSessionArtifactsDir(),
      supportsMultimodal,
      signal: rtCtx?.signal,
      adoptShell,
      hasTools,
    });

  const writeFileWithReload: ToolExecutor = (args, rtCtx) => {
    const result = scopedBuiltin("write_file")(args, rtCtx);
    const filePath = String((args as Record<string, unknown>)["path"] ?? "");
    if (filePath && onFileWrite) {
      onFileWrite(filePath);
    }
    return result;
  };

  return {
    read_file: scopedBuiltin("read_file"),
    list_dir: scopedBuiltin("list_dir"),
    glob: scopedBuiltin("glob"),
    grep: scopedBuiltin("grep"),
    find_symbol: scopedBuiltin("find_symbol"),
    jq: scopedBuiltin("jq"),
    edit_file: scopedBuiltin("edit_file"),
    write_file: writeFileWithReload,
    web_search: (args, rtCtx) => executeTool("web_search", args, { signal: rtCtx?.signal }),
    web_fetch: (args, rtCtx) => executeTool("web_fetch", args, { signal: rtCtx?.signal }),
    bash: (args, rtCtx) => executeTool("bash", args, {
      projectRoot,
      externalPathAllowlist: [
        getSessionArtifactsDir(),
        ...(getApprovedExternalPrefixes?.() ?? []),
      ],
      sessionArtifactsDir: getSessionArtifactsDir(),
      supportsMultimodal,
      signal: rtCtx?.signal,
      // 超时移交需要这两项：缺了 adoptShell，超时命令会被直接杀掉，
      // 与 bash 工具描述承诺的「转后台 shell」不符。
      adoptShell,
      hasTools,
    }),
    ...commExecutors,
    ...taskExecutors,
    ...overrides,
  };
}

// ------------------------------------------------------------------
// MCP 工具注册
// ------------------------------------------------------------------

const MCP_TOOL_PREFIX = "mcp__";

function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

function selectMcpToolsForAgent(
  spec: unknown,
  mcpTools: ToolDef[],
): ToolDef[] {
  if (!spec || spec === "none") return [];

  if (spec === "all") {
    return mcpTools;
  }

  if (Array.isArray(spec)) {
    const prefixes = (spec as string[]).map((s) => `mcp__${s}__`);
    return mcpTools.filter((t) =>
      prefixes.some((p) => t.name.startsWith(p)),
    );
  }

  return [];
}

export async function registerMcpTools(
  mcpManager: MCPClientManager,
  executors: Record<string, ToolExecutor>,
  agents: Agent[],
): Promise<boolean> {
  try {
    await mcpManager.connectAll();
    const mcpTools = mcpManager.getAllTools();
    const activeMcpToolNames = new Set(mcpTools.map((t) => t.name));

    for (const name of Object.keys(executors)) {
      if (isMcpToolName(name) && !activeMcpToolNames.has(name)) {
        delete executors[name];
      }
    }

    for (const tool of mcpTools) {
      if (tool.name in executors) continue;
      const capturedName = tool.name;
      executors[capturedName] = async (args: Record<string, unknown>) => {
        return mcpManager.callTool(capturedName, args);
      };
    }

    const seenAgents = new Set<Agent>();
    for (const agent of agents) {
      if (seenAgents.has(agent)) continue;
      seenAgents.add(agent);

      const spec = (agent as any)._mcpToolsSpec;
      const selectedTools = selectMcpToolsForAgent(spec, mcpTools);
      const selectedToolNames = new Set(selectedTools.map((t) => t.name));
      const selectedToolsByName = new Map(selectedTools.map((t) => [t.name, t]));

      agent.tools = agent.tools
        .filter((t) => !isMcpToolName(t.name) || selectedToolNames.has(t.name))
        .map((t) => isMcpToolName(t.name) ? selectedToolsByName.get(t.name) ?? t : t);

      if (!selectedTools.length) continue;

      const existingToolNames = new Set(agent.tools.map((t) => t.name));
      const newTools = selectedTools.filter((t) => !existingToolNames.has(t.name));
      if (!newTools.length) continue;

      // 在 "skill" 工具之前插入 MCP 工具（若存在），这样
      // _ensureSkillTool 的 filter-push-to-end 模式不会在后续回合
      // 重新排列数组——否则会破坏提示缓存。
      const skillIdx = agent.tools.findIndex((t) => t.name === "skill");
      if (skillIdx >= 0) {
        agent.tools.splice(skillIdx, 0, ...newTools);
      } else {
        agent.tools.push(...newTools);
      }
    }

    return mcpTools.length > 0;
  } catch (e) {
    console.error("Failed to connect MCP servers:", e);
    return false;
  }
}

// ------------------------------------------------------------------
// Gate ——权限检查管道
// ------------------------------------------------------------------

export class ToolGate {
  private _advisors: GateAdvisor[] = [];

  addAdvisor(advisor: GateAdvisor): void {
    this._advisors.push(advisor);
  }

  removeAdvisor(advisor: GateAdvisor): void {
    const idx = this._advisors.indexOf(advisor);
    if (idx >= 0) this._advisors.splice(idx, 1);
  }

  /**
   * 根据所有顾问评估工具调用。
   * 首个 deny 或 ask 胜出。若全部 allow（或无顾问），则 allow。
   */
  async evaluate(ctx: ToolPreflightContext): Promise<GateDecision> {
    for (const advisor of this._advisors) {
      const decision = await advisor.evaluate(ctx);
      if (decision.kind !== "allow") return decision;
    }
    return { kind: "allow" };
  }

  /**
   * 创建与 tool-loop.ts 兼容的 BeforeToolExecuteCallback。
   * 不直接使用 —— Session 用额外逻辑包装此方法
   * （产出目录旁路、钩子、ApprovalRequest 构造）。
   * 保留作为 Gate→ToolPreflight 桥接的参考实现。
   */
  asBeforeToolExecute(): (ctx: ToolPreflightContext) => Promise<ToolPreflightDecision | void> {
    return async (ctx: ToolPreflightContext): Promise<ToolPreflightDecision | void> => {
      const decision = await this.evaluate(ctx);
      switch (decision.kind) {
        case "allow":
          return undefined;
        case "deny":
          return { kind: "deny", message: decision.message };
        case "ask":
          // Callers that need the full ask flow should use evaluate() directly
          // and construct the ApprovalRequest themselves.
          return undefined;
      }
    };
  }
}
