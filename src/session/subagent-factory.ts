/**
 * SubAgentFactory —— 为子会话构建 Agent 实例（P2.4a）。
 *
 * 拥有模板查找（预定义 + 磁盘）、按角色模型解析、comm 工具剥离、
 * 以及子会话 system-prompt 分层。角色模型统一由 RoleModelResolver 解析。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Agent } from "../agents/agent.js";
import type { Config } from "../config/loader.js";
import type { MCPClientManager } from "../clients/mcp/manager.js";
import { SafePathError, safePath } from "../security/path.js";
import { loadTemplate, validateTemplate } from "../prompts/templates.js";
import type { PersistedRoleModelSelection, ResolvedRoleModel } from "./role-model-resolver.js";

/**
 * 子会话不允许拥有的工具（send 等由 child Session 单独管理）。
 *
 * 注意：本名单只是策略声明，不构成强制。子 Session 的构造函数会用
 * CHILD_SESSION_CAPABILITIES 调 ensureCommTools() 重新追加 comm 工具，
 * 因此名单必须与 capability 一致：await_event / kill_shell 已从名单移除，
 * 由 capability 显式授予；bash_background 仍然剥离。
 */
const COMM_TOOL_NAMES = new Set([
  "spawn", "kill_agent", "check_status", "ask", "skill",
  "bash_background", "send",
]);

export interface SubAgentFactoryDeps {
  getAgentTemplates(): Record<string, Agent>;
  getConfig(): Config;
  getMcpManager(): MCPClientManager | undefined;
  getPromptsDirs(): string[] | undefined;
  resolveSessionArtifacts(): string;
  /** 角色模型解析的统一入口。 */
  resolveRoleModel(role: string, persistedSelection?: PersistedRoleModelSelection): ResolvedRoleModel;
}

/**
 * SubAgentFactory —— 为子会话构建 Agent 实例。
 *
 * 职责：
 * - 模板查找：预定义模板（从 prompts/templates/）或磁盘模板
 * - 模型解析优先级：角色配置 > 父模型
 * - 工具约束：剥离 comm 工具、剥离不可继承的 MCP 工具
 * - System prompt 分层：模板 prompt + 模式 prompt（oneshot/persistent）
 */
export class SubAgentFactory {
  constructor(private readonly deps: SubAgentFactoryDeps) {}

  /**
   * 从预定义模板创建子 Agent。
   * 模板从 getAgentTemplates() 获取（Session 初始化时加载）。
   */
  createFromPredefined(
    templateName: string,
    taskId: string,
    persistedSelection?: PersistedRoleModelSelection,
  ): { agent: Agent; thinkingLevel?: string } {
    const templates = this.deps.getAgentTemplates();
    // 预定义模板名称就是稳定的机器 ID，大小写变体不再视为同一模板。
    const templateAgent = templates[templateName];
    if (!templateAgent) {
      const available = Object.keys(templates).sort();
      throw new Error(
        `Unknown template '${templateName}'. Available: ${available.join(", ") || "(none)"}`,
      );
    }

    const { modelConfig, thinkingLevel } = this.deps.resolveRoleModel(templateName, persistedSelection);
    const tools = [...templateAgent.tools]; // 使用模板的工具，非主 Agent 的

    const agent = new Agent({
      name: taskId,
      modelConfig,
      // 传递原始模板 prompt——子 Session 在自身组装期间分层 memory、mode
      // prompt 和路径变量。
      systemPrompt: templateAgent.systemPrompt,
      tools,
      maxToolRounds: templateAgent.maxToolRounds,
      description: `Sub-agent '${taskId}' (${templateName})`,
    });
    this._applySubAgentConstraints(agent);
    return { agent, thinkingLevel };
  }

