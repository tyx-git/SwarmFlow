/** 工具路径作用域：把相对路径解析到工作区根，并按读/写访问类型执行安全边界。 */

import fs from "node:fs/promises";

import path from "node:path";

import { safePath, SafePathError, type PathAccessKind } from "../security/path.js";

import { ExecuteToolContext } from "./dispatch.js";

export function toolRoot(ctx?: ExecuteToolContext): string {
  return path.resolve(ctx?.projectRoot ?? process.cwd());
}

export const READ_ACCESS_KINDS = new Set<PathAccessKind>(["read", "list", "search", "attach"]);

export function scopedPath(
  requestedPath: string,
  accessKind: PathAccessKind,
  ctx: ExecuteToolContext | undefined,
  opts: {
    mustExist?: boolean;
    allowCreate?: boolean;
    expectFile?: boolean;
    expectDirectory?: boolean;
  },
): string {
  const baseDir = toolRoot(ctx);
  const attempt = (scopeBaseDir: string): string => safePath({
    baseDir: scopeBaseDir,
    requestedPath,
    cwd: baseDir,
    accessKind,
    mustExist: opts.mustExist,
    allowCreate: opts.allowCreate,
    expectFile: opts.expectFile,
    expectDirectory: opts.expectDirectory,
  }).safePath!;

  try {
    return attempt(baseDir);
  } catch (err) {
    if (!(err instanceof SafePathError)) throw err;
    if (err.code !== "PATH_OUTSIDE_SCOPE" && err.code !== "PATH_SYMLINK_ESCAPES_SCOPE") {
      throw err;
    }

    const allowlist = ctx?.externalPathAllowlist ?? [];
    for (const allowedRoot of allowlist) {
      try {
        return attempt(allowedRoot);
      } catch (inner) {
        if (inner instanceof SafePathError &&
            (inner.code === "PATH_OUTSIDE_SCOPE" || inner.code === "PATH_SYMLINK_ESCAPES_SCOPE")) {
          continue;
        }
        throw inner;
      }
    }

    // 读类操作超出作用域时放行：外部读取由 advisor 单独把关，
    // executor 不再重复拦截。
    if (READ_ACCESS_KINDS.has(accessKind)) {
      const resolved = path.isAbsolute(requestedPath)
        ? path.resolve(requestedPath)
        : path.resolve(baseDir, requestedPath);
      return resolved;
    }

    throw err;
  }
}

// ------------------------------------------------------------------
// glob 执行器
// ------------------------------------------------------------------
