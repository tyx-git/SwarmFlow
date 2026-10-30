/** 启动时的会话选择 UI：项目/全局会话列表、续跑动画与交互式选择。 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";

import { join, relative, resolve } from "node:path";









import { getSwarmflowHomeDir } from "../config/home-dir.js";
import { createUiText, getUiLanguage } from "../ui/text.js";

import { findSessionById, findSessionByName, listSessionsForProject, formatSize } from "../session/resume.js";

interface GlobalSessionGroup {
  projectDir: string;
  projectPath: string;
  sessions: Array<{ sessionId: string; path: string; title?: string; summary: string; lastActiveAt: string; turns: number; sizeBytes: number }>;
}

function listGlobalSessionGroups(homeDir: string): GlobalSessionGroup[] {
  const projectsRoot = join(homeDir, "projects");
  if (!existsSync(projectsRoot)) return [];
  const groups: GlobalSessionGroup[] = [];
  for (const name of readdirSync(projectsRoot).sort((a, b) => a.localeCompare(b))) {
    const projectDir = join(projectsRoot, name);
    try {
      if (!statSync(projectDir).isDirectory()) continue;
    } catch {
      continue;
    }
    let projectPath = name;
    try {
      const meta = JSON.parse(readFileSync(join(projectDir, "project.json"), "utf8"));
      if (typeof meta.original_path === "string" && meta.original_path.trim()) projectPath = meta.original_path.trim();
    } catch { /* 旧版项目存储可能没有 project.json */ }
    const sessions = listSessionsForProject(projectDir);
    if (sessions.length > 0) groups.push({ projectDir, projectPath, sessions });
  }
  return groups;
}

function deleteGlobalSession(sessionDir: string, homeDir: string): boolean {
  const root = resolve(join(homeDir, "projects"));
  const target = resolve(sessionDir);
  const relativePath = relative(root, target);
  const parts = relativePath.split(/[\\/]+/);
  if (relativePath === ".." || relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) return false;
  if (parts.length !== 2 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[1] ?? "")) return false;
  rmSync(target, { recursive: true, force: true });
  return true;
}

/**
 * 启动居中过渡动画 — 用户按下回车后立即调用。
 * 返回清理函数，launchTui() 在 TUI 启动前调用它。
 */
function startResumeAnimation(): void {
  const termWidth = process.stdout.columns || 80;
  const termHeight = process.stdout.rows || 24;
  const paddingTop = Math.max(1, Math.floor((termHeight / 2) - 1));

  const spinFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinIdx = 0;
  const label = "recalling session...";

  function renderFrame(): string {
    const lines: string[] = [];
    for (let i = 0; i < paddingTop; i++) lines.push("");
    const spinChar = spinFrames[spinIdx % spinFrames.length];
    const text = `${spinChar}  ${label}`;
    const pad = Math.max(0, Math.floor((termWidth - text.length) / 2));
    lines.push(`${" ".padEnd(pad)}\x1B[90m${spinChar}\x1B[0m  \x1B[36m${label}\x1B[0m`);
    return lines.join("\n");
  }

  process.stdout.write("\x1B[?25l");
  process.stdout.write("\x1B[2J\x1B[H");
  process.stdout.write(renderFrame());

  const animInterval = setInterval(() => {
    spinIdx = (spinIdx + 1) % spinFrames.length;
    process.stdout.write(`\x1B[${paddingTop + 1};1H\x1B[2K`);
    process.stdout.write(renderFrame());
  }, 100);

  (process as any).__resumeAnimCleanup = () => {
    clearInterval(animInterval);
    process.stdout.write("\x1B[?25h");
    process.stdout.write("\x1B[2J\x1B[H");
    delete (process as any).__resumeAnimCleanup;
  };
}

