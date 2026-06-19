/**
 * SubAgentFactory —— 为子会话构建 Agent 实例（P2.4a）。
 *
 * 拥有模板查找（预定义 + 磁盘）、模型解析
 *（agent_models pin > model_level tier > 父模型）、comm 工具剥离、
 * 以及子会话 system-prompt 分层。模型条目解析和状态回退
 * 通过 deps 闭包回调 Session。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Agent } from "../agents/agent.js";
import type { Config, ModelConfig } from "../config/config.js";
import type { MCPClientManager } from "../clients/mcp-client.js";
import type { AgentModelEntry, ModelTierEntry } from "../config/persistence.js";
import { SafePathError, safePath } from "../security/path.js";
import { loadTemplate, validateTemplate } from "../templates/loader.js";

/** 子会话不允许拥有的工具（send 等由 child Session 单独管理）。 */
const COMM_TOOL_NAMES = new Set([
  "spawn", "kill_agent", "check_status", "await_event", "show_context", "summarize_context", "ask", "skill",
  "bash_background", "bash_output", "kill_shell", "send",
]);

export interface ResolvedSubAgentModel {
  modelConfig: ModelConfig;
  thinkingLevel?: string;
}

export interface SubAgentFactoryDeps {
  getAgentTemplates(): Record<string, Agent>;
  getConfig(): Config;
  getMcpManager(): MCPClientManager | undefined;
  getPromptsDirs(): string[] | undefined;
  resolveSessionArtifacts(): string;
  getParentModelConfig(): ModelConfig;
  /** 包装 resolveAgentModelEntry(session, entry)。 */
  resolvePinnedModel(entry: AgentModelEntry): ResolvedSubAgentModel;
  /** 包装 resolveModelTierEntry(session, tier)。 */
  resolveTierModel(tier: ModelTierEntry): ResolvedSubAgentModel;
  /** 追加状态条目到会话日志（模型回退通知）。 */
  appendStatus(message: string, statusType: string): void;
}

/**
 * SubAgentFactory —— 为子会话构建 Agent 实例。
 *
 * 职责：
 * - 模板查找：预定义模板（从 prompts/templates/）或磁盘模板
 * - 模型解析优先级：agent_models pin > model_level tier > 父模型
 * - 工具约束：剥离 comm 工具、剥离不可继承的 MCP 工具
 * - System prompt 分层：模板 prompt + 模式 prompt（oneshot/persistent）
 */
export class SubAgentFactory {
  constructor(private readonly deps: SubAgentFactoryDeps) {}

  /**
   * 从预定义模板创建子 Agent。
   * 模板从 getAgentTemplates() 获取（Session 初始化时加载）。
   */
  createFromPredefined(templateName: string, taskId: string, modelLevel?: string): { agent: Agent; thinkingLevel?: string } {
    const templates = this.deps.getAgentTemplates();
    // 优先精确匹配，再大小写不敏感回退
    let templateAgent = templates[templateName];
    if (!templateAgent) {
      const lower = templateName.toLowerCase();
      for (const [key, agent] of Object.entries(templates)) {
        if (key.toLowerCase() === lower) {
          templateAgent = agent;
          break;
        }
      }
    }
    if (!templateAgent) {
      const available = Object.keys(templates).sort();
      throw new Error(
        `Unknown template '${templateName}'. Available: ${available.join(", ") || "(none)"}`,
      );
    }

    const { modelConfig, thinkingLevel } = this._resolveSubAgentModel(templateName, modelLevel);
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
  createFromPath(templateDir: string, taskId: string, modelLevel?: string): { agent: Agent; thinkingLevel?: string } {
    const templateAgent = loadTemplate(
      templateDir,
      this.deps.getConfig(),
      taskId,
      this.deps.getMcpManager(),
      this.deps.getPromptsDirs(),
    );
    const { modelConfig, thinkingLevel } = this._getSubAgentModelConfig(modelLevel);

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

  /**
   * 解析预定义子 Agent 模板的模型。
   * 优先级：agent_models pin > model_level tier > 父模型。
   */
  private _resolveSubAgentModel(templateName: string, modelLevel?: string): ResolvedSubAgentModel {
    // 优先级 1：agent_models[templateName]——静默忽略 model_level
    try {
      const pinnedEntry = this.deps.getConfig().agentModels[templateName];
      if (pinnedEntry) {
        return this.deps.resolvePinnedModel(pinnedEntry);
      }
    } catch (err) {
      // pinned 模型配置但不可用——回退到父模型
      const msg = `Pinned model for '${templateName}' unavailable: ${err instanceof Error ? err.message : String(err)}. Using parent model.`;
      this.deps.appendStatus(msg, "agent_model_fallback");
      return { modelConfig: this.deps.getParentModelConfig() };
    }

    // 优先级 2+3：tier 或父模型
    return this._getSubAgentModelConfig(modelLevel);
  }

  /** 根据 modelLevel tier 解析模型配置。 */
  private _getSubAgentModelConfig(modelLevel?: string): ResolvedSubAgentModel {
    if (modelLevel && (modelLevel === "high" || modelLevel === "medium" || modelLevel === "low")) {
      try {
        const tier = this.deps.getConfig().modelTiers[modelLevel];
        if (!tier) {
          throw new Error(`Model tier '${modelLevel}' is not configured.`);
        }
        return this.deps.resolveTierModel(tier);
      } catch (err) {
        const msg = `Sub-agent requested model tier '${modelLevel}' but it failed: ${err instanceof Error ? err.message : String(err)}. Falling back to current model.`;
        this.deps.appendStatus(msg, "tier_fallback");
        return { modelConfig: this.deps.getParentModelConfig() };
      }
    }
    return { modelConfig: this.deps.getParentModelConfig() };
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
