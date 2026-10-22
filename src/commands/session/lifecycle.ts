/** 会话生命周期命令：/new /compact /ps /rename /fork /reload。 */

import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { randomSessionId } from "../../config/storage-layout.js";

import { applySessionRestore } from "../../session/resume.js";

import { reRegisterSkillCommands } from "../ecosystem/skills.js";
import { type CommandContext } from "../types.js";

export async function cmdNew(ctx: CommandContext, _args: string): Promise<void> {
  if (ctx.restartRuntimeForNewSession) {
    await ctx.restartRuntimeForNewSession();
    return;
  }

  ctx.autoSave();

  // 清除会话目录-第一次保存时将惰性地创建一个新目录。
  // 这样可以避免在用户不发送任何消息时创建空会话文件。
  if (ctx.store) {
    ctx.store.clearSession();
  }

  // 完整会话重置-更新存储，然后重新初始化会话
  // 有正确的路径。相当于构造一个新的Session。
  await ctx.session.resetForNewSession(ctx.store);
  ctx.resetUiState();
}

export async function cmdCompact(ctx: CommandContext, args: string): Promise<void> {
  if (!ctx.onManualCompactRequested) {
    ctx.showMessage("Manual compact is not available in this UI.");
    return;
  }
  ctx.onManualCompactRequested(args.trim());
}

export async function cmdShells(ctx: CommandContext, _args: string): Promise<void> {
  if (!ctx.onShellsRequested) {
    ctx.showMessage("The process panel is not available in this UI.");
    return;
  }
  ctx.onShellsRequested();
}

export async function cmdRename(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  if (!session) return;

  const trimmed = args.trim();
  if (trimmed) {
    session.setTitle?.(trimmed);
    ctx.autoSave();
    if (ctx.appendSwitchCommandEcho) ctx.appendSwitchCommandEcho("/rename", trimmed);
    else ctx.showMessage(`Session renamed to: ${trimmed}`);
    return;
  }

  // 交互式：提示新标题
  if (!ctx.promptSecret) {
    ctx.showMessage("Usage: /rename <new title>");
    return;
  }
  const currentName = session.getDisplayName?.() || "";
  const input = await ctx.promptSecret({
    message: `Rename session (current: ${currentName}):`,
    allowEmpty: true,
  });
  if (input === undefined) return; // cancelled
  const value = input.trim();
  if (value) {
    session.setTitle?.(value);
    ctx.autoSave();
    if (ctx.appendSwitchCommandEcho) ctx.appendSwitchCommandEcho("/rename", value);
    else ctx.showMessage(`Session renamed to: ${value}`);
  } else {
    session.setTitle?.("");
    ctx.autoSave();
    ctx.showMessage("Session title cleared (using auto-generated name).");
  }
}

// ------------------------------------------------------------------
// /法典命令
// ------------------------------------------------------------------

/**
 * 显式 /reload：重新扫描 skills/MCP，并重建 system snapshot。
 *
 * 这是会话内唯一允许改变 tools/system 缓存前缀的用户入口；
 * /skills 只记录选择，等这里才真正应用。
 */
export async function cmdReload(ctx: CommandContext, _args: string): Promise<void> {
  const session = ctx.session;
  if (!session || typeof session.reloadConfigurationFromCommand !== "function") {
    ctx.showMessage("Reload is unavailable in this runtime.");
    return;
  }

  const oldSkills = session.skills;
  const hadPendingSkillChanges = session.skillsDirty === true;
  const report = await session.reloadConfigurationFromCommand();
  if (oldSkills && session.skills && ctx.commandRegistry) {
    reRegisterSkillCommands(ctx.commandRegistry, oldSkills, session.skills);
  }
  ctx.showMessage(
    hadPendingSkillChanges ? `${report}\nPending skill changes applied.` : report,
  );
  (ctx.showHint ?? ctx.showMessage)("Reloaded. The next request uses the new tools/system prefix.");
}

// ------------------------------------------------------------------
// 注册表生成器
// ------------------------------------------------------------------

export async function cmdFork(ctx: CommandContext): Promise<void> {
  const hint = ctx.showHint ?? ctx.showMessage;
  const session = ctx.session;
  const store = ctx.store;

  if (!store) {
    ctx.showMessage("Session persistence not available.");
    return;
  }

  if (session.currentTurnRunning) {
    hint("Cannot fork while a turn is running.");
    return;
  }

  const childSnapshots = (typeof session.getChildSessionSnapshots === "function"
    ? session.getChildSessionSnapshots()
    : []) as Array<{ lifecycle: string }>;
  const liveChildren = childSnapshots.filter(
    (s) => s.lifecycle === "running" || s.lifecycle === "blocked",
  );
  if (liveChildren.length > 0) {
    hint("Cannot fork while sub-agents are running.");
    return;
  }

  const sourceDir = store.sessionDir;
  if (!sourceDir) {
    ctx.showMessage("No active session to fork.");
    return;
  }

  // 保存当前状态，以便在克隆之前将最新的日志/元数据复制到磁盘。
  ctx.autoSave();

  // 空会话不记录日志。（当turnCount === 0时，saveLog跳过）。
  if (!existsSync(join(sourceDir, "log.json"))) {
    hint("Cannot fork an empty session.");
    return;
  }

  const origSessionId = basename(sourceDir);
  const newSessionId = randomSessionId();
  const newDir = join(store.projectDir, newSessionId);

  try {
    cpSync(sourceDir, newDir, { recursive: true });
  } catch (e) {
    try { rmSync(newDir, { recursive: true, force: true }); } catch { /* 的最优 */ }
    ctx.showMessage(`Fork failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  // 补丁新的meta。Json + log。json：新的ID，新的时间戳，分支标题。
  try {
    const nowIso = new Date().toISOString();
    const metaPath = join(newDir, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    const origTitleSrc = (typeof meta.title === "string" && meta.title.length > 0)
      ? meta.title
      : (typeof meta.summary === "string" ? meta.summary : "");
    const branchTitle = origTitleSrc.startsWith("(branch) ")
      ? origTitleSrc
      : `(branch) ${origTitleSrc}`.trim();
    meta.session_id = newSessionId;
    meta.created_at = nowIso;
    meta.last_active_at = nowIso;
    meta.title = branchTitle;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    const logPath = join(newDir, "log.json");
    const logData = JSON.parse(readFileSync(logPath, "utf-8"));
    logData.session_id = newSessionId;
    logData.created_at = nowIso;
    logData.updated_at = nowIso;
    logData.title = branchTitle;
    writeFileSync(logPath, JSON.stringify(logData, null, 2));
  } catch (e) {
    try { rmSync(newDir, { recursive: true, force: true }); } catch { /* 的最优 */ }
    ctx.showMessage(`Fork failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  ctx.resetUiState();

  // 分叉：任务清单随会话目录被复制，但必须消毒（清执行体关联、in_progress 降级）
  const result = applySessionRestore(session, store, newDir, { fork: true });
  for (const w of result.warnings) ctx.showMessage(w);
  if (!result.ok && result.error) {
    ctx.showMessage(result.error);
    return;
  }

  // 返回父节点的短暂指针——在对话中可见；
  // 没有持久化到日志。saveLog过滤元数据。短暂的条目)。
  if (typeof session.appendStatusMessage === "function") {
    session.appendStatusMessage(
      `To continue the original session, run swarmflow --resume ${origSessionId}`,
      "fork_origin",
      true,
    );
  }
}

// ------------------------------------------------------------------
// / mcp命令
// ------------------------------------------------------------------
