/**
 * 内置工具定义和执行器。
 *
 * 包含文件读取、目录/内容/符号搜索、文件修改、shell 和网络工具：
 * read_file、list_dir、glob、grep、find_symbol、edit_file、write_file、
 * bash、bash_background、kill_shell、
 * time、web_search、web_fetch。
 */

import fs from "node:fs/promises";
import { rmSync } from "node:fs";

import path from "node:path";

import { shell } from "../platform/index.js";

import { ToolResult } from "../providers/response.js";
import type { ToolExecutor } from "./executor-types.js";
import { SafePathError } from "../security/path.js";
import { getSensitiveFileReadReason } from "../security/sensitive-files.js";
import { toolBuiltinWebSearchPassthrough, toolWebSearch } from "./web-search/tool.js";
import { toolWebFetch } from "./web-fetch.js";

import { toolFindSymbol, type SymbolKind } from "./symbol-search.js";
import { toolJq } from "./json-query.js";

import { AdoptShellFn } from "./bash.js";
import { BashMutationEntry, BashMutation } from "./mutations.js";
import { toolGlob } from "./glob.js";
import { toolGrep } from "./grep.js";
import { GLOB_DEFAULT_LIMIT, SEARCH_DEFAULT_PER_FILE_LIMIT, SEARCH_MAX_DEPTH } from "./limits.js";
import {
  ToolArgValidationError,
  expectArgsObject,
  requiredPathArg,
  optionalPositiveIntegerArg,
  optionalIntegerArg,
  optionalPathArg,
  optionalStringArg,
  requiredStringArg,
  requiredIntegerArg,
  requiredStringList,
} from "./arg-validation.js";
import { scopedPath, toolRoot } from "./path-scoping.js";
import { toolReadFile } from "./file-read.js";
import { toolListDir } from "./file-list.js";
import { toolEditFileAppend, toolEditFileMulti } from "./file-edit.js";
import { toolWriteFile } from "./file-write.js";
import {
  splitCompoundBash,
  BashPreExecState,
  extractCdTargetForBash,
  prepareBashPreExec,
  recordBashPostExec,
} from "./mutations.js";
import { toolBash, toolTime } from "./bash.js";

// ------------------------------------------------------------------
// 文件变更追踪（用于回滚文件还原）
// ------------------------------------------------------------------

export interface ExecuteToolContext {
  projectRoot?: string;
  externalPathAllowlist?: string[];
  sessionArtifactsDir?: string;
  supportsMultimodal?: boolean;
  signal?: AbortSignal;
  /**
   * 当存在时，超时的同步 bash 命令会被移动到
   * 被追踪的后台 shell，而不是被杀死。
   */
  adoptShell?: AdoptShellFn;
  /**
   * 本会话是否拥有某个工具。读日志统一走 read_file；
   * 该谓词只用于决定是否点名 await_event / kill_shell。
   */
  hasTools?: (name: string) => boolean;
}

export function formatToolError(toolName: string, err: unknown): string {
  if (err instanceof ToolArgValidationError) {
    return `ERROR: Invalid arguments for ${toolName}: ${err.message}`;
  }
  if (err instanceof SafePathError) {
    const p = err.details.resolvedPath || err.details.requestedPath;
    switch (err.code) {
      case "PATH_OUTSIDE_SCOPE":
        return `ERROR: ${toolName} path is outside the project root boundary: ${err.details.requestedPath}`;
      case "PATH_SYMLINK_ESCAPES_SCOPE":
        return `ERROR: ${toolName} path escapes the project root via a symbolic link: ${err.details.requestedPath}`;
      case "PATH_NOT_FOUND":
        return `ERROR: Path not found: ${p}`;
      case "PATH_NOT_FILE":
        return `ERROR: Not a file: ${p}`;
      case "PATH_NOT_DIRECTORY":
        return `ERROR: Not a directory: ${p}`;
      case "PATH_INVALID_INPUT":
        return `ERROR: ${err.message}`;
      default:
        return `ERROR: ${err.message}`;
    }
  }
  return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
}