/**
 * 在 Commander 解析 argv 之前处理 `swarmflow --resume [id/name]`。
 *
 * 支持三种模式：
 *   --resume          显示当前项目的会话列表，交互式选择
 *   --resume <name>   按名称（title/summary）或 UUID 匹配会话
 *   --resume <uuid>   按 UUID 匹配（兼容原有行为）
 *
 * 成功后将会话目录存入环境变量，launchTui() 可在引导后调用 applySessionRestore。
 * --resume 及其参数从 argv 中拼接，以免 Commander 看到它们。
 */
export async function maybeHandleResumeFlag(
  argv: string[],
  findSession: typeof findSessionById = findSessionById,
): Promise<void> {
  const idx = argv.indexOf("--resume");
  if (idx < 0) return;

  const nextArg = argv[idx + 1];
  const hasArg = nextArg && !nextArg.startsWith("--");

  // --resume 不带参数：交互式选择当前项目会话
  if (!hasArg) {
    const { projectDir } = await getCurrentProjectInfo();
    const sessions = listSessionsForProject(projectDir);

    if (sessions.length === 0) {
      console.error("No previous sessions in this project.");
      argv.splice(idx, 1);
      return;
    }

    // 清空终端
    process.stdout.write("\x1Bc");

    // Design A: Separator Lines
    const selected = await interactiveSessionSelect(sessions);
    if (selected < 0) {
      // 用户按了 Esc 或 Ctrl+C
      argv.splice(idx, 1);
      return;
    }

    const chosen = sessions[selected];
    process.env["SWARMFLOW_RESUME_SESSION_DIR"] = chosen.path;

    // 立即启动过渡动画 — 用户按下回车后第一件事
    startResumeAnimation();

    argv.splice(idx, 1);
    return;
  }

  // --resume <argument>
  const id = nextArg;

  // 1. 尝试 UUID 匹配（所有项目）
  let found = findSession(id);
  if (!found) {
    // 2. 尝试名称匹配（当前项目）
    const { projectDir } = await getCurrentProjectInfo();
    const byName = findSessionByName(id, projectDir);
    if (byName) {
      // 构造 FoundSession 结构
      const { projectPath } = readProjectMeta(projectDir);
      found = { sessionDir: byName.path, projectDir, projectPath, title: byName.title };
    }
  }

  if (!found) {
    console.error(`Error: session not found: ${id}`);
    console.error("Tip: use 'swarmflow --resume' to see available sessions.");
    process.exit(1);
  }

  const cwd = process.cwd();
  if (found.projectPath && found.projectPath !== cwd) {
    let willCd: boolean;
    try {
      const { confirm } = await import("@inquirer/prompts");
      willCd = await confirm({
        message: `This session lives in ${found.projectPath}.\n  Switch to that directory and resume?`,
        default: true,
      });
    } catch {
      process.exit(130); // 用户 Ctrl+C
    }
    if (!willCd) process.exit(0);
    try {
      process.chdir(found.projectPath);
    } catch (e) {
      console.error(`Error: failed to chdir to ${found.projectPath}: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  }

  process.env["SWARMFLOW_RESUME_SESSION_DIR"] = found.sessionDir;

  // 立即启动过渡动画
  startResumeAnimation();

  argv.splice(idx, 2);
}

/** 获取当前项目的 projectDir 和 projectPath。 */
async function getCurrentProjectInfo(): Promise<{ projectDir: string; projectPath: string }> {
  const cwd = process.cwd();
  const { projectSlug } = await import( "../config/storage-layout.js");
  const slug = projectSlug(cwd);
  const projectDir = join(getSwarmflowHomeDir(), "projects", slug);
  return { projectDir, projectPath: cwd };
}

/** 从 project.json 读取 projectPath。 */
function readProjectMeta(projectDir: string): { projectPath: string | undefined } {
  try {
    const raw = JSON.parse(readFileSync(join(projectDir, "project.json"), "utf-8"));
    return { projectPath: typeof raw.original_path === "string" ? raw.original_path : undefined };
  } catch {
    return { projectPath: undefined };
  }
}

/** 格式化时间为 "X mins ago" 风格。 */
function formatAge(isoString: string | undefined): string {
  if (!isoString) return "unknown";
  const ms = Date.parse(isoString);
  if (!Number.isFinite(ms)) return "unknown";
  const delta = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (delta < 60) return delta <= 1 ? "just now" : `${delta}s ago`;
  const mins = Math.floor(delta / 60);
  if (mins < 60) return mins === 1 ? "1 min ago" : `${mins} mins ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** 格式化会话选择项。 */
/**
 * 交互式会话选择器 — 使用 readline 实现完全控制的 UI。
 * Design A: Separator Lines 风格。
 * 返回选中的索引，Esc/Ctrl+C 返回 -1。
 */
async function interactiveSessionSelect(
  sessions: Array<{ title?: string; summary: string; lastActiveAt: string; turns: number; path: string; sizeBytes: number }>,
): Promise<number> {
  const { stdin, stdout } = process;

  const maxShow = Math.min(sessions.length, 5);
  let selected = 0;

  // 隐藏光标
  stdout.write("\x1B[?25l");

  const render = () => {
    // 清空屏幕
    stdout.write("\x1B[2J\x1B[H");

    const cols = stdout.columns || 80;
    const margin = 4; // 左右边距
    const lineLen = cols - margin * 2;

    const line = (i: number) => {
      const s = sessions[i];
      const label = s.title || s.summary.slice(0, 40) || "(untitled)";
      const age = formatAge(s.lastActiveAt);
      const size = formatSize(s.sizeBytes);
      const subtitle = `${age} · ${size} · ${s.turns} turns`;

      if (i === selected) {
        // 选中行：> 指示器 + 粗体
        return [
          `${" ".repeat(margin)}\x1B[38;2;122;162;247m>\x1B[0m \x1B[1;37m${label}\x1B[0m`,
          `${" ".repeat(margin + 3)}\x1B[90m${subtitle}\x1B[0m`,
        ].join("\n");
      } else {
        return [
          `${" ".repeat(margin)}  \x1B[37m${label}\x1B[0m`,
          `${" ".repeat(margin + 3)}\x1B[90m${subtitle}\x1B[0m`,
        ].join("\n");
      }
    };

    // 标题：居中 + 大字体
    const titleText = "[ Recent Sessions ]";
    const titlePad = Math.max(0, Math.floor((cols - titleText.length) / 2));

    stdout.write("\n");
    stdout.write(`${" ".repeat(margin)}\x1B[90m${"━".repeat(lineLen)}\x1B[0m\n`);
    stdout.write(`${" ".repeat(titlePad)}\x1B[1;38;2;255;255;255m${titleText}\x1B[0m\n`);
    stdout.write(`${" ".repeat(margin)}\x1B[90m${"━".repeat(lineLen)}\x1B[0m\n`);
    stdout.write("\n");

    for (let i = 0; i < maxShow; i++) {
      stdout.write(line(i) + "\n");
      if (i < maxShow - 1) stdout.write("\n");
    }

    stdout.write("\n");
    stdout.write(`${" ".repeat(margin)}\x1B[90m↑↓ Navigate · Enter Resume · Esc Cancel\x1B[0m\n`);
  };

  render();

  return new Promise<number>((resolve) => {
    let resolved = false;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      stdin.removeListener("data", onData);
      if (stdin.isRaw) stdin.setRawMode(false);
      stdout.write("\x1B[?25h"); // 显示光标
      // 用 typeof 守卫：测试注入的假 stdin 未必实现这两个方法。
      if (typeof stdin.pause === "function") stdin.pause();
      if (typeof stdin.unref === "function") stdin.unref();
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");

    // 缓冲区用于检测 Esc 序列
    let escBuffer = "";
    let escTimer: ReturnType<typeof setTimeout> | null = null;

    const onData = (key: string) => {
      if (resolved) return;

      // 处理 Esc 序列（箭头键等）
      if (key.startsWith("\x1B")) {
        escBuffer += key;
        if (escTimer) clearTimeout(escTimer);

        // 检查是否是完整的箭头键序列
        if (escBuffer === "\x1B[A") {
          selected = (selected - 1 + maxShow) % maxShow;
          render();
          escBuffer = "";
          return;
        } else if (escBuffer === "\x1B[B") {
          selected = (selected + 1) % maxShow;
          render();
          escBuffer = "";
          return;
        }

        // 等待更多字符
        escTimer = setTimeout(() => {
          // 超时：不是箭头键，检查是否是单独的 Esc
          if (escBuffer === "\x1B") {
            cleanup();
            resolve(-1);
          }
          escBuffer = "";
        }, 30);
        return;
      }

      // 非 Esc 字符
      if (escTimer) clearTimeout(escTimer);
      escBuffer = "";

      if (key === "\r" || key === "\n") {
        cleanup();
        resolve(selected);
      } else if (key === "\x03") {
        cleanup();
        resolve(-1);
      }
    };

    stdin.on("data", onData);
  });
}

/** 全局历史会话管理器：两层树结构，当前仅支持删除会话。 */
export async function interactiveGlobalSessionManager(homeDir: string): Promise<void> {
  const { stdin, stdout } = process;
  const text = createUiText(getUiLanguage(homeDir));
  const ui = (key: string, vars?: Record<string, string | number>): string =>
    text.get(["Views", "sessionManager", key], vars);
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    process.stderr.write("swarmflow --session requires an interactive terminal.\n");
    return;
  }
  let groups = listGlobalSessionGroups(homeDir);
  let projectIndex = 0;
  let sessionIndex = 0;
  let focus: "project" | "session" = "project";
  let notice = "";

  const selectedSession = () => groups[projectIndex]?.sessions[sessionIndex];
  const visibleNodes = (): Array<{ kind: "project"; project: number } | { kind: "session"; project: number; session: number }> => {
    const nodes: Array<{ kind: "project"; project: number } | { kind: "session"; project: number; session: number }> = [];
    groups.forEach((group, project) => {
      nodes.push({ kind: "project", project });
      group.sessions.forEach((_session, session) => nodes.push({ kind: "session", project, session }));
    });
    return nodes;
  };
  const selectedNodeIndex = (): number => {
    const nodes = visibleNodes();
    const selected = focus === "project"
      ? nodes.findIndex((node) => node.kind === "project" && node.project === projectIndex)
      : nodes.findIndex((node) => node.kind === "session" && node.project === projectIndex && node.session === sessionIndex);
    return Math.max(0, selected);
  };
  const titleForSession = (session: NonNullable<ReturnType<typeof selectedSession>>) =>
    session.title || session.summary.replace(/\s+/g, " ").slice(0, 48) || session.sessionId;
  const renderHeader = () => {
    const width = stdout.columns || 80;
    const contentWidth = Math.max(20, width - 8);
    const line = "━".repeat(contentWidth);
    const title = ui("title");
    const titlePadding = " ".repeat(Math.max(0, Math.floor((contentWidth - title.length) / 2)));
    stdout.write(`    \x1B[90m${line}\x1B[0m\n`);
    stdout.write(`    ${titlePadding}\x1B[1;38;2;255;255;255m${title}\x1B[0m\n`);
    stdout.write(`    \x1B[90m${line}\x1B[0m\n\n`);
  };
  const renderFooter = () => {
    const rows = stdout.rows || 24;
    const noticeRow = Math.max(1, rows - 1);
    const helpRow = Math.max(1, rows);
    stdout.write(`\x1B[${noticeRow};1H\x1B[2K${notice ? `    \x1B[33m${notice}\x1B[0m` : ""}`);
    stdout.write(`\x1B[${helpRow};1H\x1B[2K    \x1B[90m${ui("help")}\x1B[0m`);
  };
  const projectRow = (index: number): string => {
    const group = groups[index];
    if (!group) return "";
    const selected = focus === "project" && index === projectIndex;
    return `    ${selected ? "❯ " : "  "}${selected ? "\x1B[1;36m" : "\x1B[36m"}${group.projectPath}\x1B[0m\n`;
  };
  const sessionRow = (project: number, sessionIndexForRow: number): string => {
    const session = groups[project]?.sessions[sessionIndexForRow];
    if (!session) return "";
    const selected = focus === "session" && project === projectIndex && sessionIndexForRow === sessionIndex;
    const suffix = `${session.turns} turns · ${formatSize(session.sizeBytes)}`;
    return `      ${selected ? "❯ " : "  "}${selected ? "\x1B[1;37m" : "\x1B[37m"}${titleForSession(session)}\x1B[0m  \x1B[90m${suffix}\x1B[0m\n`;
  };
  const render = () => {
    stdout.write("\x1B[2J\x1B[H");
    renderHeader();
    if (groups.length === 0) {
      stdout.write(`    ${ui("empty")}\n\n`);
    } else {
      groups.forEach((group, project) => {
        stdout.write(projectRow(project));
        group.sessions.forEach((session, si) => {
          stdout.write(sessionRow(project, si));
        });
      });
      stdout.write("\n");
    }
    renderFooter();
  };
  const renderChangedRows = (previous: { projectIndex: number; sessionIndex: number; focus: "project" | "session" }) => {
    if (groups.length === 0) {
      render();
      return;
    }
    const width = stdout.columns || 80;
    const writeRow = (row: number, content: string) => {
      stdout.write(`\x1B[${row};1H\x1B[2K${content}\x1B[${row};${width}H`);
    };
    const projectRowStart = (index: number) => 5 + groups
      .slice(0, index)
      .reduce((total, group) => total + 1 + group.sessions.length, 0);
    const sessionRowStart = (index: number) => projectRowStart(index) + 1;
    const changedRows = new Map<number, string>();
    if (previous.projectIndex !== projectIndex || previous.focus !== focus) {
      changedRows.set(projectRowStart(previous.projectIndex), projectRow(previous.projectIndex));
      changedRows.set(projectRowStart(projectIndex), projectRow(projectIndex));
    }
    if (previous.focus === "session" && (previous.projectIndex !== projectIndex || previous.sessionIndex !== sessionIndex || previous.focus !== focus)) {
      changedRows.set(
        sessionRowStart(previous.projectIndex) + previous.sessionIndex,
        sessionRow(previous.projectIndex, previous.sessionIndex),
      );
    }
    if (focus === "session" && (previous.projectIndex !== projectIndex || previous.sessionIndex !== sessionIndex || previous.focus !== focus)) {
      changedRows.set(sessionRowStart(projectIndex) + sessionIndex, sessionRow(projectIndex, sessionIndex));
    }
    for (const [row, content] of changedRows) writeRow(row, content);
    renderFooter();
  };

  stdin.setEncoding("utf8");

  await new Promise<void>((resolvePromise) => {
    let buffer = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pendingDelete: string | undefined;
    let finished = false;
    const cleanup = () => {
      stdin.removeListener("data", onData);
      process.removeListener("SIGINT", onSigint);
      if (timer) clearTimeout(timer);
      if (stdin.isRaw) stdin.setRawMode(false);
      stdout.write("\x1B[?25h\n");
      // 用 typeof 守卫：测试注入的假 stdin 未必实现这两个方法。
      if (typeof stdin.pause === "function") stdin.pause();
      if (typeof stdin.unref === "function") stdin.unref();
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      cleanup();
      resolvePromise();
    };
    const onSigint = () => finish();
    const deleteSelectedSession = () => {
      if (focus !== "session") {
        notice = ui("projectFocus");
        pendingDelete = undefined;
        return;
      }
      const session = selectedSession();
      if (!session) {
        notice = ui("noSession");
        pendingDelete = undefined;
        return;
      }
      if (pendingDelete === session.path) {
        if (deleteGlobalSession(session.path, homeDir)) {
          groups = listGlobalSessionGroups(homeDir);
          projectIndex = Math.min(projectIndex, Math.max(0, groups.length - 1));
          sessionIndex = Math.min(sessionIndex, Math.max(0, (groups[projectIndex]?.sessions.length ?? 1) - 1));
          notice = ui("deleted");
        } else {
          notice = ui("deleteFailed");
        }
        pendingDelete = undefined;
        return;
      }
      pendingDelete = session.path;
      notice = ui("confirmDelete", { title: titleForSession(session) });
    };
    const onData = (key: string) => {
      if (key.includes("\x03")) {
        buffer = "";
        finish();
        return;
      }
      buffer += key;
      if (timer) clearTimeout(timer);
      const previous = { projectIndex, sessionIndex, focus };
      const arrow = buffer.match(/^\x1B(?:\[\d*(?:;\d*)*|O)([ABCD])$/)?.[1];
      if (arrow === "A" || arrow === "B") {
        const direction = arrow === "A" ? -1 : 1;
        const nodes = visibleNodes();
        const nextNode = nodes[Math.max(0, Math.min(nodes.length - 1, selectedNodeIndex() + direction))];
        if (!nextNode) {
          buffer = "";
          return;
        }
        projectIndex = nextNode.project;
        if (nextNode.kind === "project") {
          focus = "project";
        } else {
          focus = "session";
          sessionIndex = nextNode.session;
        }
        if (previous.projectIndex === projectIndex && previous.sessionIndex === sessionIndex && previous.focus === focus) {
          buffer = "";
          return;
        }
        notice = "";
        pendingDelete = undefined;
        buffer = "";
        renderChangedRows(previous);
        return;
      }
      if (arrow === "D") { focus = "project"; pendingDelete = undefined; notice = ""; buffer = ""; renderChangedRows(previous); return; }
      if (arrow === "C") { focus = "session"; pendingDelete = undefined; notice = ""; buffer = ""; renderChangedRows(previous); return; }
      if (buffer === "\x1B[3~" || buffer === "\x7F" || buffer === "\x08") {
        const confirming = pendingDelete === selectedSession()?.path;
        deleteSelectedSession();
        buffer = "";
        if (pendingDelete) renderFooter();
        else if (confirming) render();
        else renderFooter();
        return;
      }
      const incompleteEscape = buffer === "\x1B"
        || buffer === "\x1BO"
        || (buffer.startsWith("\x1B[") && !/[\x40-\x7E]$/.test(buffer.slice(2)));
      if (incompleteEscape) {
        timer = setTimeout(() => {
          const isEscape = buffer === "\x1B";
          buffer = "";
          if (isEscape && pendingDelete) {
            pendingDelete = undefined;
            notice = "";
            renderFooter();
          } else if (isEscape) {
            finish();
          }
        }, 40);
        return;
      }
      if (buffer === "\x03") {
        buffer = "";
        finish();
        return;
      }
      if (buffer === "\r" || buffer === "\n") {
        if (focus === "project") {
          focus = "session";
          pendingDelete = undefined;
          notice = "";
          buffer = "";
          renderChangedRows(previous);
          return;
        }
        const confirming = pendingDelete === selectedSession()?.path;
        deleteSelectedSession();
        buffer = "";
        if (pendingDelete) renderFooter();
        else if (confirming) render();
        else renderFooter();
        return;
      }
      if (buffer.toLowerCase() === "d") {
        const confirming = pendingDelete === selectedSession()?.path;
        deleteSelectedSession();
        buffer = "";
        if (pendingDelete) renderFooter();
        else if (confirming) render();
        else renderFooter();
        return;
      }
      buffer = "";
    };
    stdin.on("data", onData);
    process.on("SIGINT", onSigint);
    stdout.write("\x1B[?25l");
    stdin.setRawMode(true);
    stdin.resume();
    render();
  });
}
