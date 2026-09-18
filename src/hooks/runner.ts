/**
 * 钩子命令运行器。
 *
 * 生成钩子命令，将事件负载作为 JSON 写入 stdin，
 * 从 stdout 读取 JSON 输出，执行超时限制。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { osCapabilities } from "../platform/index.js";
import type { HookManifest, HookPayload, HookOutput } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface HookRunResult {
  success: boolean;
  output: HookOutput;
  error?: string;
  durationMs: number;
}

/**
 * 执行一个钩子命令并解析其 JSON 输出。
 */
export async function runHookCommand(
  manifest: HookManifest,
  payload: HookPayload,
): Promise<HookRunResult> {
  const startMs = Date.now();
  const timeoutMs = manifest.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<HookRunResult>((resolve) => {
    const env: Record<string, string | undefined> = { ...process.env, ...manifest.env };
    let child: ChildProcess;
    try {
      // 仅在真正需要时才通过 cmd.exe 路由。带有显式本机可执行文件扩展名
      //（.exe/.com）的命令会在每个平台上直接生成（argv 数组，无 shell）；
      // cmd 重新解析会破坏包含其元字符的参数（`&`, `|`, `<`, `>`, `%VAR%`），
      // 这会让 `node.exe ... R&D` 这样的本机钩子退化。只有裸名称和
      // .cmd/.bat 垫片（npm/npx/prettier）需要 shell：裸 exec 无法启动
      // .cmd 垫片，现代 Node 会为此抛出 EINVAL。
      const isNativeExe = /\.(exe|com)$/i.test(manifest.command);
      if (osCapabilities.scriptShimsRequireShell && !isNativeExe) {
        // 将每个 token 预引用为一条命令行，这样带空格的路径
        //（C:\Program Files\...）不会被分割，且 cmd 元字符
        // 受保护：双引号内 cmd 将 &, |, <, >, (, )
        // 作为字面量。（%VAR% 即使在引号内仍会展开 — 固有的
        // cmd /c 限制；上面的本机 .exe 钩子完全避免 cmd。）
        const quote = (s: string) =>
          /[\s"&|<>()^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        const commandLine = [manifest.command, ...(manifest.args ?? [])].map(quote).join(" ");
        child = spawn(commandLine, {
          shell: true,
          env,
          cwd: process.cwd(),
          stdio: ["pipe", "pipe", "pipe"],
          timeout: timeoutMs,
          // shell:true 启动 cmd.exe（控制台子系统程序）。在 GUI/服务器模式下，
          // 父进程没有继承的控制台，因此 Windows 会为每个子进程分配新的
          // 控制台窗口，并在每次钩子触发时闪烁黑框（PreToolUse/PostToolUse
          // 在每次工具调用时运行）。隐藏它，与其他所有 win32 生成一致。
          windowsHide: true,
        });
      } else {
        child = spawn(manifest.command, manifest.args ?? [], {
          env,
          cwd: process.cwd(),
          stdio: ["pipe", "pipe", "pipe"],
          timeout: timeoutMs,
        });
      }
    } catch (e) {
      resolve({
        success: false,
        output: {},
        error: `Failed to spawn: ${e instanceof Error ? e.message : String(e)}`,
        durationMs: Date.now() - startMs,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (result: HookRunResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    });

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* 尽力而为 */ }
      settle({
        success: false,
        output: {},
        error: `Hook "${manifest.name}" timed out after ${timeoutMs}ms`,
        durationMs: Date.now() - startMs,
      });
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startMs;

      if (code !== 0) {
        settle({
          success: false,
          output: {},
          error: `Hook "${manifest.name}" exited with code ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}`,
          durationMs,
        });
        return;
      }

      const trimmed = stdout.trim();
      if (!trimmed) {
        settle({ success: true, output: {}, durationMs });
        return;
      }

      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const output: HookOutput = {};

        if (parsed["decision"] === "allow" || parsed["decision"] === "deny") {
          output.decision = parsed["decision"] as "allow" | "deny";
        }
        if (typeof parsed["updatedInput"] === "object" && parsed["updatedInput"] !== null) {
          output.updatedInput = parsed["updatedInput"] as Record<string, unknown>;
        }
        if (typeof parsed["additionalContext"] === "string") {
          output.additionalContext = parsed["additionalContext"];
        }
        if (typeof parsed["reason"] === "string") {
          output.reason = parsed["reason"];
        }

        settle({ success: true, output, durationMs });
      } catch {
        settle({
          success: false,
          output: {},
          error: `Hook "${manifest.name}" returned invalid JSON: ${trimmed.slice(0, 100)}`,
          durationMs,
        });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      settle({
        success: false,
        output: {},
        error: `Hook "${manifest.name}" error: ${err.message}`,
        durationMs: Date.now() - startMs,
      });
    });

    // 将负载写入 stdin
    try {
      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    } catch {
      // 如果进程立即退出，stdin 可能已经关闭
    }
  });
}
