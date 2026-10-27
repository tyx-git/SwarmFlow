/**
 * P-16 / I10.5 探针：fork 复制会话目录时会把 rewind journal 一起带进新会话。
 * 本测试只核实"副本会不会被恢复流程执行"，不实现清理。
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { Session } from "../../src/session.js";
import { SessionStore } from "../../src/config/session-store.js";
import { saveLog } from "../../src/config/log-serialization.js";
import { createLogSessionMeta } from "../../src/config/session-meta.js";
import {
  createAssistantText,
  createSystemPrompt,
  createTurnStart,
  createUserMessage,
} from "../../src/context/entry/factories.js";
import { forkSessionDirectory } from "../../src/server/session-fork.js";
import { applySessionRestore } from "../../src/session/resume.js";

function makeSession(projectRoot: string, store: SessionStore): Session {
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
    replaceModelConfig(next: unknown) { this.modelConfig = next; },
  } as any;
  const config = {
    pathOverrides: { projectRoot },
    subAgentModelName: undefined,
    mcpServerConfigs: [],
    getModel: () => ({ ...modelConfig }),
    listModelEntries: () => [],
    upsertModelRaw: () => {},
    get modelNames() { return ["test-model"]; },
  } as any;
  return new Session({ primaryAgent, config, agentTemplates: {}, store });
}

interface SeededSession {
  homeDir: string;
  projectRoot: string;
  store: SessionStore;
  sessionDir: string;
}

function seedSession(): SeededSession {
  const homeDir = mkdtempSync(join(tmpdir(), "swarmflow-rewind-fork-"));
  const projectRoot = join(homeDir, "project");
  mkdirSync(projectRoot, { recursive: true });
  const store = new SessionStore({ baseDir: homeDir, projectPath: projectRoot });
  const sessionDir = store.createSession();
  saveLog(
    sessionDir,
    createLogSessionMeta({
      createdAt: "2026-03-01T10:00:00Z",
      turnCount: 1,
      summary: "Rewind probe",
      title: "Rewind probe",
      modelConfigName: "test-model",
      sessionId: basename(sessionDir),
    }),
    [
      createSystemPrompt("sys-001", 0, "You are helpful"),
      createTurnStart("ts-001", 1),
      createUserMessage("user-001", 1, "edit notes", "edit notes", { contextId: "c1" }),
      createAssistantText("asst-001", 1, 0, "done", "done"),
    ],
  );
  return { homeDir, projectRoot, store, sessionDir };
}

/** 造一个 ready-state journal，回退目标指向工作树里的真实文件。 */
function writeReadyJournal(opts: {
  artifactsDir: string;
  targetPath: string;
  preimageContent: string;
  entryId: string;
}): { journalPath: string; backupDir: string } {
  mkdirSync(opts.artifactsDir, { recursive: true });
  const journalPath = join(opts.artifactsDir, "rewind-journal.json");
  const backupDir = `${journalPath}.data-${randomUUID()}`;
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, "0");
  writeFileSync(backupPath, opts.preimageContent, "utf-8");
  writeFileSync(
    journalPath,
    JSON.stringify({
      version: 1,
      filePath: journalPath,
      state: "ready",
      backupDir,
      preimages: [{ path: opts.targetPath, kind: "file", backupPath }],
      applied: [],
      pending: [{ entryId: opts.entryId }],
    }),
    "utf-8",
  );
  return { journalPath, backupDir };
}

let homeDir: string | undefined;

afterEach(() => {
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  homeDir = undefined;
});

