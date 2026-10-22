/**
 * jq JSON 查询工具。
 *
 * 只使用随包分发的 intools/jq 原生二进制，不内置 JS 解释器：
 * 一份受限的 JS 回退会静默支持一部分语法、拒绝另一部分，模型无法从结果
 * 判断自己是拿到了真结果还是空结果。二进制缺失时明确报错，让问题可见。
 *
 * 二进制定位有两条路径：源码/dist 运行按模块目录解析；SEA 单文件运行时
 * import.meta.url 指向可执行文件本身，模块目录推导会落空，因此再按
 * process.execPath 的同级目录查找（构建脚本把 intools 放在 exe 旁边）。
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ToolDef } from "../providers/types.js";
import { truncateMiddle } from "./output-truncation.js";

const MAX_JSON_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_JSON_OUTPUT_CHARS = 80_000;
const MAX_QUERY_LENGTH = 2_000;
/** jq 自身没有超时机制，由宿主进程兜底。 */
export const JQ_TIMEOUT_MS = 8_000;

function runJqBinary(
  executable: string,
  args: readonly string[],
  input: string,
  maxBuffer: number,
  signal?: AbortSignal,
  timeoutMs = JQ_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const child = spawn(executable, [...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    function stop(error: Error): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.kill();
      reject(error);
    }
    function onAbort(): void {
      stop(new DOMException("The operation was aborted.", "AbortError"));
    }
    timer = setTimeout(() => {
      stop(new Error(`jq timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes > maxBuffer) {
        stop(new Error(`jq output exceeded ${maxBuffer} bytes.`));
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    // jq 可能在读完 stdin 前因语法错误退出；忽略 stdin 的 EPIPE。
    child.stdin.on("error", () => { /* ignored */ });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `jq exited with code ${code ?? "unknown"}.`));
      } else {
        resolve({ stdout, stderr });
      }
    });
    child.stdin.end(input);
  });
}

export const JQ: ToolDef = {
  name: "jq",
  description:
    "Extract selected fields from a JSON file or JSON text with jq syntax. " +
    "Always provide a focused query such as .items[].name or .config.provider; do not read a large JSON file wholesale. " +
    "Supports the complete jq language via the bundled jq binary. Provide either path or content, not both.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "jq filter, for example .items[] | {id, name} or .providers.openai.models[].id.",
      },
      path: {
        type: "string",
        description: "JSON file to query. Use either path or content.",
      },
      content: {
        type: "string",
        description: "JSON text to query. Use either content or path.",
      },
      raw: {
        type: "boolean",
        description: "Output strings without JSON quotes (-r).",
      },
      compact: {
        type: "boolean",
        description: "Emit compact JSON (-c).",
      },
      slurp: {
        type: "boolean",
        description: "Read all JSON inputs into one array (-s).",
      },
      max_chars: {
        type: "integer",
        description: `Maximum output characters (default ${MAX_JSON_OUTPUT_CHARS}).`,
      },
    },
    required: ["query"],
  },
  summaryTemplate: "{agent} is querying JSON with jq",
  tuiPolicy: { partialReveal: { completeArgs: ["query"] } },
};

/**
 * 定位随包分发的 jq。
 *
 * 只按「模块目录」和「可执行文件同级」解析，绝不回退到 cwd —— 否则用户项目里
 * 的同名 exe 会被当成随包工具执行。
 */
export function bundledJqPath(
  moduleDir: string = path.dirname(fileURLToPath(import.meta.url)),
  execPath: string = process.execPath,
): string | null {
  const binary = process.platform === "win32" ? "jq.exe" : "jq";
  const candidates = [
    // 源码 / dist 运行：二进制与模块在同一棵目录树里
    path.join(moduleDir, "intools", "jq", binary),
    // SEA 单文件：import.meta.url 指向 exe，模块目录推导无效，改按 exe 同级查找
    path.join(path.dirname(execPath), "intools", "jq", binary),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * path 模式只校验文件存在且是普通文件；内容由 jq 自己读取，
 * 避免这里先把最多 50MB 的 JSON 读成字符串再让 jq 读第二遍。
 */
async function validateJsonPath(filePath: string): Promise<void> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
}

async function readJsonContent(content: string | undefined): Promise<string> {
  // 空字符串等于「没提供」：模型常把 schema 里每个可选参数都填上，content 填 ""，
  // 若按 !== undefined 判断会被误判成「同时给了 path 和 content」而必然失败。
  const hasContent = typeof content === "string" && content.trim() !== "";
  if (!hasContent) throw new Error("one of 'path' or 'content' is required");
  if (Buffer.byteLength(content!, "utf8") > MAX_JSON_INPUT_BYTES) {
    throw new Error(`JSON content is too large (limit ${MAX_JSON_INPUT_BYTES} bytes).`);
  }
  return content!;
}

export async function toolJq(options: {
  query: string;
  path?: string;
  content?: string;
  raw: boolean;
  compact: boolean;
  slurp: boolean;
  maxChars: number;
  signal?: AbortSignal;
  /** 测试注入；生产使用 JQ_TIMEOUT_MS。 */
  timeoutMs?: number;
}): Promise<string> {
  const query = options.query.trim();
  if (!query) return "ERROR: jq query must be a non-empty string.";
  if (query.length > MAX_QUERY_LENGTH) return `ERROR: jq query exceeds max length (${MAX_QUERY_LENGTH}).`;

  const jqPath = bundledJqPath();
  if (!jqPath) {
    // 明确失败，不降级：受限回退会让完整语法静默返回空结果，比报错更难排查。
    return (
      "ERROR: bundled jq binary not found. " +
      "Expected intools/jq/jq.exe next to the tool module or next to the executable."
    );
  }

  const hasContent = typeof options.content === "string" && options.content.trim() !== "";
  if (options.path && hasContent) {
    throw new Error("provide either 'path' or 'content', not both");
  }
  let input = "";
  if (options.path) {
    await validateJsonPath(options.path);
  } else {
    input = await readJsonContent(options.content);
  }

  const args: string[] = [];
  if (options.raw) args.push("-r");
  if (options.compact) args.push("-c");
  if (options.slurp) args.push("-s");
  // -- 终止选项解析：以 - 开头的 filter 不能被 jq 当成自身选项。
  args.push("--", query, options.path ?? "-");
  const result = await runJqBinary(
    jqPath,
    args,
    input,
    Math.max(options.maxChars * 4, 256_000),
    options.signal,
    options.timeoutMs,
  );
  let output = result.stdout;
  if (result.stderr.trim()) output += `\n${result.stderr.trim()}`;

  const limit = Math.max(1, options.maxChars);
  return output.length > limit
    ? `${truncateMiddle(output, limit)}\n\n[Output truncated at ${limit} characters. Narrow the jq query.]`
    : output.trimEnd();
}
