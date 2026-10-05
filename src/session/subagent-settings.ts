import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

import { isAgentRoleId, type AgentRole } from "../swarm/types.js";

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
