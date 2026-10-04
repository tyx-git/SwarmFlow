/**
 * 受约束的 jq JSON 查询工具。
 *
 * Windows 发布包优先使用 intools/jq/jq.exe，因而支持完整 jq 语法；
 * 没有随包提供二进制时使用一个覆盖常用字段/数组/管道访问的安全回退，
 * 仍然能避免把整个大 JSON 文件直接塞进上下文。
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ToolDef } from "../providers/base.js";
import { truncateMiddle } from "./shared.js";

const MAX_JSON_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_JSON_OUTPUT_CHARS = 80_000;
const MAX_QUERY_LENGTH = 2_000;

function runJqBinary(
  executable: string,
  args: readonly string[],
  input: string,
  maxBuffer: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let stopped = false;
    const stopForOutput = (): void => {
      if (stopped) return;
      stopped = true;
      child.kill();
      reject(new Error(`jq output exceeded ${maxBuffer} bytes.`));
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes > maxBuffer) {
        stopForOutput();
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => reject(error));
    child.once("close", (code) => {
      if (stopped) return;
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
    "The bundled jq binary is used when available and supports the complete jq language.",
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

function bundledJqPath(): string | null {
  const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleRoot, "intools", "jq", "jq.exe"),
    path.join(moduleRoot, "..", "tools", "intools", "jq", "jq.exe"),
    path.join(process.cwd(), "src", "tools", "intools", "jq", "jq.exe"),
    path.join(process.cwd(), "dist", "src", "tools", "intools", "jq", "jq.exe"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function formatJsonValue(value: unknown, raw: boolean, compact: boolean): string {
  if (raw && typeof value === "string") return value;
  return JSON.stringify(value, null, compact ? undefined : 2);
}

function tokenizePath(pathExpr: string): string[] | null {
  if (!pathExpr.startsWith(".")) return null;
  const tokens: string[] = [];
  let current = "";
  for (let index = 1; index < pathExpr.length; index += 1) {
    const ch = pathExpr[index]!;
    if (ch === "." || ch === "[") {
      if (current) {
        tokens.push(current);
        current = "";
      }
      if (ch === "[") {
        const close = pathExpr.indexOf("]", index + 1);
        if (close < 0) return null;
        const indexToken = pathExpr.slice(index + 1, close);
        if (indexToken === "") tokens.push("[]");
        else if (/^\d+$/.test(indexToken)) tokens.push(`[${indexToken}]`);
        else return null;
        index = close;
      }
      continue;
    }
    if (!/[A-Za-z0-9_$-]/.test(ch)) return null;
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function fallbackStep(values: unknown[], token: string): unknown[] {
  const result: unknown[] = [];
  for (const value of values) {
    if (token === "[]") {
      if (Array.isArray(value)) result.push(...value);
      continue;
    }
    if (/^\[\d+\]$/.test(token)) {
      const index = Number(token.slice(1, -1));
      if (Array.isArray(value) && index < value.length) result.push(value[index]);
      continue;
    }
    if (value !== null && typeof value === "object" && token in value) {
      result.push((value as Record<string, unknown>)[token]);
    }
  }
  return result;
}

function fallbackFilter(value: unknown, query: string): unknown[] {
  const trimmed = query.trim();
  if (trimmed === ".") return [value];
  if (trimmed === "length") {
    return [Array.isArray(value) || typeof value === "string" ? value.length : Object.keys(value as object).length];
  }
  if (trimmed === "keys") {
    return [value !== null && typeof value === "object" ? Object.keys(value as object) : []];
  }
  const selectMatch = /^select\(\.([A-Za-z0-9_$-]+)\s*(==|!=)\s*(["'].*["']|true|false|null)\)$/.exec(trimmed);
  if (selectMatch && value !== null && typeof value === "object") {
    const actual = (value as Record<string, unknown>)[selectMatch[1]!];
    const rawExpected = selectMatch[3]!;
    const expected = rawExpected === "true"
      ? true
      : rawExpected === "false"
        ? false
        : rawExpected === "null"
          ? null
          : rawExpected.slice(1, -1);
    const equal = actual === expected;
    return (selectMatch[2] === "==" ? equal : !equal) ? [value] : [];
  }

  const pipes = trimmed.split("|").map((part) => part.trim()).filter(Boolean);
  let values: unknown[] = [value];
  for (const pipe of pipes) {
    const tokens = tokenizePath(pipe);
    if (!tokens) return [];
    for (const token of tokens) values = fallbackStep(values, token);
  }
  return values;
}

async function readJsonInput(filePath: string | undefined, content: string | undefined): Promise<string> {
  if (filePath && content !== undefined) {
    throw new Error("provide either 'path' or 'content', not both");
  }
  if (filePath) {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
    if (stat.size > MAX_JSON_INPUT_BYTES) throw new Error(`JSON file is too large (limit ${MAX_JSON_INPUT_BYTES} bytes).`);
    return await fs.readFile(filePath, "utf8");
  }
  if (content === undefined) throw new Error("one of 'path' or 'content' is required");
  if (Buffer.byteLength(content, "utf8") > MAX_JSON_INPUT_BYTES) {
    throw new Error(`JSON content is too large (limit ${MAX_JSON_INPUT_BYTES} bytes).`);
  }
  return content;
}

export async function toolJq(options: {
  query: string;
  path?: string;
  content?: string;
  raw: boolean;
  compact: boolean;
  slurp: boolean;
  maxChars: number;
}): Promise<string> {
  const query = options.query.trim();
  if (!query) return "ERROR: jq query must be a non-empty string.";
  if (query.length > MAX_QUERY_LENGTH) return `ERROR: jq query exceeds max length (${MAX_QUERY_LENGTH}).`;

  const input = await readJsonInput(options.path, options.content);
  const jqPath = bundledJqPath();
  let output: string;
  if (jqPath) {
    const args: string[] = [];
    if (options.raw) args.push("-r");
    if (options.compact) args.push("-c");
    if (options.slurp) args.push("-s");
    args.push(query, options.path ?? "-");
    const result = await runJqBinary(
      jqPath,
      args,
      options.path ? "" : input,
      Math.max(options.maxChars * 4, 256_000),
    );
    output = result.stdout;
    if (result.stderr.trim()) output += `\n${result.stderr.trim()}`;
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch (error) {
      throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const values = fallbackFilter(parsed, query);
    output = values.map((value) => formatJsonValue(value, options.raw, options.compact)).join("\n");
  }

  const limit = Math.max(1, options.maxChars);
  return output.length > limit
    ? `${truncateMiddle(output, limit)}\n\n[Output truncated at ${limit} characters. Narrow the jq query.]`
    : output.trimEnd();
}
