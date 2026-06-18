import { homedir } from "node:os";
import { join } from "node:path";

export const SWARMFLOW_HOME_DIR = ".swarmflow";

export function getSwarmflowHomeDir(): string {
  return join(homedir(), SWARMFLOW_HOME_DIR);
}
