/**
 * 文件访问功能的统一路径安全检查。
 *
 * 第一阶段范围：
 * - 强制执行目录边界（项目根目录 / 会话产物）
 * - 防止词法遍历（`..`）和前缀碰撞错误
 * - 通过规范（realpath）检查拒绝符号链接转义
 * - 通过验证最近的现有祖先来支持创建路径
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { osCapabilities } from "../platform/index.js";

/**
 * Normalize a filesystem path to forward-slash form so prefix matches
 * work the same way on Windows (where `path.resolve` returns `\`) and
 * on POSIX (where it returns `/`). Idempotent on POSIX. Used by the
 * permission system to compare external-path rules against resolved
 * paths without leaking OS-specific separator handling into callers.
 *
 * Note: this does NOT lower-case the path. Windows file systems are
 * usually case-insensitive but `path.resolve` preserves case, so a
 * rule stored for `C:\Users\Foo` will not match `c:\users\foo`. That
 * gap is documented as a known Windows limitation rather than papered
 * over here.
 */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

export type PathAccessKind =
  | "read"
  | "write"
  | "list"
  | "search"
  | "attach"
  | "template"
  | "spawn_call_file";

export type PathDecision =
  | "allow"
  | "deny_external"
  | "deny_symlink";

export interface SafePathOptions {
  baseDir: string;
  requestedPath: string;
  cwd?: string;
  mustExist?: boolean;
  allowCreate?: boolean;
  expectDirectory?: boolean;
  expectFile?: boolean;
  accessKind: PathAccessKind;
  followSymlinks?: boolean;
}

export interface SafePathResult {
  requestedPath: string;
  resolvedPath: string;
  canonicalPath?: string;
  baseDirResolved: string;
  baseDirCanonical?: string;
  decision: PathDecision;
  safePath?: string;
  reason?: string;
  isOutsideByLexical?: boolean;
  isOutsideByCanonical?: boolean;
  crossedSymlinkBoundary?: boolean;
}

type SafePathErrorCode =
  | "PATH_OUTSIDE_SCOPE"
  | "PATH_SYMLINK_ESCAPES_SCOPE"
  | "PATH_NOT_FOUND"
  | "PATH_NOT_FILE"
  | "PATH_NOT_DIRECTORY"
  | "PATH_INVALID_INPUT";

export class SafePathError extends Error {
  code: SafePathErrorCode;
  details: SafePathResult;

  constructor(
    code: SafePathErrorCode,
    message: string,
    details: SafePathResult,
  ) {
    super(message);
    this.name = "SafePathError";
    this.code = code;
    this.details = details;
  }
}

function isWithinBase(baseAbs: string, candidateAbs: string): boolean {
  // 在大小写不敏感文件系统（默认 macOS APFS、Windows）上，`/Data`
  // 和 `/data` 是同一目录，所以在相对路径计算前将两边折叠。
  // 否则，仅在大小写上与 base 不同的路径会被错误判定为超出范围 —
  // 并且 advisor 大小写折叠后批准的 external-path 规则
  // 会在这里的 executor 中硬失败（L-3 回归）。折叠不会扩大范围：
  // 真正的前缀碰撞（`/base` vs `/base-evil`）仍会产生
  // `..`-前缀的相对路径。在大小写敏感的 Linux 上，精确大小写被保留。
  const [base, candidate] = osCapabilities.caseInsensitiveFilesystem
    ? [baseAbs.toLowerCase(), candidateAbs.toLowerCase()]
    : [baseAbs, candidateAbs];
  const rel = path.relative(base, candidate);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false; // Windows cross-drive safety
  return !rel.startsWith("..");
}

