import { describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
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
  LogIdAllocator,
} from "../src/log-entry.js";
import { SessionStore, saveLog, createLogSessionMeta } from "../src/persistence.js";

function makeTempSession(entries: any[], metaOverrides?: Record<string, unknown>) {
  const tmpDir = join(tmpdir(), `la-resume-test-${randomBytes(4).toString("hex")}`);
  const sessionDir = join(tmpDir, "20260301_chat");
  mkdirSync(sessionDir, { recursive: true });

  const meta = createLogSessionMeta({
    createdAt: "2026-03-01T10:00:00Z",
    turnCount: 1,
    compactCount: 0,
    summary: "hello chat",
    ...metaOverrides,
  });
  saveLog(sessionDir, meta, entries);
  return { tmpDir, sessionDir, meta };
}

function makeStoreMock(initialSessionDir = "") {
  const binding = {
    activeBaseDir: undefined as string | undefined,
    projectDir: "/tmp/project",
    sessionDir: initialSessionDir || undefined,
    predictedSessionDir: undefined as string | undefined,
  };
  const store = {
    sessionDir: initialSessionDir,
    captureBindingState: mock(() => ({ ...binding, sessionDir: binding.sessionDir })),
    restoreBindingState: mock((state: typeof binding) => {
      binding.activeBaseDir = state.activeBaseDir;
      binding.projectDir = state.projectDir;
      binding.sessionDir = state.sessionDir;
      binding.predictedSessionDir = state.predictedSessionDir;
      (store as any).sessionDir = state.sessionDir ?? "";
    }),
    attachToExistingSession: mock((path: string) => {
      binding.sessionDir = path;
      (store as any).sessionDir = path;
    }),
  } as any;
  return store;
}

function makeSession(
  projectRoot: string,
  store: SessionStore,
  options?: { initialModelConfigName?: string },
): Session {
  const initialModelConfigName = options?.initialModelConfigName ?? "test-model";
  const modelConfigs = {
    "test-model": {
      name: "test-model",
      provider: "openai",
      model: "gpt-5.4",
      apiKey: "sk-test",
      maxTokens: 1024,
      contextLength: 128000,
      supportsMultimodal: false,
    },
  };

  const primaryAgent = {
    name: "Primary",
    systemPrompt: "ROOT={PROJECT_ROOT}\nART={SESSION_ARTIFACTS}\nSYS={SYSTEM_DATA}",
    tools: [],
    modelConfig: { ...modelConfigs[initialModelConfigName as keyof typeof modelConfigs] },
    _provider: { budgetCalcMode: "full_context" },
    replaceModelConfig(next: any) {
      this.modelConfig = next;
    },
  } as any;

  const config = {
    pathOverrides: { projectRoot },
    subAgentModelName: undefined,
    agentModels: {},
    modelTiers: {},
    mcpServerConfigs: [],
    getModel: (name: string) => {
      const model = (modelConfigs as Record<string, any>)[name];
      if (!model) throw new Error(`Model config '${name}' not found.`);
      return { ...model };
    },
    listModelEntries: () => [],
    upsertModelRaw: () => {},
    get modelNames() {
      return Object.keys(modelConfigs);
    },
  } as any;

  return new Session({
    primaryAgent,
    config,
    agentTemplates: {
      explorer: {
        name: "explorer",
        systemPrompt: "You are an explorer.",
        tools: [],
        maxToolRounds: 8,
        modelConfig: { ...modelConfigs["test-model"] },
        _provider: { budgetCalcMode: "full_context" },
        replaceModelConfig(next: any) {
          this.modelConfig = next;
        },
      } as any,
    },
    store,
  });
}

