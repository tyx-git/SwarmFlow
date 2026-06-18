import { describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { buildDefaultRegistry, type CommandContext } from "../src/commands.js";
import { Session } from "../src/session.js";
import {
  createSystemPrompt,
  createTurnStart,
  createUserMessage,
  createAssistantText,
} from "../src/log-entry.js";
import { SessionStore, saveLog, createLogSessionMeta } from "../src/persistence.js";

function buildSession(projectRoot: string, store: SessionStore): Session {
  const modelConfig = {
    name: "test-model",
    provider: "openai",
    model: "gpt-5.4",
    apiKey: "sk-test",
    maxTokens: 1024,
    contextLength: 128000,
    supportsMultimodal: false,
  };
  const primaryAgent = {
    name: "Primary",
    systemPrompt: "ROOT={PROJECT_ROOT}",
    tools: [],
    modelConfig: { ...modelConfig },
    _provider: { budgetCalcMode: "full_context" },
    replaceModelConfig(next: any) { this.modelConfig = next; },
  } as any;
  const config = {
    pathOverrides: { projectRoot },
    subAgentModelName: undefined,
    agentModels: {},
    modelTiers: {},
    mcpServerConfigs: [],
    getModel: () => ({ ...modelConfig }),
    listModelEntries: () => [],
    upsertModelRaw: () => {},
    get modelNames() { return ["test-model"]; },
  } as any;
  return new Session({ primaryAgent, config, agentTemplates: {}, store });
}

function buildCtx(opts: {
  session: Session;
  store: SessionStore;
  showMessage: ReturnType<typeof mock>;
  showHint: ReturnType<typeof mock>;
}): CommandContext {
  return {
    session: opts.session,
    store: opts.store,
    showMessage: opts.showMessage,
    showHint: opts.showHint,
    autoSave: () => {
      const data = opts.session.getLogForPersistence();
      if (data.meta.turnCount > 0 && opts.store.sessionDir) {
        saveLog(opts.store.sessionDir, data.meta, [...data.entries]);
      }
    },
    resetUiState: () => {},
    commandRegistry: buildDefaultRegistry(),
  };
}

describe("/fork", () => {
  it("clones the session into a new UUID dir, switches to it, and adds an ephemeral hint", async () => {
    const tmpDir = join(tmpdir(), `la-fork-test-${randomBytes(4).toString("hex")}`);
    const projectRoot = join(tmpDir, "project");
    mkdirSync(projectRoot, { recursive: true });

    const store = new SessionStore({ baseDir: tmpDir, projectPath: projectRoot });
    const sessionDir = store.createSession();
    const origSessionId = sessionDir.split("/").pop()!;

    // Seed a non-empty log so /fork accepts the session.
    const entries = [
      createSystemPrompt("sys-001", 0, "You are helpful"),
      createTurnStart("ts-001", 1),
      createUserMessage("user-001", 1, "hi", "hi", { contextId: "c1" }),
      createAssistantText("asst-001", 1, 0, "hello!", "hello!"),
    ];
    saveLog(
      sessionDir,
      createLogSessionMeta({
        createdAt: "2026-03-01T10:00:00Z",
        turnCount: 1,
        summary: "Greet the user",
        title: "Greet the user",
        modelConfigName: "test-model",
        sessionId: origSessionId,
      }),
      entries,
    );

    const session = buildSession(projectRoot, store);
    // Hydrate session from disk so /fork sees a populated _log/turnCount.
    const { loadLog } = await import("../src/persistence.js");
    const loaded = loadLog(sessionDir);
    const prepared = session.prepareRestoreFromLog(loaded.meta, loaded.entries, loaded.idAllocator);
    session.commitPreparedRestore(prepared);
    store.attachToExistingSession(sessionDir);

    const showMessage = mock();
    const showHint = mock();
    const ctx = buildCtx({ session, store, showMessage, showHint });

    const registry = buildDefaultRegistry();
    const fork = registry.lookup("/fork");
    expect(fork).toBeTruthy();

    await fork!.handler(ctx, "");

    // Store now points at a new UUID dir (different from original).
    expect(store.sessionDir).toBeTruthy();
    expect(store.sessionDir).not.toBe(sessionDir);
    const newId = store.sessionDir!.split("/").pop()!;
    expect(newId).not.toBe(origSessionId);

    // Title prefixed with (branch).
    const newMeta = JSON.parse(readFileSync(join(store.sessionDir!, "meta.json"), "utf-8"));
    expect(newMeta.title).toBe("(branch) Greet the user");
    expect(newMeta.session_id).toBe(newId);

    // Re-fork the forked session — title should NOT double up.
    await fork!.handler(ctx, "");
    expect(store.sessionDir).toBeTruthy();
    const reforkMeta = JSON.parse(readFileSync(join(store.sessionDir!, "meta.json"), "utf-8"));
    expect(reforkMeta.title).toBe("(branch) Greet the user");

    // Ephemeral hint entry was added in-memory but is NOT persisted.
    const reforkLog = JSON.parse(readFileSync(join(store.sessionDir!, "log.json"), "utf-8"));
    const persistedStatuses = reforkLog.entries.filter(
      (e: { type: string; meta?: Record<string, unknown> }) =>
        e.type === "status" && e.meta?.["statusType"] === "fork_origin",
    );
    expect(persistedStatuses.length).toBe(0);

    // But the in-memory log includes it.
    const inMemory = (session as { log: Array<{ type: string; meta?: Record<string, unknown> }> }).log;
    const liveHints = inMemory.filter(
      (e) => e.type === "status" && e.meta?.["statusType"] === "fork_origin",
    );
    expect(liveHints.length).toBeGreaterThanOrEqual(1);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("refuses to fork an empty session", async () => {
    const tmpDir = join(tmpdir(), `la-fork-empty-${randomBytes(4).toString("hex")}`);
    const projectRoot = join(tmpDir, "project");
    mkdirSync(projectRoot, { recursive: true });

    const store = new SessionStore({ baseDir: tmpDir, projectPath: projectRoot });
    store.createSession();

    const session = buildSession(projectRoot, store);
    const showMessage = mock();
    const showHint = mock();
    const ctx = buildCtx({ session, store, showMessage, showHint });

    const registry = buildDefaultRegistry();
    const fork = registry.lookup("/fork");
    await fork!.handler(ctx, "");

    expect(showHint).toHaveBeenCalledWith("Cannot fork an empty session.");

    // No new session dir was created in the project folder.
    const sessionDirsInProject = readdirSync(store.projectDir).filter(
      (n) => existsSync(join(store.projectDir, n, "log.json")),
    );
    expect(sessionDirsInProject.length).toBe(0);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
