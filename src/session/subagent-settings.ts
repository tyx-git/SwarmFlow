/**
 * 内置角色名册与按角色保存的模型配置。
 *
 * 名册就是 `prompts/templates/` 下的四个内置模板：Queen 统筹并自己汇总分支结果，
 * Scout 用 bash 取证但不写，Worker 是唯一有写权限的角色，Reviewer 用全新上下文
 * 对一份改动做对抗复核兼安全面裁决。曾经还有 Guard（与 Reviewer 同一份工具面、
 * 检查项已被 Reviewer 覆盖）与 Merger（无独立能力，输入靠未接线的 DAG 层注入），
 * 两者已删除。这里同时是配置读写方，所以角色校验与配置文件共用一份权威名册。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

/** 内置 Agent 角色。 */
export enum AgentRole {
  /** 编排者 — 持有用户目标、根任务图与验收权。仅一个活动实例。 */
  Queen = "queen",
  /** 只读取证者 — 有 bash（命令与联网取证），无写权限。 */
  Scout = "scout",
  /** 实现者 — 唯一持有 `edit`，并跑自己这次的验证。 */
  Worker = "worker",
  /** 独立复核者 — 全新上下文复核一份改动，兼管安全面。 */
  Reviewer = "reviewer",
}

export const AGENT_ROLE_IDS: readonly AgentRole[] = Object.values(AgentRole) as AgentRole[];

export function isAgentRoleId(value: string): value is AgentRole {
  return AGENT_ROLE_IDS.includes(value as AgentRole);
}

/** 每个角色的人类可读标签。 */
export const AGENT_ROLE_LABELS: Record<AgentRole, string> = {
  [AgentRole.Queen]: "Queen",
  [AgentRole.Scout]: "Scout",
  [AgentRole.Worker]: "Worker",
  [AgentRole.Reviewer]: "Reviewer",
};

/** 将角色 ID转换为界面显示名称；自定义模板保持原名。 */
export function getAgentRoleLabel(role: string): string {
  return AGENT_ROLE_LABELS[role as AgentRole] ?? role;
}

/** 单个角色的模型与思考深度配置。 */
export interface SubagentRoleSettings {
  config_name: string;
  provider: string;
  selection_key: string;
  model_id: string;
  thinking_level: string;
}

/** 当前版本的子代理角色配置文件。 */
export interface SubagentSettings {
  version: 1;
  roles: Partial<Record<AgentRole, SubagentRoleSettings>>;
}

export class SubagentSettingsLoadError extends Error {
  constructor(path: string, detail: string) {
    super(`Cannot restore sub-agent role settings from '${path}': ${detail}`);
    this.name = "SubagentSettingsLoadError";
  }
}

/** 项目目录下当前会话的子代理配置路径。 */
export function subagentSettingsPath(projectRoot: string, sessionDir: string): string {
  return join(projectRoot, ".swarmflow", basename(sessionDir), "agents", "subagent.json");
}

function isRoleSettings(value: unknown): value is SubagentRoleSettings {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  return ["config_name", "provider", "selection_key", "model_id", "thinking_level"]
    .every((key) => typeof raw[key] === "string" && (raw[key] as string).trim().length > 0);
}

export function loadSubagentSettings(path: string): SubagentSettings | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SubagentSettingsLoadError(path, error instanceof Error ? error.message : String(error));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SubagentSettingsLoadError(path, `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SubagentSettingsLoadError(path, "the document must be an object");
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.version !== 1 || !raw.roles || typeof raw.roles !== "object" || Array.isArray(raw.roles)) {
    throw new SubagentSettingsLoadError(path, "expected version 1 with a roles object");
  }
  const roles: Partial<Record<AgentRole, SubagentRoleSettings>> = {};
  for (const [role, value] of Object.entries(raw.roles as Record<string, unknown>)) {
    if (!isAgentRoleId(role) || !isRoleSettings(value)) {
      throw new SubagentSettingsLoadError(path, `invalid settings for role '${role}'`);
    }
    roles[role] = { ...(value as SubagentRoleSettings) };
  }
  return { version: 1, roles };
}

/** 原子写入，避免 TUI 进程中断时留下半份配置。 */
export function saveSubagentSettings(path: string, value: SubagentSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tempPath, path);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Keep the original write error.
    }
    throw error;
  }
}
