/** 附件处理主流程：解析 @ 引用、读取文件、汇总告警并生成上下文块。 */

import path from "node:path";

import { context } from "../primitives/context.js";
import { SafePathError, safePath } from "../security/path.js";
import { getSensitiveFileReadReason } from "../security/sensitive-files.js";
import type { FileAttachResult, FileInfo } from "./types.js";
import { parseReferences } from "./reference.js";
import { classifyFile } from "./file-kinds.js";
import { readAndSummarize } from "./reader.js";
import { formatContextBlock } from "./context-block.js";

// ------------------------------------------------------------------
// 主入口
// ------------------------------------------------------------------

/** 处理输入中的 @file 引用：解析引用、读取文件，返回清理后的文本与 `<context>` 块。 */
export async function processFileAttachments(
  userInput: string,
  cwd?: string,
  supportsMultimodal = false,
  baseDir?: string,
  allowedExternalBaseDirs?: string[],
  artifactsDir?: string,
): Promise<FileAttachResult> {
  const [cleanedText, paths] = parseReferences(userInput);

  if (paths.length === 0) {
    return {
      cleanedText,
      contextStr: "",
      files: [],
      warnings: [],
    };
  }

  const warnings: string[] = [];
  const files: FileInfo[] = [];
  const seenPaths = new Set<string>();
  const allowedBase = path.resolve(baseDir ?? cwd ?? process.cwd());
  const extraBases = (allowedExternalBaseDirs ?? []).map((p) => path.resolve(p));

  for (const raw of paths) {
    let absPath = "";
    try {
      absPath = safePath({
        baseDir: allowedBase,
        requestedPath: raw,
        cwd: cwd ?? allowedBase,
        mustExist: true,
        expectFile: true,
        accessKind: "attach",
      }).safePath!;
    } catch (e) {
      let matchedExternal = "";
      if (e instanceof SafePathError &&
          (e.code === "PATH_OUTSIDE_SCOPE" || e.code === "PATH_SYMLINK_ESCAPES_SCOPE")) {
        for (const extBase of extraBases) {
          try {
            absPath = safePath({
              baseDir: extBase,
              requestedPath: raw,
              cwd: cwd ?? allowedBase,
              mustExist: true,
              expectFile: true,
              accessKind: "attach",
            }).safePath!;
            matchedExternal = extBase;
            break;
          } catch {
            // 尝试下一个已批准的外部根
          }
        }
        if (matchedExternal) {
          // 命中已批准的外部根，沿用解析结果。
        } else {
          if (e.code === "PATH_OUTSIDE_SCOPE") {
            warnings.push(`${raw}: path is outside the project root boundary.`);
          } else if (e.code === "PATH_SYMLINK_ESCAPES_SCOPE") {
            warnings.push(`${raw}: path escapes the project root via a symbolic link.`);
          } else {
            warnings.push(`${raw}: ${e.message}`);
          }
          continue;
        }
      } else if (e instanceof SafePathError) {
        if (e.code === "PATH_OUTSIDE_SCOPE") {
          warnings.push(`${raw}: path is outside the project root boundary.`);
        } else if (e.code === "PATH_SYMLINK_ESCAPES_SCOPE") {
          warnings.push(`${raw}: path escapes the project root via a symbolic link.`);
        } else {
          warnings.push(`${raw}: ${e.message}`);
        }
        continue;
      } else {
        warnings.push(`${raw}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
    }

    if (seenPaths.has(absPath)) continue;
    seenPaths.add(absPath);

    const sensitiveReason = getSensitiveFileReadReason(absPath);
    if (sensitiveReason) {
      warnings.push(`${raw}: blocked sensitive file (${sensitiveReason}).`);
      continue;
    }

    const [isImage, isBinary, projectedDocumentType] = classifyFile(absPath);
    const fi = await readAndSummarize(
      absPath,
      isImage,
      isBinary,
      projectedDocumentType,
      supportsMultimodal,
      artifactsDir,
    );
    files.push(fi);
    if (fi.error) {
      warnings.push(`${raw}: ${fi.error}`);
    }
  }

  const innerText = formatContextBlock(files);
  const contextStr = context(innerText, "User Files").render();

  return {
    cleanedText,
    contextStr,
    files,
    warnings,
  };
}