function nearestExistingAncestor(targetAbs: string): string | null {
  let current = targetAbs;
  while (true) {
    if (existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function makeBaseResult(
  opts: SafePathOptions,
  baseDirResolved: string,
  resolvedPath: string,
): SafePathResult {
  return {
    requestedPath: opts.requestedPath,
    resolvedPath,
    baseDirResolved,
    decision: "deny_external",
  };
}

function fail(
  code: SafePathErrorCode,
  message: string,
  result: SafePathResult,
): never {
  throw new SafePathError(code, message, result);
}

/**
 * Resolve and validate a path against a single allowed base directory.
 *
 * Phase 1 behavior:
 * - Paths outside the base are denied
 * - Symlink escapes are denied (future phases may map this to an `ask`)
 */
export function safePath(opts: SafePathOptions): SafePathResult {
  const requested = String(opts.requestedPath ?? "");
  const baseRaw = String(opts.baseDir ?? "");

  if (!requested.trim()) {
    const result = {
      requestedPath: requested,
      resolvedPath: "",
      baseDirResolved: path.resolve(baseRaw || "."),
      decision: "deny_external" as const,
      reason: "Empty path.",
    };
    fail("PATH_INVALID_INPUT", "Path cannot be empty.", result);
  }
  if (!baseRaw.trim()) {
    const result = {
      requestedPath: requested,
      resolvedPath: path.resolve(requested),
      baseDirResolved: path.resolve("."),
      decision: "deny_external" as const,
      reason: "Invalid base directory.",
    };
    fail("PATH_INVALID_INPUT", "Base directory cannot be empty.", result);
  }

  const baseDirResolved = path.resolve(baseRaw);
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const resolvedPath = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(cwd, requested);

  const result = makeBaseResult(opts, baseDirResolved, resolvedPath);

  // 1) 词法边界检查
  const outsideLexical = !isWithinBase(baseDirResolved, resolvedPath);
  result.isOutsideByLexical = outsideLexical;
  if (outsideLexical) {
    result.reason = "Path is outside the allowed directory boundary.";
    fail("PATH_OUTSIDE_SCOPE", result.reason, result);
  }

  // 2) 存在性/类型检查
  const mustExist = opts.mustExist === true;
  const allowCreate = opts.allowCreate === true;
  const exists = existsSync(resolvedPath);

  if (mustExist && !exists) {
    result.reason = `Path does not exist: ${resolvedPath}`;
    fail("PATH_NOT_FOUND", result.reason, result);
  }
  if (!exists && !mustExist && !allowCreate) {
    result.reason = `Path does not exist: ${resolvedPath}`;
    fail("PATH_NOT_FOUND", result.reason, result);
  }

  // 3) 规范（realpath）边界检查，防止符号链接转义
  const followSymlinks = opts.followSymlinks !== false;
  if (followSymlinks) {
    let baseCanonical: string | undefined;
    try {
      if (existsSync(baseDirResolved)) {
        baseCanonical = realpathSync(baseDirResolved);
        result.baseDirCanonical = baseCanonical;
      }
    } catch {
      // 如果 base 无法规范化，则回退到词法检查。
    }

    if (baseCanonical) {
      if (exists) {
        try {
          const candidateCanonical = realpathSync(resolvedPath);
          result.canonicalPath = candidateCanonical;
          const outsideCanonical = !isWithinBase(baseCanonical, candidateCanonical);
          result.isOutsideByCanonical = outsideCanonical;
          if (outsideCanonical) {
            result.canonicalPath = candidateCanonical;
            result.crossedSymlinkBoundary = true;
            result.decision = "deny_symlink";
            result.reason = "Path escapes the allowed directory via a symbolic link.";
            fail("PATH_SYMLINK_ESCAPES_SCOPE", result.reason, result);
          }
        } catch (e) {
          if (e instanceof SafePathError) throw e;
          // 如果现有路径的规范化失败，依赖词法+stat检查。
        }
      } else if (allowCreate) {
        const ancestor = nearestExistingAncestor(resolvedPath);
        if (ancestor) {
          try {
            const ancestorCanonical = realpathSync(ancestor);
            const outsideCanonical = !isWithinBase(baseCanonical, ancestorCanonical);
            result.canonicalPath = ancestorCanonical;
            result.isOutsideByCanonical = outsideCanonical;
            if (outsideCanonical) {
              result.crossedSymlinkBoundary = true;
              result.decision = "deny_symlink";
              result.reason = "Path escapes the allowed directory via a symbolic link in its parent path.";
              fail("PATH_SYMLINK_ESCAPES_SCOPE", result.reason, result);
            }
          } catch (e) {
            if (e instanceof SafePathError) throw e;
            // 忽略规范化失败；词法检查已通过
          }
        }
      }
    }
  }

  if (exists) {
    let st;
    try {
      st = statSync(resolvedPath);
    } catch (e) {
      result.reason = `Failed to stat path: ${e instanceof Error ? e.message : String(e)}`;
      fail("PATH_INVALID_INPUT", result.reason, result);
    }
    if (opts.expectFile && !st.isFile()) {
      result.reason = `Expected a file: ${resolvedPath}`;
      fail("PATH_NOT_FILE", result.reason, result);
    }
    if (opts.expectDirectory && !st.isDirectory()) {
      result.reason = `Expected a directory: ${resolvedPath}`;
      fail("PATH_NOT_DIRECTORY", result.reason, result);
    }
  }

  result.decision = "allow";
  result.safePath = resolvedPath;
  return result;
}
