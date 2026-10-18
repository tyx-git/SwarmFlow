/** Windows intools 搜索二进制的安全调用层。 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEARCH_OUTPUT_CAP = 60_000;
const SEARCH_TIMEOUT_MS = 15_000;

export interface NativeSearchResult {
  available: boolean;
  content: string;
}

const VALUE_OPTIONS = new Set([
  "-A", "--after-context", "-B", "--before-context", "-C", "--context",
  "-g", "--glob", "--iglob", "-t", "--type", "-T", "--type-not",
  "--type-add", "--type-clear", "--max-depth", "-m", "--max-count",
  "-M", "--max-columns", "-j", "--threads", "--sort", "--sortr",
  "--engine", "--encoding", "--path-separator", "--color", "--colors",
  "--context-separator", "--field-match-separator", "--replace", "-r",
  "--max-filesize", "--max-columns-preview", "--dfa-size-limit", "--regex-size-limit",
  "--max-results", "-d", "--min-depth", "--exact-depth", "-e", "--exclude",
  "-E", "--size", "-S", "--changed-within", "--changed-before", "--format",
  "--ignore-file", "--ignore-contain", "--threads", "--hyperlink",
]);

const FD_VALUE_OPTIONS = new Set([...VALUE_OPTIONS].filter((option) => option !== "-g" && option !== "--glob"));
FD_VALUE_OPTIONS.add("--and");
FD_VALUE_OPTIONS.add("--extension");

const FD_FORBIDDEN = new Set([
  "-x", "--exec", "-X", "--exec-batch", "--search-path", "-C", "--base-directory",
]);

const RG_FORBIDDEN = new Set([
  "-e", "--regexp", "-f", "--file", "--pre", "--config", "--config-path",
  "--search-path", "--no-config",
]);

/**
 * 定位随包分发的搜索二进制。
 *
 * 只按模块目录解析：源码布局命中 `src/tools/intools`，编译布局命中
 * `dist/src/tools/intools`。不再回退到 `process.cwd()`，否则在缺少随包
 * 二进制的安装里可能执行用户项目中的同名文件。
 */
export function resolveBundledSearchExecutable(
  name: "fd" | "rg",
  moduleDir: string = path.dirname(fileURLToPath(import.meta.url)),
): string | null {
  if (process.platform !== "win32") return null;
  const directory = name === "rg" ? "ripgrep" : name;
  const executable = name === "rg" ? "rg.exe" : `${name}.exe`;
  const candidate = path.join(moduleDir, "intools", directory, executable);
  return existsSync(candidate) ? candidate : null;
}

function validateOptions(
  toolName: "fd" | "rg",
  options: readonly string[],
): string | null {
  const forbidden = toolName === "fd" ? FD_FORBIDDEN : RG_FORBIDDEN;
  const valueOptions = toolName === "fd" ? FD_VALUE_OPTIONS : VALUE_OPTIONS;
  let needsValue = false;
  for (const raw of options) {
    const option = raw.split("=", 1)[0]!;
    if (forbidden.has(option)) return `ERROR: ${toolName} option '${option}' is not allowed in this tool.`;
    if (needsValue) {
      needsValue = false;
      if (raw.startsWith("-")) return `ERROR: ${toolName} option is missing its value.`;
      continue;
    }
    if (!raw.startsWith("-") || raw === "--") {
      return `ERROR: ${toolName} options must contain flags and their values only; positional paths are controlled by the tool.`;
    }
    if (!raw.includes("=") && valueOptions.has(option)) needsValue = true;
  }
  return needsValue ? `ERROR: ${toolName} option is missing its value.` : null;
}

function runSearch(
  executable: string,
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
  envOverrides?: NodeJS.ProcessEnv,
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
    }, SEARCH_TIMEOUT_MS);
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
      if (outputChars > SEARCH_OUTPUT_CAP) child.kill();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 10_000) stderr = stderr.slice(-10_000);
    });
    child.once("error", (error) => finish(`ERROR: ${error.message}`));
    child.once("close", (code) => {
      if (timedOut) {
        finish(`${stdout.slice(0, SEARCH_OUTPUT_CAP)}\n\n[Search stopped after ${SEARCH_TIMEOUT_MS}ms.]`);
        return;
      }
      if (signal?.aborted) {
        finish(`${stdout.slice(0, SEARCH_OUTPUT_CAP)}\n\n[Search cancelled.]`);
        return;
      }
      if (outputChars > SEARCH_OUTPUT_CAP) {
        finish(`${stdout.slice(0, SEARCH_OUTPUT_CAP)}\n\n[Output truncated at ${SEARCH_OUTPUT_CAP} characters.]`);
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

export async function runBundledFd(options: {
  pattern: string;
  root: string;
  args: string[];
  absolutePath?: boolean;
  signal?: AbortSignal;
}): Promise<NativeSearchResult> {
  const executable = resolveBundledSearchExecutable("fd");
  if (!executable) return { available: false, content: "" };
  const invalid = validateOptions("fd", options.args);
  if (invalid) return { available: true, content: invalid };
  const pathMode = options.absolutePath === false ? "--relative-path" : "--absolute-path";
  const searchRoot = options.absolutePath === false ? "." : options.root;
  const args = [pathMode, ...options.args, "--color", "never", "--", options.pattern, searchRoot];
  return {
    available: true,
    content: await runSearch(executable, args, options.root, options.signal, { FD_OPTIONS: "" }),
  };
}

export async function runBundledRg(options: {
  patterns: string[];
  root: string;
  args: string[];
  signal?: AbortSignal;
}): Promise<NativeSearchResult> {
  const executable = resolveBundledSearchExecutable("rg");
  if (!executable) return { available: false, content: "" };
  const invalid = validateOptions("rg", options.args);
  if (invalid) return { available: true, content: invalid };
  const rootIsDirectory = statSync(options.root).isDirectory();
  const cwd = rootIsDirectory ? options.root : path.dirname(options.root);
  const target = rootIsDirectory ? "." : path.basename(options.root);
  const args = ["--no-config", ...options.args, "--color", "never"];
  for (const pattern of options.patterns) args.push("-e", pattern);
  args.push(target);
  return {
    available: true,
    content: await runSearch(executable, args, cwd, options.signal, { RIPGREP_CONFIG_PATH: "" }),
  };
}
