/**
 * cd 感知的上下文解析 — 用于复合 bash 命令。
 *
 * 由权限分类器使用（用于决定规则是否适用）。
 * bash 执行器在 tools/basic.ts 中有内联的 cd 解析器，
 * 以避免循环依赖。
 */

import path from "node:path";
import { homedir } from "node:os";

/** cd 解析后的上下文信息 */
export interface ParsedCdContext {
  /** 移除了纯 cd 段后的分段列表 */
  segments: import("./bash/types.js").ParsedBashSegment[];
  /** 解析所有 cd 段后的有效工作目录 */
  effectiveCwd: string;
  /** 是否有任何非 cd 段在项目根目录外运行 */
  isExternal: boolean;
}

/**
 * 对 tree-sitter 解析段进行 cd 上下文解析。
 * 通过结构化标记正确处理带引号的路径。
 */
export function resolveCdContextParsed(
  segments: readonly import("./bash/types.js").ParsedBashSegment[],
  projectRoot: string,
  cwd: string,
): ParsedCdContext {
  const resolvedProjectRoot = path.resolve(projectRoot);
  let effectiveCwd = path.resolve(cwd);
  let everExternal = false;
  const kept: import("./bash/types.js").ParsedBashSegment[] = [];

  for (const seg of segments) {
    // 如果一个段只有一个名为 "cd" 的命令，则是纯 cd 段
    if (seg.commands.length === 1 && seg.operator === "command") {
      const cmd = seg.commands[0]!;
      const name = cmd.name.split("/").pop() ?? cmd.name;
      if (name === "cd") {
        const target = extractCdTargetParsed(cmd);
        if (target === null) {
          // 无法解析的 cd → 视为外部
          everExternal = true;
        } else {
          effectiveCwd = path.isAbsolute(target)
            ? path.resolve(target)
            : path.resolve(effectiveCwd, target);
          if (!isWithinBase(resolvedProjectRoot, effectiveCwd)) {
            everExternal = true;
          }
        }
        continue;
      }
    }
    if (!isWithinBase(resolvedProjectRoot, effectiveCwd)) {
      everExternal = true;
    }
    kept.push(seg);
  }

  return { segments: kept, effectiveCwd, isExternal: everExternal };
}

/**
 * 从解析后的命令中提取 cd 的目标路径。
 */
function extractCdTargetParsed(cmd: import("./bash/types.js").ParsedBashCommand): string | null {
  // 无参数 → 主目录
  if (cmd.argv.length === 0) return homedir();

  // 第一个非标志参数
  const targetToken = cmd.argv.find(t => !t.value.startsWith("-"));
  if (!targetToken) return homedir();

  const val = targetToken.value;

  if (val === "-") return null;
  if (targetToken.kind === "unresolved_expression") return null;
  if (targetToken.kind === "home_reference" || val === "$HOME") return homedir();
  if (val === "~") return homedir();
  if (val.startsWith("~/")) return path.join(homedir(), val.slice(2));

  return val;
}

/**
 * 检查候选路径是否在基础路径内。
 */
function isWithinBase(baseAbs: string, candidateAbs: string): boolean {
  const rel = path.relative(baseAbs, candidateAbs);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  return !rel.startsWith("..");
}