export function createDispatch(ctx?: ExecuteToolContext): Record<string, ToolExecutor> {
  return {
    read_file: (args) => {
      try {
        const a = expectArgsObject("read_file", args);
        const requestedPath = requiredPathArg("read_file", a, "path", { nonEmpty: true });
        let startLine = optionalPositiveIntegerArg("read_file", a, "start_line");
        let endLine = optionalIntegerArg("read_file", a, "end_line");
        const offset = optionalPositiveIntegerArg("read_file", a, "offset");
        const limit = optionalPositiveIntegerArg("read_file", a, "limit");
        const maxLineChars = optionalPositiveIntegerArg("read_file", a, "max_line_chars");
        const tailLines = optionalPositiveIntegerArg("read_file", a, "tail_lines");
        // offset is an alias for start_line; limit converts to end_line.
        if (startLine == null && offset != null) startLine = offset;
        if (endLine == null && limit != null) {
          const effectiveStart = startLine ?? 1;
          endLine = effectiveStart + Math.max(0, limit - 1);
        }
        const filePath = scopedPath(
          requestedPath,
          "read",
          ctx,
          { mustExist: true, expectFile: true },
        );
        return toolReadFile(
          filePath,
          startLine,
          endLine,
          ctx?.sessionArtifactsDir,
          ctx?.supportsMultimodal,
          maxLineChars,
          tailLines,
        );
      } catch (e) {
        return formatToolError("read_file", e);
      }
    },
    list_dir: async (args) => {
      try {
        const a = expectArgsObject("list_dir", args);
        const requestedPath = optionalPathArg("list_dir", a, "path", ".");
        const maxDepth = optionalPositiveIntegerArg("list_dir", a, "max_depth");
        const maxEntries = optionalPositiveIntegerArg("list_dir", a, "max_entries");
        const includeHidden = a["include_hidden"] === true;
        const dirPath = scopedPath(
          requestedPath,
          "list",
          ctx,
          { mustExist: true, expectDirectory: true },
        );
        return await toolListDir(dirPath, { maxDepth, maxEntries, includeHidden });
      } catch (e) {
        return formatToolError("list_dir", e);
      }
    },
    edit_file: (args) => {
      try {
        const a = expectArgsObject("edit_file", args);
        const requestedPath = requiredPathArg("edit_file", a, "path", { nonEmpty: true });
        const expectedMtimeMs = optionalIntegerArg("edit_file", a, "expected_mtime_ms");
        const appendStr = optionalStringArg("edit_file", a, "append_str", "");
        const editsRaw = a.edits;

        // Validate edits array
        const edits: Array<{ old_str: string; new_str: string; replace_all?: boolean }> = [];
        if (Array.isArray(editsRaw)) {
          for (const item of editsRaw) {
            if (!item || typeof item !== "object") {
              return "ERROR: Each item in edits must be an object with old_str and new_str.";
            }
            const obj = item as Record<string, unknown>;
            if (typeof obj.old_str !== "string" || !obj.old_str) {
              return "ERROR: Each item in edits must have a non-empty old_str.";
            }
            if (typeof obj.new_str !== "string") {
              return "ERROR: Each item in edits must have a new_str.";
            }
            edits.push({
              old_str: obj.old_str,
              new_str: obj.new_str,
              replace_all: obj.replace_all === true,
            });
          }
          if (edits.length === 0) {
            return "ERROR: edits array must not be empty.";
          }
        }

        if (edits.length === 0 && !appendStr) {
          return "ERROR: edit_file requires edits array and/or append_str.";
        }

        const filePath = scopedPath(
          requestedPath,
          "write",
          ctx,
          { mustExist: true, expectFile: true },
        );

        // Append-only (no replacements)
        if (edits.length === 0) {
          return toolEditFileAppend(filePath, appendStr, expectedMtimeMs);
        }

        // Edits (possibly combined with append)
        return toolEditFileMulti(filePath, edits, expectedMtimeMs, appendStr || undefined);
      } catch (e) {
        return formatToolError("edit_file", e);
      }
    },
    write_file: (args) => {
      try {
        const a = expectArgsObject("write_file", args);
        const requestedPath = requiredPathArg("write_file", a, "path", { nonEmpty: true });
        const content = requiredStringArg("write_file", a, "content");
        const expectedMtimeMs = optionalIntegerArg("write_file", a, "expected_mtime_ms");
        const filePath = scopedPath(
          requestedPath,
          "write",
          ctx,
          { allowCreate: true, expectFile: true },
        );
        return toolWriteFile(filePath, content, expectedMtimeMs);
      } catch (e) {
        return formatToolError("write_file", e);
      }
    },
    bash: async (args, rtCtx) => {
      try {
        const a = expectArgsObject("bash", args);
        const command = requiredStringArg("bash", a, "command", { nonEmpty: true, maxLen: 20_000 });
        const timeout = requiredIntegerArg("bash", a, "timeout");
        const cwdArg = optionalPathArg("bash", a, "cwd", "");
        let cwd = "";
        if (cwdArg.trim()) {
          cwd = scopedPath(
            cwdArg,
            "list",
            ctx,
            { mustExist: true, expectDirectory: true },
          );
        }

        const effectiveCwd = cwd || toolRoot(ctx);
        const backupsDir = path.join(ctx?.sessionArtifactsDir ?? effectiveCwd, "rewind-backups");

        // Pre-exec: detect tracked commands and snapshot state.
        // cd-aware: track effectiveCwd through cd segments so mutation
        // paths resolve correctly. External paths skip tracking.
        const segments = splitCompoundBash(command);
        const preExecStates: Array<{ segmentIndex: number; state: BashPreExecState }> = [];
        const projectRoot = ctx?.projectRoot ?? effectiveCwd;
        {
          let segmentCwd = effectiveCwd;
          for (let i = 0; i < segments.length; i++) {
            const cdTarget = extractCdTargetForBash(segments[i]!);
            if (cdTarget !== null) {
              segmentCwd = path.isAbsolute(cdTarget)
                ? path.resolve(cdTarget)
                : path.resolve(segmentCwd, cdTarget);
              continue;
            }
            // Skip mutation tracking for external paths
            const rel = path.relative(projectRoot, segmentCwd);
            if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
            const state = prepareBashPreExec(segments[i]!, backupsDir, segmentCwd);
            if (state) preExecStates.push({ segmentIndex: i, state });
          }
        }

        const output = await toolBash(command, timeout, cwd, {
          signal: rtCtx?.signal,
          spillDir: ctx?.sessionArtifactsDir,
          adoptShell: ctx?.adoptShell,
          hasTools: ctx?.hasTools,
        });

        // Post-exec: only record mutations if command succeeded (exit code 0).
        // A timeout hand-off counts as not-finished: the command is still
        // running, so its mutations cannot be snapshotted for rewind.
        const isError = output.startsWith("ERROR:") || output.startsWith("MOVED TO BACKGROUND:");
        if (!isError && preExecStates.length > 0) {
          const entries: BashMutationEntry[] = [];
          for (const { state } of preExecStates) {
            const entry = recordBashPostExec(state);
            if (entry) entries.push(entry);
          }
          if (entries.length > 0) {
            const mutation: BashMutation = { command, entries };
            return new ToolResult({
              content: output,
              metadata: { bashMutation: mutation },
            });
          }
        }

        // Clean up backups if command failed
        if (isError) {
          for (const { state } of preExecStates) {
            if (state.backupPath) {
              try { rmSync(state.backupPath, { recursive: true, force: true }); } catch { /* ignore */ }
            }
          }
        }

        return output;
      } catch (e) {
        return formatToolError("bash", e);
      }
    },
    time: (args) => {
      try {
        expectArgsObject("time", args);
        return toolTime();
      } catch (e) {
        return formatToolError("time", e);
      }
    },
    glob: async (args) => {
      try {
        const a = expectArgsObject("glob", args);
        const pattern = requiredStringArg("glob", a, "pattern", { nonEmpty: true });
        if (a["regex"] === true) {
          try {
            new RegExp(pattern, a["case_insensitive"] === true ? "i" : undefined);
          } catch (error) {
            throw new ToolArgValidationError("glob", "pattern", `invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const requestedPath = optionalPathArg("glob", a, "path", ".");
        const limit = optionalPositiveIntegerArg("glob", a, "limit")
          ?? optionalPositiveIntegerArg("glob", a, "max_results")
          ?? GLOB_DEFAULT_LIMIT;
        const type = requiredStringList("glob", a, "type");
        const extensions = requiredStringList("glob", a, "extension");
        const andPatterns = requiredStringList("glob", a, "and");
        const excludes = requiredStringList("glob", a, "exclude");
        const maxDepth = optionalIntegerArg("glob", a, "max_depth");
        const minDepth = optionalIntegerArg("glob", a, "min_depth");
        const exactDepth = optionalIntegerArg("glob", a, "exact_depth");
        for (const [key, value] of [["max_depth", maxDepth], ["min_depth", minDepth], ["exact_depth", exactDepth]] as const) {
          if (value !== undefined && value < 0) {
            throw new ToolArgValidationError("glob", key, `'${key}' must be >= 0.`);
          }
        }
        if (minDepth !== undefined && exactDepth !== undefined && minDepth !== exactDepth) {
          throw new ToolArgValidationError("glob", "exact_depth", "'exact_depth' cannot be combined with a different 'min_depth'.");
        }
        const globPath = scopedPath(
          requestedPath,
          "search",
          ctx,
          { mustExist: true, expectDirectory: true },
        );
        return await toolGlob(pattern, globPath, {
          limit,
          ignoreRoot: ctx?.projectRoot,
          andPatterns: andPatterns.length > 0 ? andPatterns : undefined,
          excludes: excludes.length > 0 ? excludes : undefined,
          type: type.length > 0 ? type : undefined,
          extensions: extensions.length > 0 ? extensions : undefined,
          regex: a["regex"] === true,
          fixedStrings: a["fixed_strings"] === true,
          caseInsensitive: typeof a["case_insensitive"] === "boolean" ? a["case_insensitive"] as boolean : undefined,
          fullPath: a["full_path"] === true,
          absolutePath: a["absolute_path"] !== false,
          includeHidden: a["include_hidden"] === true,
          noIgnore: a["no_ignore"] === true,
          follow: a["follow"] === true,
          maxDepth,
          minDepth,
          exactDepth,
        });
      } catch (e) {
        return formatToolError("glob", e);
      }
    },
    grep: async (args, rtCtx) => {
      try {
        const a = expectArgsObject("grep", args);

        // pattern: accept string | string[]
        const patternRaw = a["pattern"];
        let patterns: string[];
        if (typeof patternRaw === "string") {
          if (!patternRaw.trim()) {
            return "ERROR: Invalid arguments for grep: 'pattern' must be a non-empty string.";
          }
          patterns = [patternRaw];
        } else if (Array.isArray(patternRaw)) {
          if (patternRaw.length === 0) {
            return "ERROR: Invalid arguments for grep: 'pattern' array must not be empty.";
          }
          patterns = patternRaw.map((p, idx) => {
            if (typeof p !== "string") {
              throw new ToolArgValidationError("grep", `pattern[${idx}]`, `pattern[${idx}] must be a string.`);
            }
            return p;
          });
        } else {
          return "ERROR: Invalid arguments for grep: 'pattern' must be a string or array of strings.";
        }

        const requestedPath = optionalPathArg("grep", a, "path", ".");
        const searchPath = scopedPath(
          requestedPath,
          "search",
          ctx,
          { mustExist: true },
        );
        const globFilter = requiredStringList("grep", a, "glob");
        const fileType = requiredStringList("grep", a, "type");
        const outputMode = optionalStringArg("grep", a, "output_mode", "files_with_matches") as "content" | "files_with_matches" | "count";
        if (!["content", "files_with_matches", "count"].includes(outputMode)) {
          throw new ToolArgValidationError("grep", "output_mode", "'output_mode' must be content, files_with_matches, or count.");
        }

        // Context-line aliases: prefer hyphen forms (Cursor convention) but
        // accept word forms because some LLMs translate them automatically.
        const afterCtx =
          optionalIntegerArg("grep", a, "-A") ??
          optionalIntegerArg("grep", a, "after_lines") ?? 0;
        const beforeCtx =
          optionalIntegerArg("grep", a, "-B") ??
          optionalIntegerArg("grep", a, "before_lines") ?? 0;
        const contextCtx =
          optionalIntegerArg("grep", a, "-C") ??
          optionalIntegerArg("grep", a, "context_lines") ?? 0;

        // Smart case: undefined when neither flag is passed (auto), explicit otherwise.
        let caseInsensitive: boolean | undefined;
        if (a["-i"] !== undefined) caseInsensitive = a["-i"] === true;
        else if (a["case_insensitive"] !== undefined) caseInsensitive = a["case_insensitive"] === true;

        const showLineNumbers = a["-n"] !== false && a["line_numbers"] !== false;
        const headLimit = optionalPositiveIntegerArg("grep", a, "head_limit") ?? 0;
        const perFileLimit =
          optionalPositiveIntegerArg("grep", a, "limit_per_file") ?? SEARCH_DEFAULT_PER_FILE_LIMIT;
        const maxDepthArg = optionalIntegerArg("grep", a, "max_depth");
        if (maxDepthArg !== undefined && maxDepthArg < 0) {
          throw new ToolArgValidationError("grep", "max_depth", "'max_depth' must be >= 0.");
        }
        const maxDepth = maxDepthArg ?? SEARCH_MAX_DEPTH;
        const maxCount = optionalPositiveIntegerArg("grep", a, "max_count") ?? 0;
        const sort = optionalStringArg("grep", a, "sort", "none");
        if (sort !== "none" && sort !== "path" && sort !== "modified") {
          throw new ToolArgValidationError("grep", "sort", "'sort' must be none, path, or modified.");
        }

        return await toolGrep(patterns, searchPath, {
          glob: globFilter.length > 0 ? globFilter : undefined,
          fileType: fileType.length > 0 ? fileType : undefined,
          // 默认优先随包 rg；useNative:false 仅用于测试强制 JS 回退。
          ignoreRoot: ctx?.projectRoot,
          outputMode,
          afterContext: contextCtx > 0 ? contextCtx : afterCtx,
          beforeContext: contextCtx > 0 ? contextCtx : beforeCtx,
          caseInsensitive,
          showLineNumbers,
          headLimit,
          perFileLimit,
          fixedStrings: a["fixed_strings"] === true,
          wordRegexp: a["word_regexp"] === true,
          lineRegexp: a["line_regexp"] === true,
          multiline: a["multiline"] === true,
          hidden: a["hidden"] === true,
          noIgnore: a["no_ignore"] === true,
          follow: a["follow"] === true,
          maxDepth,
          maxCount,
          invertMatch: a["invert_match"] === true,
          onlyMatching: a["only_matching"] === true,
          countMatches: a["count_matches"] === true,
          includeZero: a["include_zero"] === true,
          text: a["text"] === true,
          sort: sort as "path" | "modified" | "none",
          signal: rtCtx?.signal,
        });
      } catch (e) {
        return formatToolError("grep", e);
      }
    },
    find_symbol: async (args, rtCtx) => {
      try {
        const a = expectArgsObject("find_symbol", args);
        const query = requiredStringArg("find_symbol", a, "query", { maxLen: 200 });
        const requestedPath = optionalPathArg("find_symbol", a, "path", ".");
        const searchPath = scopedPath(
          requestedPath,
          "search",
          ctx,
          { mustExist: true },
        );
        const language = optionalStringArg("find_symbol", a, "language", "");
        const kindRaw = optionalStringArg("find_symbol", a, "kind", "function");
        const validKinds = new Set<SymbolKind>([
          "function", "method", "class", "interface", "type", "variable",
          "struct", "trait", "enum", "any",
        ]);
        if (!validKinds.has(kindRaw as SymbolKind)) {
          throw new ToolArgValidationError(
            "find_symbol",
            "kind",
            `'kind' must be one of ${[...validKinds].join(", ")}.`,
          );
        }
        const include = optionalStringArg("find_symbol", a, "include", "");
        const caseInsensitive = a["case_insensitive"] === true;
        const hidden = a["hidden"] === true;
        const noIgnore = a["no_ignore"] === true;
        const follow = a["follow"] === true;
        const maxResults = optionalPositiveIntegerArg("find_symbol", a, "max_results") ?? 200;
        return await toolFindSymbol({
          query,
          path: searchPath,
          language: language || undefined,
          kind: kindRaw as SymbolKind,
          include: include || undefined,
          caseInsensitive,
          hidden,
          noIgnore,
          follow,
          maxResults: Math.min(maxResults, 200),
          signal: rtCtx?.signal,
        });
      } catch (e) {
        return formatToolError("find_symbol", e);
      }
    },
    jq: async (args, rtCtx) => {
      try {
        const a = expectArgsObject("jq", args);
        const query = requiredStringArg("jq", a, "query", { nonEmpty: true, maxLen: 2_000 });
        const requestedPath = optionalPathArg("jq", a, "path", "");
        const contentRaw = a["content"];
        if (contentRaw !== undefined && typeof contentRaw !== "string") {
          throw new ToolArgValidationError("jq", "content", "'content' must be a string.");
        }
        // 空字符串按「未提供」处理：模型常把 schema 里每个可选参数都填满，
        // content 填 ""，若只看 !== undefined 会与 path 冲突，导致 jq 必然失败。
        const content = typeof contentRaw === "string" && contentRaw.trim() !== "" ? contentRaw : undefined;
        if (!requestedPath && content === undefined) {
          throw new ToolArgValidationError("jq", "path", "one of 'path' or 'content' is required.");
        }
        const filePath = requestedPath
          ? scopedPath(requestedPath, "read", ctx, { mustExist: true, expectFile: true })
          : undefined;
        if (filePath) {
          const sensitiveReason = getSensitiveFileReadReason(filePath);
          if (sensitiveReason) {
            return `ERROR: Access to sensitive file is blocked by default: ${filePath} (${sensitiveReason}).`;
          }
        }
        const maxChars = optionalPositiveIntegerArg("jq", a, "max_chars") ?? 80_000;
        return await toolJq({
          query,
          path: filePath,
          content,
          raw: a["raw"] === true,
          compact: a["compact"] === true,
          slurp: a["slurp"] === true,
          maxChars: Math.min(maxChars, 80_000),
          signal: rtCtx?.signal,
        });
      } catch (e) {
        return formatToolError("jq", e);
      }
    },
    web_search: async (args, rtCtx) => {
      try {
        const a = expectArgsObject("web_search", args);
        const query = requiredStringArg("web_search", a, "query", { nonEmpty: true });
        const numResults = typeof a["num_results"] === "number" ? a["num_results"] : undefined;
        return toolWebSearch(query, numResults, { signal: rtCtx?.signal });
      } catch (e) {
        return formatToolError("web_search", e);
      }
    },
    web_fetch: async (args, rtCtx) => {
      try {
        const a = expectArgsObject("web_fetch", args);
        const url = requiredStringArg("web_fetch", a, "url", { nonEmpty: true });
        const prompt = optionalStringArg("web_fetch", a, "prompt", "");
        return toolWebFetch(url, prompt || undefined, { signal: rtCtx?.signal });
      } catch (e) {
        return formatToolError("web_fetch", e);
      }
    },
    $web_search: (args) => toolBuiltinWebSearchPassthrough(args as Record<string, unknown>),
  };
}

/**
 * 按名称执行工具并返回 `ToolResult`。
 *
 * 工具函数可以返回纯 `string`（自动包装）或带有可选操作提示、
 * 标签和元数据的 `ToolResult`。
 *
 * `ctx.signal`（可选）被提取出来作为按调用运行的运行时上下文传递给执行器；
 * 其余字段由调度闭包捕获为静态配置。
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx?: ExecuteToolContext,
): Promise<ToolResult> {
  const fn = createDispatch(ctx)[name];
  if (!fn) {
    return new ToolResult({ content: `ERROR: Unknown tool '${name}'` });
  }
  try {
    const raw = await fn(args, { signal: ctx?.signal });
    if (raw instanceof ToolResult) {
      return raw;
    }
    return new ToolResult({ content: raw });
  } catch (e) {
    return new ToolResult({
      content: `ERROR executing ${name}: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}