describe("fork 与 rewind journal（探针）", () => {
  it("阳性对照：journal 在原路径会被回放，说明夹具确可执行", async () => {
    const seeded = seedSession();
    homeDir = seeded.homeDir;
    const targetPath = resolve(seeded.projectRoot, "notes.txt");
    writeFileSync(targetPath, "post-rewind\n", "utf-8");
    const { journalPath, backupDir } = writeReadyJournal({
      artifactsDir: join(seeded.sessionDir, "artifacts"),
      targetPath,
      preimageContent: "pre-rewind\n",
      entryId: "asst-001",
    });

    const session = makeSession(seeded.projectRoot, seeded.store);
    const result = await applySessionRestore(session, seeded.store, seeded.sessionDir);

    expect(result.ok).toBe(true);
    expect(readFileSync(targetPath, "utf-8")).toBe("pre-rewind\n");
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(backupDir)).toBe(false);
  });

  it("fork 丢弃继承的 journal 与 .data-*，父会话两者保留且恢复不回放", async () => {
    const seeded = seedSession();
    homeDir = seeded.homeDir;
    const targetPath = resolve(seeded.projectRoot, "notes.txt");
    writeFileSync(targetPath, "post-rewind\n", "utf-8");
    const { journalPath, backupDir } = writeReadyJournal({
      artifactsDir: join(seeded.sessionDir, "artifacts"),
      targetPath,
      preimageContent: "pre-rewind\n",
      entryId: "asst-001",
    });

    const forked = forkSessionDirectory(seeded.sessionDir);
    const forkArtifacts = join(forked.sessionDir, "artifacts");
    const forkJournal = join(forkArtifacts, "rewind-journal.json");
    expect(existsSync(forkJournal)).toBe(false);
    expect(existsSync(join(forkArtifacts, basename(backupDir)))).toBe(false);
    expect(existsSync(journalPath)).toBe(true);
    expect(existsSync(backupDir)).toBe(true);

    const forkStore = new SessionStore({ baseDir: seeded.homeDir, projectPath: seeded.projectRoot });
    const forkSession = makeSession(seeded.projectRoot, forkStore);
    const result = await applySessionRestore(forkSession, forkStore, forked.sessionDir, { fork: true });

    expect(result.ok).toBe(true);
    expect(readFileSync(targetPath, "utf-8")).toBe("post-rewind\n");
    expect(result.warnings.some((w) => w.startsWith("[rewind]"))).toBe(false);
    expect(existsSync(journalPath)).toBe(true);
  });

  it("机制隔离：手工放回副本 journal 并改成本地路径后即会回放（拦截点＝绝对路径绑定）", async () => {
    const seeded = seedSession();
    homeDir = seeded.homeDir;
    const targetPath = resolve(seeded.projectRoot, "notes.txt");
    writeFileSync(targetPath, "post-rewind\n", "utf-8");
    const { journalPath, backupDir } = writeReadyJournal({
      artifactsDir: join(seeded.sessionDir, "artifacts"),
      targetPath,
      preimageContent: "pre-rewind\n",
      entryId: "asst-001",
    });

    const forked = forkSessionDirectory(seeded.sessionDir);
    const forkArtifacts = join(forked.sessionDir, "artifacts");
    mkdirSync(forkArtifacts, { recursive: true });
    const forkJournal = join(forkArtifacts, "rewind-journal.json");
    // fork 已清理继承副本；本用例手工放回，验证既有绝对路径防御仍生效。
    cpSync(journalPath, forkJournal);
    cpSync(backupDir, join(forkArtifacts, basename(backupDir)), { recursive: true });
    const copied = JSON.parse(readFileSync(forkJournal, "utf-8")) as {
      filePath: string;
      backupDir: string;
      preimages: Array<{ backupPath?: string }>;
    };
    const forkBackupDir = join(forkArtifacts, basename(copied.backupDir));
    copied.filePath = forkJournal;
    copied.backupDir = forkBackupDir;
    copied.preimages[0]!.backupPath = join(forkBackupDir, "0");
    writeFileSync(forkJournal, JSON.stringify(copied), "utf-8");

    const forkStore = new SessionStore({ baseDir: seeded.homeDir, projectPath: seeded.projectRoot });
    const forkSession = makeSession(seeded.projectRoot, forkStore);
    const result = await applySessionRestore(forkSession, forkStore, forked.sessionDir, { fork: true });

    expect(result.ok).toBe(true);
    expect(readFileSync(targetPath, "utf-8")).toBe("pre-rewind\n");
  });

  it("父会话恢复完成后，fork 的陈旧 journal 仍不会覆盖后续编辑", async () => {
    const seeded = seedSession();
    homeDir = seeded.homeDir;
    const targetPath = resolve(seeded.projectRoot, "notes.txt");
    writeFileSync(targetPath, "post-rewind\n", "utf-8");
    writeReadyJournal({
      artifactsDir: join(seeded.sessionDir, "artifacts"),
      targetPath,
      preimageContent: "pre-rewind\n",
      entryId: "asst-001",
    });

    const forked = forkSessionDirectory(seeded.sessionDir);

    const parentSession = makeSession(seeded.projectRoot, seeded.store);
    expect((await applySessionRestore(parentSession, seeded.store, seeded.sessionDir)).ok).toBe(true);
    expect(readFileSync(targetPath, "utf-8")).toBe("pre-rewind\n");

    writeFileSync(targetPath, "later edit\n", "utf-8");

    const forkStore = new SessionStore({ baseDir: seeded.homeDir, projectPath: seeded.projectRoot });
    const forkSession = makeSession(seeded.projectRoot, forkStore);
    const result = await applySessionRestore(forkSession, forkStore, forked.sessionDir, { fork: true });

    expect(result.ok).toBe(true);
    expect(readFileSync(targetPath, "utf-8")).toBe("later edit\n");
  });
});
