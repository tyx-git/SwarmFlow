/**
 * cd-aware context resolution for compound bash commands.
 *
 * Used by the permission classifier (to decide whether rules apply).
 * The bash executor has its own inlined cd parser in tools/basic.ts
 * to avoid a circular dependency.
 */

import path from "node:path";
import { homedir } from "node:os";

export interface ParsedCdContext {
  /** Segments with pure-cd segments removed. */
  segments: import("./bash/types.js").ParsedBashSegment[];
  /** Effective cwd after resolving all cd segments. */
  effectiveCwd: string;
  /** Whether ANY non-cd segment runs outside projectRoot. */
  isExternal: boolean;
}

/**
 * cd-context resolution on tree-sitter parsed segments.
 * Handles quoted paths correctly via structured tokens.
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
    // A segment is a pure cd if it has exactly one command named "cd"
    if (seg.commands.length === 1 && seg.operator === "command") {
      const cmd = seg.commands[0]!;
      const name = cmd.name.split("/").pop() ?? cmd.name;
      if (name === "cd") {
        const target = extractCdTargetParsed(cmd);
        if (target === null) {
          // Unresolvable cd 鈫?treat as external
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

function extractCdTargetParsed(cmd: import("./bash/types.js").ParsedBashCommand): string | null {
  // No arguments 鈫?home directory
  if (cmd.argv.length === 0) return homedir();

  // First non-flag argument
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

function isWithinBase(baseAbs: string, candidateAbs: string): boolean {
  const rel = path.relative(baseAbs, candidateAbs);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  return !rel.startsWith("..");
}
