import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { bootstrapOpenTuiRuntime, type OpenTuiRuntime } from "../opentui-src/bootstrap.js";

const TEST_KEY_ENV = "SWARMFLOW_TEST_OPENAI_API_KEY";

let previousApiKey: string | undefined;
let tempHome: string;
let swarmflowHome: string;
let projectRoot: string;

function writeRuntimeSettings(): void {
  mkdirSync(swarmflowHome, { recursive: true });
  writeFileSync(
    join(swarmflowHome, "settings.json"),
    JSON.stringify({
      providers: {
        openai: { api_key_env: TEST_KEY_ENV },
      },
      default_model: "openai:gpt-5.4-mini",
      thinking_level: "high",
      permission_mode: "yolo",
      disabled_skills: ["explain-code"],
      theme_mode: "dark",
    }, null, 2),
  );
}

function semanticSnapshot(runtime: OpenTuiRuntime): Record<string, unknown> {
  const session = runtime.session as any;
  return {
    storeHasSessionDir: Boolean(runtime.store.sessionDir),
    commandNames: runtime.commandRegistry.getAll().map((cmd) => cmd.name).sort(),
    logTypes: session.log.map((entry: { type: string }) => entry.type),
    turnCount: session.turnCount,
    compactCount: session.compactCount,
    lastInputTokens: session.lastInputTokens,
    lastTotalTokens: session.lastTotalTokens,
    lastCacheReadTokens: session.lastCacheReadTokens,
    activeLogEntryId: session.activeLogEntryId,
    pendingInboxCount: session.pendingInboxCount,
    childSessionCount: session.getChildSessionSnapshots().length,
    permissionMode: session.permissionMode,
    thinkingLevel: session.thinkingLevel,
    currentModelConfigName: session.currentModelConfigName,
    currentModelName: session.currentModelName,
    disabledSkills: [...session.disabledSkills].sort(),
    sessionPhase: session.sessionPhase,
    lastTurnEndStatus: session.lastTurnEndStatus,
    planState: session.getPlanState(),
  };
}

describe("OpenTUI runtime bootstrap", () => {
  beforeEach(() => {
    previousApiKey = process.env[TEST_KEY_ENV];
    tempHome = mkdtempSync(join(tmpdir(), "swarmflow-runtime-home-"));
    swarmflowHome = join(tempHome, ".swarmflow");
    projectRoot = mkdtempSync(join(tmpdir(), "swarmflow-runtime-project-"));
    process.env[TEST_KEY_ENV] = "test-key";
    writeRuntimeSettings();
  });

  afterEach(() => {
    if (previousApiKey === undefined) delete process.env[TEST_KEY_ENV];
    else process.env[TEST_KEY_ENV] = previousApiKey;
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("produces a fresh-session semantic snapshot after a previous runtime was mutated", async () => {
    const bootstrapOpts = {
      configOverrides: [],
      homeDir: swarmflowHome,
      projectPath: projectRoot,
      initHighlighter: false,
    };
    const rt1 = await bootstrapOpenTuiRuntime(bootstrapOpts);
    (rt1.session as any)._turnCount = 4;
    (rt1.session as any)._compactCount = 2;
    (rt1.session as any)._lastInputTokens = 12345;
    rt1.session.appendStatusMessage("old runtime state", "test");
    await rt1.session.close();

    const rt2 = await bootstrapOpenTuiRuntime(bootstrapOpts);
    const fresh = await bootstrapOpenTuiRuntime(bootstrapOpts);
    try {
      expect(rt2.session).not.toBe(rt1.session);
      expect(rt2.store).not.toBe(rt1.store);
      expect(rt2.commandRegistry).not.toBe(rt1.commandRegistry);
      expect(semanticSnapshot(rt2)).toEqual(semanticSnapshot(fresh));
      expect(semanticSnapshot(rt2)).toMatchObject({
        storeHasSessionDir: false,
        logTypes: ["system_prompt"],
        turnCount: 0,
        compactCount: 0,
        lastInputTokens: 0,
        permissionMode: "yolo",
        disabledSkills: ["explain-code"],
      });
    } finally {
      await rt2.session.close();
      await fresh.session.close();
    }
  });
});
