"use strict";

const { existsSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");
const { resolve, dirname, join } = require("node:path");

const distributionRoot = dirname(process.execPath);
const runtimeRoot = join(distributionRoot, "runtime");
const cliPath = join(runtimeRoot, "dist", "src", "cli.js");
const runtimeRequire = createRequire(__filename);
const FFI_RELAUNCH_MARKER = "SWARMFLOW_SEA_FFI_RELAUNCHED";
// 控制台 UTF-8 已由本引导切好，cli.ts 不必再 chcp 一次。
const CONSOLE_READY_MARKER = "SWARMFLOW_SEA_CONSOLE_READY";
const NODE_FFI_EXEC_ARGS = [
  "--experimental-ffi",
  "--no-warnings",
];

function isSamePath(left, right) {
  try {
    return resolve(left).toLowerCase() === resolve(right).toLowerCase();
  } catch {
    return left === right;
  }
}

function getUserArguments() {
  const args = process.argv.slice(1);

  // SEA normally omits a script path. A relaunch from cli.ts deliberately
  // passes cliPath, so strip either representation before forwarding args.
  if (args[0] && (isSamePath(args[0], process.execPath) || isSamePath(args[0], cliPath))) {
    return args.slice(1);
  }

  return args;
}

function getNodeMajorVersion() {
  const major = Number.parseInt(process.versions.node.split(".", 1)[0] ?? "0", 10);
  return Number.isFinite(major) ? major : 0;
}

function hasNodeFfi() {
  try {
    require("node:ffi");
    return true;
  } catch {
    return false;
  }
}

function relaunchWithNodeFfi(userArgs) {
  if (process.env[FFI_RELAUNCH_MARKER] === "1") {
    throw new Error(
      "Node.js FFI is still unavailable after relaunch. Use Node.js 26 or newer to run the TUI executable.",
    );
  }

  if (getNodeMajorVersion() < 26) {
    throw new Error(
      `The TUI executable requires Node.js 26 or newer for node:ffi; embedded runtime is ${process.versions.node}.`,
    );
  }

  const nodeOptions = [process.env.NODE_OPTIONS, ...NODE_FFI_EXEC_ARGS]
    .filter(Boolean)
    .join(" ");
  const child = spawnSync(process.execPath, userArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      [FFI_RELAUNCH_MARKER]: "1",
    },
  });

  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

function ensureWindowsUtf8Console() {
  if (process.platform !== "win32" || !process.stdout.isTTY) return;

  // FFI 重启后的子进程与父进程共享同一个控制台（stdio: "inherit"），
  // 代码页已由父进程设置过，无需再派发一次 chcp。
  if (process.env[FFI_RELAUNCH_MARKER] !== "1") {
    // 直接调用 chcp.com，而不是 `cmd /d /s /c chcp 65001`：绕开 cmd.exe 的
    // 解释器启动，实测单次派生由约 296ms 降到约 181ms。
    const systemRoot = process.env.SYSTEMROOT || process.env.SystemRoot || "C:\\Windows";
    const chcpPath = join(systemRoot, "System32", "chcp.com");
    try {
      spawnSync(existsSync(chcpPath) ? chcpPath : "chcp.com", ["65001"], {
        stdio: "ignore",
      });
    } catch {
      // 无 shell 支撑的控制台仍可使用 UTF-8 字节流。
    }
  }

  process.stdout.setDefaultEncoding("utf8");
  process.stderr.setDefaultEncoding("utf8");
}

/**
 * 开启 V8 编译缓存：启动时要编译的 JS（dist/src 的数百个模块 + 打包后的
 * main.js）会缓存成字节码，后续启动直接复用。实测可省约 8%~10%。
 * 缓存写在 exe 旁的 runtime\.compile-cache；只读介质上失败时静默降级。
 */
function enableCompileCache() {
  try {
    const { enableCompileCache } = require("node:module");
    if (typeof enableCompileCache !== "function") return;
    const result = enableCompileCache(join(distributionRoot, "runtime", ".compile-cache"));
    if (result && result.status === "FAILED") {
      // 无法写入缓存目录：仅影响下次启动速度，不影响功能。
    }
  } catch {
    // 旧版本 Node 没有该 API，忽略。
  }
}

/**
 * 与 cli.ts 的 cleanup() 保持同一套收尾：仅移除 data 监听不能让进程退出，
 * 流仍停留在 flowing 状态，stdin 句柄会继续持有事件循环，进程从此挂住
 * （界面静止、任何按键都不响应，只能 Ctrl+C 强杀）。
 * 在引导层统一释放一次，避免任何入口漏掉这一步。
 */
function releaseStdin() {
  try {
    const stdin = process.stdin;
    if (!stdin) return;
    if (typeof stdin.pause === "function") stdin.pause();
    if (typeof stdin.unref === "function") stdin.unref();
  } catch {
    // stdin 未初始化（无输入通道）时忽略。
  }
}

async function run() {
  ensureWindowsUtf8Console();
  process.env[CONSOLE_READY_MARKER] = "1";
  enableCompileCache();

  if (!existsSync(cliPath)) {
    throw new Error(`SwarmFlow runtime is missing: ${runtimeRoot}`);
  }

  const userArgs = getUserArguments();
  if (!hasNodeFfi()) {
    relaunchWithNodeFfi(userArgs);
    return;
  }

  // Require before assigning the conventional argv shape so cli.ts does not
  // auto-run while being loaded by this launcher. Node 26 supports requiring
  // this ESM entry and keeps it compatible with the permission-enabled SEA
  // process, whose embedder loader rejects dynamic file:// imports.
  const { main } = runtimeRequire(cliPath);
  process.argv = [process.execPath, cliPath, ...userArgs];
  await main(process.argv);
  releaseStdin();
}

run().catch((error) => {
  console.error("Fatal error:", error);
  process.exitCode = 1;
});