  /**
   * 从磁盘模板路径创建子 Agent。
   * 模板路径必须位于 SESSION_ARTIFACTS 内（安全约束）。
   */
  createFromPath(
    templateDir: string,
    taskId: string,
    persistedSelection?: PersistedRoleModelSelection,
  ): { agent: Agent; thinkingLevel?: string } {
    const templateAgent = loadTemplate(
      templateDir,
      this.deps.getConfig(),
      taskId,
      this.deps.getMcpManager(),
      this.deps.getPromptsDirs(),
    );
    const { modelConfig, thinkingLevel } = this.deps.resolveRoleModel(templateAgent.name, persistedSelection);

    const agent = new Agent({
      name: taskId,
      modelConfig,
      systemPrompt: templateAgent.systemPrompt,
      tools: [...templateAgent.tools],
      maxToolRounds: templateAgent.maxToolRounds,
      description: `Sub-agent '${taskId}' (custom)`,
    });
    this._applySubAgentConstraints(agent);
    return { agent, thinkingLevel };
  }

  /**
   * 解析并验证模板路径（必须在 SESSION_ARTIFACTS 内）。
   * 执行符号链接安全检查，防止通过 symlink 逃逸。
   */
  resolveTemplatePath(relPath: string): string {
    const artifactsDir = this.deps.resolveSessionArtifacts();
    let absPath: string;
    try {
      absPath = safePath({
        baseDir: artifactsDir,
        requestedPath: relPath,
        cwd: artifactsDir,
        mustExist: true,
        expectDirectory: true,
        accessKind: "template",
      }).safePath!;
    } catch (e) {
      if (e instanceof SafePathError) {
        if (e.code === "PATH_OUTSIDE_SCOPE") {
          throw new Error("Template path must be within SESSION_ARTIFACTS");
        }
        if (e.code === "PATH_SYMLINK_ESCAPES_SCOPE") {
          throw new Error("Template path escapes SESSION_ARTIFACTS via a symbolic link");
        }
        throw new Error(e.message);
      }
      throw e;
    }

    const validationError = validateTemplate(absPath);
    if (validationError) {
      throw new Error(`Template validation failed: ${validationError}`);
    }

    return absPath;
  }

  /**
   * 构建子会话的完整 system prompt，分层：
   * 1. 模板 system prompt
   * 2. 模式特定 prompt（oneshot.md / persistent.md）
   */
  buildSubAgentSystemPrompt(basePrompt: string, persistent: boolean): string {
    const parts = [basePrompt];

    try {
      const modeFile = persistent ? "persistent.md" : "oneshot.md";
      const modePrompt = this._readPromptFile(`subagent/${modeFile}`);
      if (modePrompt) parts.push(modePrompt);
    } catch { /* optional */ }

    return parts.join("\n\n");
  }

  /** 应用子会话约束：剥离 comm 工具和不可继承的 MCP 工具。 */
  private _applySubAgentConstraints(agent: Agent): void {
    // 剥离 comm 工具——send 等由 child Session 单独管理
    agent.tools = agent.tools.filter((t) => !COMM_TOOL_NAMES.has(t.name));
    // 当子代理继承 MCP 被禁用时剥离 MCP 工具。
    // 父 Session 的 _ensureMcp 将 MCP 工具附加到模板 Agent；
    // 子会话中没有执行器，模型会看到它们但调用失败。
    if (!this.deps.getConfig().subAgentInheritMcp) {
      agent.tools = agent.tools.filter((t) => !t.name.startsWith("mcp__"));
    }
    // 生命周期特定约束通过 buildSubAgentSystemPrompt 注入，
    // 不在此处——以避免 one-shot 语言泄漏到交互式 Agent。
  }

  /** 从 promptsDirs 读取提示文件（可选）。 */
  private _readPromptFile(relativePath: string): string {
    const promptsDirs = this.deps.getPromptsDirs();
    if (promptsDirs) {
      for (const dir of promptsDirs) {
        const fullPath = join(dir, relativePath);
        try {
          return readFileSync(fullPath, "utf-8").trim();
        } catch { /* try next */ }
      }
    }
    return "";
  }
}
