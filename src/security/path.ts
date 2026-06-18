/**
 * Unified path safety checks for file-accessing features.
 *
 * Phase 1 scope:
 * - Enforce a directory boundary (project root / session artifacts)
 * - Prevent lexical traversal (`..`) and prefix-collision mistakes
 * - Reject symlink escapes via canonical (realpath) checks
 * - Support create paths by validating the nearest existing ancestor
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
  // On case-insensitive filesystems (default macOS APFS, Windows) `/Data`
  // and `/data` are the same directory, so fold both sides before the
  // relative computation. Otherwise a path differing only in case from
  // the base is wrongly judged outside scope 鈥?and an external-path rule
  // that the advisor case-folds to approve would then hard-fail here in
  // the executor (the L-3 regression). Folding never WIDENS scope: a real
  // prefix collision (`/base` vs `/base-evil`) still yields a
  // `..`-prefixed relative path. On case-sensitive Linux, exact casing is
  // preserved.
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

  // 1) Lexical boundary check
  const outsideLexical = !isWithinBase(baseDirResolved, resolvedPath);
  result.isOutsideByLexical = outsideLexical;
  if (outsideLexical) {
    result.reason = "Path is outside the allowed directory boundary.";
    fail("PATH_OUTSIDE_SCOPE", result.reason, result);
  }

  // 2) Existence / type checks
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

  // 3) Canonical (realpath) boundary check to prevent symlink escapes
  const followSymlinks = opts.followSymlinks !== false;
  if (followSymlinks) {
    let baseCanonical: string | undefined;
    try {
      if (existsSync(baseDirResolved)) {
        baseCanonical = realpathSync(baseDirResolved);
        result.baseDirCanonical = baseCanonical;
      }
    } catch {
      // If the base cannot be canonicalized, fall back to lexical checks.
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
          // If canonicalization fails for an existing path, rely on lexical + stat checks.
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
            // ignore canonical failure; lexical check already passed
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
