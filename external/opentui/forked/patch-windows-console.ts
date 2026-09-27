// @ts-nocheck
/**
 * Windows 控制台退出清理：关掉鼠标追踪 + 清空内核输入缓冲。
 *
 * 症状（用户实录）：
 *   PS F:\Project> [1M[555;90;1M[555;89;1M[555;89;2M[555;88;4M...
 *   —— 退出到 PowerShell 后，鼠标每动一下就吐一串 ESC 序列，只能关终端。
 *
 *   这些是 SGR-Pixels 鼠标报告 `\x1b[<Cb;Cx;CyM`（像素坐标 + 按键位图），
 *   也就是说终端退出后 **?1003/?1002/?1016 仍然开着**。
 *
 * 已有防线为什么不够：
 *   1. renderer.resetMouseTracking() 会写 `\x1b[?1003l\x1b[?1002l\x1b[?1006l
 *      \x1b[?1016l\x1b[?1000l`，但它有早退守卫
 *      `if (!this._useMouse && !this._sgrPixelsActive) return`。
 *   2. main.tsx 的 30ms + `while (process.stdin.read() !== null)` 只能抽干
 *      **Node 自己**的 readable 队列；Windows 上还没被 libuv 读上来、仍停在
 *      **ConHost 输入缓冲**里的事件完全没被处理 —— `renderer.ts` 注释里说的
 *      "the real long-term fix would be a libc tcflush(STDIN_FILENO, TCIFLUSH)"
 *      正是这个缺口。
 *   3. `setRawMode(false)` 恢复的是进入 raw 模式时保存的 console mode，
 *      之后通过 `\x1b[?1002h` 开启的 ENABLE_MOUSE_INPUT 不一定被清掉。
 *
 * 这里做三件事，全部幂等、可重复调用、失败只静默降级：
 *   a. 直接向 fd 1 写全套鼠标模式复位序列（绕开一切上层缓冲）
 *   b. 用 kernel32 SetConsoleMode 清掉 ENABLE_MOUSE_INPUT —— Windows 上
 *      这才是权威开关，不依赖终端是否"听话"
 *   c. FlushConsoleInputBuffer 把 ConHost 输入缓冲里残留的报告全部丢掉
 *   最后恢复光标显示。
 *
 * node:ffi 的定义键是 `arguments` / `return`（`args` / `returns` 是 opentui
 * 自己归一化的写法，直接传给 node:ffi 会被静默忽略 —— 实测表现为
 * "Invalid argument count: expected 0, got 1"）。exe 启动时已带
 * `--experimental-ffi`（sea-bootstrap.cjs 靠它拉起 node:ffi），可直接用。
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { writeOpenTuiDiag } from "./core/lib/diagnostic.js";

const requireModule = createRequire(import.meta.url);

const MOUSE_RESET_SEQUENCE = "\x1b[?1003l\x1b[?1002l\x1b[?1006l\x1b[?1016l\x1b[?1000l";
const SHOW_CURSOR = "\x1b[?25h";
/** GetStdHandle(STD_INPUT_HANDLE) —— 传无符号值，JS 侧自己用 0xFFFFFFF6。 */
const STD_INPUT_HANDLE = 0xfffffff6;
/** ENABLE_MOUSE_INPUT */
const ENABLE_MOUSE_INPUT = 0x0010;

let restored = false;
let installed = false;

/** 用最原始的方式把字节写进控制台，绕开一切上层缓冲。 */
function rawWrite(bytes: string): void {
  try {
    writeFileSync(1, bytes, "utf8");
  } catch {
    // fd 1 不可写（被重定向/已关闭）时安静退出
  }
}

function openKernel32(): { symbols: Record<string, (...args: any[]) => any> } | null {
  try {
    const ffi = requireModule("node:ffi") as {
      dlopen?: (path: string, symbols: Record<string, unknown>) => {
        functions: Record<string, (...args: any[]) => any>;
      };
    };
    if (typeof ffi?.dlopen !== "function") return null;
    return ffi.dlopen("kernel32.dll", {
      GetStdHandle: { arguments: ["u32"], return: "ptr" },
      GetConsoleMode: { arguments: ["ptr", "ptr"], return: "bool" },
      SetConsoleMode: { arguments: ["ptr", "u32"], return: "bool" },
      FlushConsoleInputBuffer: { arguments: ["ptr"], return: "bool" },
    });
  } catch {
    // FFI 不可用（未带 --experimental-ffi 等）时不影响其他清理动作
    return null;
  }
}

/**
 * 无条件恢复终端状态。幂等，可重复调用。
 *
 * 顺序有讲究：先让终端停止上报（reset），再清掉 ENABLE_MOUSE_INPUT 并抽干
 * 缓冲，最后恢复光标。反过来做的话，先 flush 再关模式，关之前到达的报告
 * 仍会被 cooked 模式的 shell 当成普通字节读走并打印。
 */
export function restoreConsoleState(): void {
  if (restored) return;
  restored = true;

  rawWrite(MOUSE_RESET_SEQUENCE);

  try {
    const kernel32 = openKernel32();
    if (kernel32) {
      const handle = kernel32.symbols.GetStdHandle(STD_INPUT_HANDLE);
      if (handle && handle !== 0n) {
        const modeBuf = new BigUint64Array(1);
        if (kernel32.symbols.GetConsoleMode(handle, modeBuf)) {
          const cleaned = Number(modeBuf[0]) & ~ENABLE_MOUSE_INPUT;
          kernel32.symbols.SetConsoleMode(handle, cleaned);
        }
        kernel32.symbols.FlushConsoleInputBuffer(handle);
      }
    }
  } catch {
    // 失败不影响其余清理
  }

  rawWrite(SHOW_CURSOR);
}

/**
 * 装上退出兜底。显式退出流程仍应直接调用 restoreConsoleState()（那样能在
 * process.exit 之前同步完成），这里的 exit 钩子只兜住漏网的路径。
 */
export function installConsoleCleanupHooks(): void {
  if (installed) return;
  installed = true;

  process.on("exit", (code) => {
    try {
      restoreConsoleState();
      // 用来判断进程到底是"走到了 JS 退出流程"还是"被硬杀"：
      // 若用户复现后看不到这条事件，说明清理代码根本没机会跑。
      writeOpenTuiDiag("console.cleanup.on_exit", { code });
    } catch {
      // ignore
    }
  });
}
