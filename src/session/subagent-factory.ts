/**
 * SubAgentFactory 鈥?builds Agent instances for child sessions (P2.4a).
 *
 * Owns template lookup (predefined + on-disk), model resolution
 * (agent_models pin > model_level tier > parent model), comm-tool stripping,
 * and the child system-prompt layering. Model-entry resolution and status
 * fallback entries reach back into Session through the deps closures.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Agent } from "../agents/agent.js";
import type { Config, ModelConfig } from "../config/config.js";
import type { MCPClientManager } from "../clients/mcp-client.js";
import type { AgentModelEntry, ModelTierEntry } from "../config/persistence.js";
import { SafePathError, safePath } from "../security/path.js";
import { loadTemplate, validateTemplate } from "../templates/loader.js";

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
  /** Wraps resolveAgentModelEntry(session, entry). */
  resolvePinnedModel(entry: AgentModelEntry): ResolvedSubAgentModel;
  /** Wraps resolveModelTierEntry(session, tier). */
  resolveTierModel(tier: ModelTierEntry): ResolvedSubAgentModel;
  /** Append a status entry to the session log (model fallback notices). */
  appendStatus(message: string, statusType: string): void;
}

export class SubAgentFactory {
  constructor(private readonly deps: SubAgentFactoryDeps) {}

  createFromPredefined(templateName: string, taskId: string, modelLevel?: string): { agent: Agent; thinkingLevel?: string } {
    const templates = this.deps.getAgentTemplates();
    // Try exact match first, then case-insensitive fallback
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
    const tools = [...templateAgent.tools]; // Use template's tools, not primary agent's

    const agent = new Agent({
      name: taskId,
      modelConfig,
      // Pass the raw template prompt 鈥?the child Session layers memory, mode
      // prompt, and path variables itself during its own assembly.
      systemPrompt: templateAgent.systemPrompt,
      tools,
      maxToolRounds: templateAgent.maxToolRounds,
      description: `Sub-agent '${taskId}' (${templateName})`,
    });
    this._applySubAgentConstraints(agent);
    return { agent, thinkingLevel };
  }

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
      // Pass the raw template prompt 鈥?the child Session layers memory, mode
      // prompt, and path variables itself during its own assembly.
      systemPrompt: templateAgent.systemPrompt,
      tools: [...templateAgent.tools],
      maxToolRounds: templateAgent.maxToolRounds,
      description: `Sub-agent '${taskId}' (custom)`,
    });
    this._applySubAgentConstraints(agent);
    return { agent, thinkingLevel };
  }

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
   * Build a child session's full system prompt by layering:
   * 1. Template system prompt
   * 2. Mode-specific prompt
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

  private _applySubAgentConstraints(agent: Agent): void {
    // Strip comm tools 鈥?send is re-added later for interactive/team agents
    agent.tools = agent.tools.filter((t) => !COMM_TOOL_NAMES.has(t.name));
    // Strip MCP tools when sub-agent inheritance is disabled. Parent's _ensureMcp
    // attached MCP tool defs to template agents; without an executor in the child
    // session the model would see them and fail on call.
    if (!this.deps.getConfig().subAgentInheritMcp) {
      agent.tools = agent.tools.filter((t) => !t.name.startsWith("mcp__"));
    }
    // Lifecycle-specific constraints are injected via buildSubAgentSystemPrompt,
    // not here 鈥?to avoid one-shot language leaking into interactive agents.
  }

  /**
   * Resolve model for a predefined sub-agent template.
   * Priority: agent_models pin > model_level tier > parent model.
   */
  private _resolveSubAgentModel(templateName: string, modelLevel?: string): ResolvedSubAgentModel {
    // Priority 1: agent_models[templateName] 鈥?silently ignores model_level
    try {
      const pinnedEntry = this.deps.getConfig().agentModels[templateName];
      if (pinnedEntry) {
        return this.deps.resolvePinnedModel(pinnedEntry);
      }
    } catch (err) {
      // Pinned model configured but unavailable 鈥?fallback to parent model
      const msg = `Pinned model for '${templateName}' unavailable: ${err instanceof Error ? err.message : String(err)}. Using parent model.`;
      this.deps.appendStatus(msg, "agent_model_fallback");
      return { modelConfig: this.deps.getParentModelConfig() };
    }

    // Priority 2+3: tier or parent model
    return this._getSubAgentModelConfig(modelLevel);
  }

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