describe("resume command", () => {
  it("builds picker options from saved sessions", () => {
    const registry = buildDefaultRegistry();
    const resume = registry.lookup("/session");
    expect(resume?.options).toBeTruthy();

    const options = resume!.options!({
      session: {},
      store: {
        listSessions: mock(() => [
          {
            sessionId: "s1",
            path: "/tmp/s1",
            created: "2026-02-21T08:00:00.000-08:00",
            lastActiveAt: "2026-02-22T08:00:00.000-08:00",
            summary: "hello",
            turns: 1,
          },
        ]),
      } as unknown as CommandContext["store"],
    });

    expect(options[0]).toEqual(expect.objectContaining({
      disabled: true,
      label: expect.stringContaining("Created"),
      value: "",
    }));
    expect(options[1]).toEqual(expect.objectContaining({
      value: "s1",
      label: expect.stringContaining("hello"),
    }));
  });

  it("does not pre-truncate /session summaries in picker labels", () => {
    const registry = buildDefaultRegistry();
    const resume = registry.lookup("/session");
    expect(resume?.options).toBeTruthy();

    const options = resume!.options!({
      session: {},
      store: {
        listSessions: mock(() => [
          {
            sessionId: "s1",
            path: "/tmp/s1",
            created: "2026-02-21T08:00:00.000-08:00",
            lastActiveAt: "2026-02-22T08:00:00.000-08:00",
            summary: "123456789012345678901234567890",
            turns: 1,
          },
        ]),
      } as unknown as CommandContext["store"],
    });

    expect(options[1]?.label).toContain("123456789012345678901234567890");
  });

  it("normalizes newlines in /session summaries before truncation", () => {
    const registry = buildDefaultRegistry();
    const resume = registry.lookup("/session");
    expect(resume?.options).toBeTruthy();

    const options = resume!.options!({
      session: {},
      store: {
        listSessions: mock(() => [
          {
            sessionId: "s1",
            path: "/tmp/s1",
            created: "2026-02-21T08:00:00.000-08:00",
            lastActiveAt: "2026-02-22T08:00:00.000-08:00",
            summary: "hello\nworld\nagain",
            turns: 1,
          },
        ]),
      } as unknown as CommandContext["store"],
    });

    expect(options[1]?.label).toContain("hello world again");
    expect(options[1]?.label).not.toContain("\n");
  });

  it("restores from log.json and rebuilds conversation", async () => {
    const registry = buildDefaultRegistry();
    const resume = registry.lookup("/session");
    expect(resume).toBeTruthy();

    const entries = [
      createSystemPrompt("sys-001", 0, "You are helpful"),
      createTurnStart("ts-001", 1),
      createUserMessage("user-001", 1, "Hello!", "Hello!", { contextId: "c1" }),
      createAssistantText("asst-001", 1, 0, "Hi there!", "Hi there!"),
    ];
    const { tmpDir, sessionDir } = makeTempSession(entries);

    const store = makeStoreMock("");
    store.listSessions = mock(() => [
      { path: sessionDir, created: "2026-03-01 10:00:00", summary: "hello chat", turns: 1 },
    ]);

    const prepared = { kind: "prepared" } as any;
    const prepareRestoreFromLog = mock(() => prepared);
    const commitPreparedRestore = mock(() => []);
    const setStore = mock();
    const resetUiState = mock();
    const autoSave = mock();
    const showMessage = mock();

    const ctx: CommandContext = {
      session: {
        prepareRestoreFromLog,
        commitPreparedRestore,
        setStore,
        lastInputTokens: 0,
      },
      showMessage,
      store: store as unknown as CommandContext["store"],
      autoSave,
      resetUiState,
      commandRegistry: registry,
    };

    await resume!.handler(ctx, "1");

    expect(autoSave).toHaveBeenCalledTimes(1);
    expect(resetUiState).toHaveBeenCalledTimes(1);
    expect(prepareRestoreFromLog).toHaveBeenCalledTimes(1);
    expect(commitPreparedRestore).toHaveBeenCalledWith(prepared);

    // Check prepareRestoreFromLog args
    const [resMeta, resEntries, resIdAlloc] = prepareRestoreFromLog.mock.calls[0];
    expect(resMeta.turnCount).toBe(1);
    expect(resEntries).toHaveLength(4);
    expect(resIdAlloc).toBeInstanceOf(LogIdAllocator);

    expect(store.sessionDir).toBe(sessionDir);
    expect(store.attachToExistingSession).toHaveBeenCalledWith(sessionDir);
    expect(setStore).toHaveBeenCalled();

    expect(showMessage).not.toHaveBeenCalledWith("--- Session restored ---");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("shows error when no log.json exists", async () => {
    const registry = buildDefaultRegistry();
    const resume = registry.lookup("/session");

    const tmpDir = join(tmpdir(), `la-resume-test-${randomBytes(4).toString("hex")}`);
    const sessionDir = join(tmpDir, "20260301_chat");
    mkdirSync(sessionDir, { recursive: true });
    // No log.json written

    const store = {
      sessionDir: "",
      listSessions: mock(() => [
        { path: sessionDir, created: "2026-03-01 10:00:00", summary: "test", turns: 1 },
      ]),
    };

    const showMessage = mock();
    const ctx: CommandContext = {
      session: {},
      showMessage,
      store: store as unknown as CommandContext["store"],
      autoSave: mock(),
      resetUiState: mock(),
      commandRegistry: registry,
    };

    await resume!.handler(ctx, "1");

    expect(showMessage).toHaveBeenCalledWith("No log.json found for this session.");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("surfaces restore failures and does not bind the store to the target session", async () => {
    const registry = buildDefaultRegistry();
    const resume = registry.lookup("/session");
    expect(resume).toBeTruthy();

    const entries = [
      createSystemPrompt("sys-001", 0, "You are helpful"),
      createTurnStart("ts-001", 1),
      createUserMessage("user-001", 1, "Hello!", "Hello!", { contextId: "c1" }),
      createAssistantText("asst-001", 1, 0, "Hi there!", "Hi there!"),
    ];
    const { tmpDir, sessionDir } = makeTempSession(entries, {
      modelConfigName: "missing-model",
    });

    const store = makeStoreMock("");
    store.listSessions = mock(() => [
      { path: sessionDir, created: "2026-03-01 10:00:00", summary: "hello chat", turns: 1 },
    ]);

    const showMessage = mock();
    const setStore = mock();
    const ctx: CommandContext = {
      session: {
        prepareRestoreFromLog: mock(() => {
          throw new Error("Model config 'missing-model' not found.");
        }),
        commitPreparedRestore: mock(),
        setStore,
        lastInputTokens: 0,
      },
      showMessage,
      store: store as unknown as CommandContext["store"],
      autoSave: mock(),
      resetUiState: mock(),
      commandRegistry: registry,
    };

    await resume!.handler(ctx, "1");

    expect(showMessage).toHaveBeenCalledWith(
      "Failed to restore session: Model config 'missing-model' not found.",
    );
    expect(store.sessionDir).toBe("");
    expect(store.restoreBindingState).toHaveBeenCalledTimes(1);
    // setStore is intentionally called BEFORE prepareRestoreFromLog (see
    // src/commands.ts) so that _childSessionDir() resolves agent paths from
    // the target session's artifacts during restore. On failure we only roll
    // back the store's binding state (sessionDir → ""); the session.setStore
    // call itself is not reverted because the store object is unchanged.
    expect(setStore).toHaveBeenCalledTimes(1);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resumes a session that has persisted child sessions", async () => {
    const registry = buildDefaultRegistry();
    const resume = registry.lookup("/session");
    expect(resume).toBeTruthy();

    const tmpDir = join(tmpdir(), `la-resume-real-${randomBytes(4).toString("hex")}`);
    const projectRoot = join(tmpDir, "project");
    mkdirSync(projectRoot, { recursive: true });

    const storage = new SessionStore({ baseDir: tmpDir, projectPath: projectRoot });
    const sessionDir = storage.createSession();

    const childSessionDir = join(sessionDir, "artifacts", "agents", "repo-mapper", "session");
    mkdirSync(childSessionDir, { recursive: true });

    const childEntries = [
      createSystemPrompt("child-sys-001", 0, "You are helpful"),
      createTurnStart("child-ts-001", 1),
      createUserMessage("child-user-001", 1, "Map repo", "Map repo", { contextId: "cc1" }),
      createAssistantText("child-asst-001", 1, 0, "Mapped repo", "Mapped repo"),
    ];
    saveLog(
      childSessionDir,
      createLogSessionMeta({
        createdAt: "2026-03-01T10:00:00Z",
        turnCount: 1,
        compactCount: 0,
        summary: "child",
        modelConfigName: "test-model",
      }),
      childEntries,
    );

    const rootEntries = [
      createSystemPrompt("sys-001", 0, "You are helpful"),
      createTurnStart("ts-001", 1),
      createUserMessage("user-001", 1, "Hello!", "Hello!", { contextId: "c1" }),
      createAssistantText("asst-001", 1, 0, "Hi there!", "Hi there!"),
    ];
    saveLog(
      sessionDir,
      createLogSessionMeta({
        createdAt: "2026-03-01T10:00:00Z",
        turnCount: 1,
        compactCount: 0,
        summary: "hello chat",
        modelConfigName: "test-model",
        childSessions: [
          {
            id: "repo-mapper",
            numericId: 1,
            template: "explorer",
            mode: "persistent",
            lifecycle: "idle",
            outcome: "completed",
            order: 1,
          },
        ],
      }),
      rootEntries,
    );

    const liveStore = new SessionStore({ baseDir: tmpDir, projectPath: projectRoot });
    const session = makeSession(projectRoot, liveStore);
    const showMessage = mock();

    const ctx: CommandContext = {
      session,
      showMessage,
      store: Object.assign(liveStore, {
        listSessions: mock(() => [
          { path: sessionDir, created: "2026-03-01 10:00:00", summary: "hello chat", turns: 1 },
        ]),
      }) as unknown as CommandContext["store"],
      autoSave: mock(),
      resetUiState: mock(),
      commandRegistry: registry,
    };

    await resume!.handler(ctx, "1");

    expect(liveStore.sessionDir).toBe(sessionDir);
    expect(session.getChildSessionSnapshots()).toEqual([
      expect.objectContaining({
        id: "repo-mapper",
        mode: "persistent",
        lifecycle: "idle",
      }),
    ]);
    expect(showMessage).not.toHaveBeenCalledWith(expect.stringContaining("Failed to restore session"));

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("shows local timestamps in /session list output", async () => {
    const registry = buildDefaultRegistry();
    const resume = registry.lookup("/session");
    expect(resume).toBeTruthy();

    const showMessage = mock();
    const ctx: CommandContext = {
      session: {},
      showMessage,
      store: {
        listSessions: mock(() => [
          {
            sessionId: "s1",
            path: "/tmp/s1",
            created: "2026-02-21T08:00:00.000-08:00",
            lastActiveAt: "2026-02-22T08:00:00.000-08:00",
            summary: "123456789012345678901234567890",
            turns: 1,
          },
        ]),
      } as unknown as CommandContext["store"],
      autoSave: mock(),
      resetUiState: mock(),
      commandRegistry: registry,
    };

    await resume!.handler(ctx, "");

    const output = showMessage.mock.calls[0][0] as string;
    expect(output).toContain("Sessions");
    expect(output).toContain("Created");
    expect(output).toContain("Active");
    expect(output).toContain("Title");
    expect(output).toContain("123456789012345678901234567890");
    expect(output).not.toContain("Z");
  });
});
