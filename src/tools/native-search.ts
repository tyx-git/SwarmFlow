/** Windows intools 搜索二进制的安全调用层。 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SEARCH_BUDGET_MS } from "./limits.js";

const SEARCH_OUTPUT_CAP = 60_000;

export interface NativeSearchResult {
  available: boolean;
  content: string;
}

/**
 * 定位随包分发的搜索二进制。
 *
 * 两条路径：源码/dist 运行按模块目录解析；SEA 单文件运行时 import.meta.url
 * 指向可执行文件本身，模块目录推导会落空，因此再按 process.execPath 的同级
 * 目录查找（构建脚本把 intools 放在 exe 旁边）。
 *
 * 不回退到 `process.cwd()`：否则在缺少随包二进制的安装里可能执行用户项目中
 * 的同名文件。找不到时返回 null，调用方回退到内置 JS 实现。
 */
export function resolveBundledSearchExecutable(
  name: "fd" | "rg",
  moduleDir: string = path.dirname(fileURLToPath(import.meta.url)),
  execPath: string = process.execPath,
): string | null {
  if (process.platform !== "win32") return null;
  const directory = name === "rg" ? "ripgrep" : name;
  const executable = name === "rg" ? "rg.exe" : `${name}.exe`;
  const candidates = [
    path.join(moduleDir, "intools", directory, executable),
    // SEA 单文件：import.meta.url 指向 exe，改按 exe 同级查找
    path.join(path.dirname(execPath), "intools", directory, executable),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function runSearch(
  executable: string,
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
  envOverrides?: NodeJS.ProcessEnv,
  outputCap = SEARCH_OUTPUT_CAP,
): Promise<string> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve("ERROR: Search was cancelled.");
      return;
    }
    const child = spawn(executable, [...args], {
      cwd,
      windowsHide: true,
      env: { ...process.env, ...envOverrides },
      signal,
    });
    let stdout = "";
    let stderr = "";
    let outputChars = 0;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, SEARCH_BUDGET_MS);
    const finish = (content: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(content);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outputChars += chunk.length;
      stdout += chunk;
      if (outputChars > outputCap) child.kill();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 10_000) stderr = stderr.slice(-10_000);
    });
    child.once("error", (error) => finish(`ERROR: ${error.message}`));
    child.once("close", (code) => {
      if (timedOut) {
        finish(`${stdout.slice(0, outputCap)}\n\n[Search stopped after ${SEARCH_BUDGET_MS}ms.]`);
        return;
      }
      if (signal?.aborted) {
        finish(`${stdout.slice(0, outputCap)}\n\n[Search cancelled.]`);
        return;
      }
      if (outputChars > outputCap) {
        finish(`${stdout.slice(0, outputCap)}\n\n[Output truncated at ${outputCap} characters.]`);
        return;
      }
      if (code === 0) {
        finish(stdout.trimEnd() || "No matches found.");
        return;
      }
      if (code === 1) {
        finish(stdout.trimEnd() || "No matches found.");
        return;
      }
      finish(`ERROR: ${stderr.trim() || `${path.basename(executable)} exited with code ${code ?? "unknown"}.`}`);
    });
  });
}

/**
 * options.args 由 basic.ts 的 bundledFdArgs 生成，不是模型直传；
 * 因此这里不再维护一套永远不会触发的选项白名单/黑名单。
 */
export async function runBundledFd(options: {
  pattern: string;
  root: string;
  args: string[];
  absolutePath?: boolean;
  signal?: AbortSignal;
}): Promise<NativeSearchResult> {
  const executable = resolveBundledSearchExecutable("fd");
  if (!executable) return { available: false, content: "" };
  const pathMode = options.absolutePath === false ? "--relative-path" : "--absolute-path";
  const searchRoot = options.absolutePath === false ? "." : options.root;
  const args = [pathMode, ...options.args, "--color", "never", "--", options.pattern, searchRoot];
  return {
    available: true,
    content: await runSearch(executable, args, options.root, options.signal, { FD_OPTIONS: "" }),
  };
}

/** options.args 同样由 bundledRgArgs 生成，不接受模型直传参数。 */
export async function runBundledRg(options: {
  patterns: string[];
  root: string;
  args: string[];
  signal?: AbortSignal;
  /** JSON 事件流需要比最终文本更大的原始预算；最终输出仍由调用方截断。 */
  outputCap?: number;
}): Promise<NativeSearchResult> {
  const executable = resolveBundledSearchExecutable("rg");
  if (!executable) return { available: false, content: "" };
  const rootIsDirectory = statSync(options.root).isDirectory();
  const cwd = rootIsDirectory ? options.root : path.dirname(options.root);
  // 用绝对路径作为搜索目标，让 rg 输出绝对路径，与内置 JS 实现一致。
  // rg 没有 --absolute-path，若传 "." 会输出 `.\a.ts` 这类相对路径，
  // 模型拿它去 read_file 会基于错误的工作目录解析。
  const target = options.root;
  const args = ["--no-config", ...options.args, "--color", "never"];
  for (const pattern of options.patterns) args.push("-e", pattern);
  args.push(target);
  return {
    available: true,
    content: await runSearch(executable, args, cwd, options.signal, { RIPGREP_CONFIG_PATH: "" }, options.outputCap),
  };
}
