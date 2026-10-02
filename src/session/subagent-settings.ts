import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** /agents 写入的子代理默认模型配置。 */
export interface SubagentDefaultModel {
  config_name: string;
  provider: string;
  selection_key: string;
  model_id: string;
  thinking_level: string;
}

/** 项目目录下当前会话的子代理配置路径。 */
export function subagentSettingsPath(projectRoot: string, sessionDir: string): string {
  return join(projectRoot, ".swarmflow", basename(sessionDir), "agents", "subagent.json");
}

export function loadSubagentDefaultModel(path: string): SubagentDefaultModel | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SubagentDefaultModel>;
    if (
      typeof raw.config_name !== "string" || !raw.config_name.trim()
      || typeof raw.provider !== "string" || !raw.provider.trim()
      || typeof raw.selection_key !== "string" || !raw.selection_key.trim()
      || typeof raw.model_id !== "string" || !raw.model_id.trim()
      || typeof raw.thinking_level !== "string" || !raw.thinking_level.trim()
    ) {
      return undefined;
    }
    return {
      config_name: raw.config_name,
      provider: raw.provider,
      selection_key: raw.selection_key,
      model_id: raw.model_id,
      thinking_level: raw.thinking_level,
    };
  } catch {
    return undefined;
  }
}

/** 原子写入，避免 TUI 进程中断时留下半份配置。 */
export function saveSubagentDefaultModel(path: string, value: SubagentDefaultModel): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
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
