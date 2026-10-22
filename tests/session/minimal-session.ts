import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../../src/config/session-store.js";
import { Session } from "../../src/session.js";

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function makeSession(projectRoot: string): Session {
  const primaryAgent = {
    name: "Primary",
    systemPrompt: "You are a test agent.",
    tools: [],
    modelConfig: {
      model: "test-model",
      contextLength: 8192,
      supportsMultimodal: false,
    },
  } as any;

  const store = new SessionStore({ baseDir: projectRoot, projectPath: projectRoot });
  store.createSession();
  const config = {
    mcpServerConfigs: [],
    getModel: () => ({ model: "test" }),
  } as any;

  return new Session({
    primaryAgent,
    config,
    store,
  });
}
