/**
 * SwarmFlow 主目录路径工具。
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const SWARMFLOW_HOME_DIR = ".swarmflow";

/** 获取 SwarmFlow 主目录路径（~/.swarmflow） */
export function getSwarmflowHomeDir(): string {
  return join(homedir(), SWARMFLOW_HOME_DIR);
}
