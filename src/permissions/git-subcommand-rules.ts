/** git 子命令的权限分级（safe / reversible / danger）与 detail 判定。 */

import type { PermissionClass } from "./types.js";
import type { ParsedBashCommand } from "./bash/types.js";

// ------------------------------------------------------------------
// Tree-sitter 解析器（延迟异步初始化）
// ------------------------------------------------------------------

/** Git 安全子命令 */
const GIT_SAFE_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show",
  "rev-parse",
  "ls-files", "ls-tree", "ls-remote",
  "describe", "shortlog", "blame", "annotate",
  "reflog",
  "name-rev", "rev-list",
  "cat-file", "hash-object",
  "count-objects", "fsck", "verify-pack",
  "for-each-ref",
]);

/** Git 可逆子命令 */
const GIT_REVERSIBLE_SUBCOMMANDS = new Set([
  "add", "commit", "fetch", "pull",
  "switch",
  "merge",
  "cherry-pick",
  "init",
]);

/** Git 危险子命令 */
const GIT_DANGER_SUBCOMMANDS = new Set([
  "push", "rebase",
]);

/**
 * 对 git 子命令进行详细分类。
 */
export function classifyGitDetailed(cmd: ParsedBashCommand): PermissionClass {
  const positionals: string[] = [];
  const flags = new Set<string>();

  for (const token of cmd.argv) {
    if (token.kind !== "literal") continue;
    if (token.value.startsWith("-")) {
      flags.add(token.value);
    } else {
      positionals.push(token.value);
    }
  }

  const sub = positionals[0] ?? "";
  const sub2 = positionals[1] ?? "";
  if (!sub) return "write_potent";

  // 全局标志升级
  if (flags.has("--force") || flags.has("-f") || flags.has("--force-with-lease")) return "write_danger";
  if (flags.has("--hard")) return "write_danger";

  switch (sub) {
    case "stash": {
      if (!sub2 || sub2 === "push" || sub2 === "save") return "write_reversible";
      if (sub2 === "list" || sub2 === "show") return "read";
      if (sub2 === "pop" || sub2 === "apply") return "write_reversible";
      if (sub2 === "drop" || sub2 === "clear") return "write_danger";
      return "write_reversible";
    }
    case "checkout": {
      if (flags.has("--")) return "write_danger";
      // `git checkout .` 或没有 -b 的 `git checkout <file>` → 危险
      // 启发式：如果有像文件路径的位置参数且没有 -b 标志
      if (!flags.has("-b") && !flags.has("-B") && positionals.length >= 2) {
        const target = positionals[1]!;
        if (target === "." || target === "./" || target.includes("/") || target.includes(".")) {
          return "write_danger";
        }
      }
      return "write_reversible";
    }
    case "reset": {
      // --hard 已被上面的全局标志检查捕获
      return "write_reversible";
    }
    case "clean": {
      if (flags.has("-n") || flags.has("--dry-run")) return "read";
      return "write_danger";
    }
    case "branch": {
      if (flags.has("-D") || flags.has("-d") || flags.has("--delete")) return "write_danger";
      if (positionals.length <= 1) return "read";
      return "write_reversible";
    }
    case "tag": {
      if (flags.has("-d") || flags.has("--delete")) return "write_danger";
      if (positionals.length <= 1) return "read";
      return "write_reversible";
    }
    case "remote": {
      if (!sub2 || sub2 === "show" || sub2 === "get-url") return "read";
      if (sub2 === "add" || sub2 === "rename" || sub2 === "set-url") return "write_reversible";
      if (sub2 === "remove" || sub2 === "rm") return "write_danger";
      return "write_potent";
    }
    case "worktree": {
      if (!sub2 || sub2 === "list") return "read";
      if (sub2 === "add") return "write_reversible";
      if (sub2 === "remove" || sub2 === "prune") return "write_danger";
      return "write_potent";
    }
    case "config": {
      if (flags.has("--unset") || flags.has("--remove-section")) return "write_potent";
      // 1 个位置参数（key）= 只读，2+（key value）= 写
      if (positionals.length <= 2) return "read";
      return "write_potent";
    }
    default: break;
  }

  if (GIT_DANGER_SUBCOMMANDS.has(sub)) return "write_danger";
  if (GIT_REVERSIBLE_SUBCOMMANDS.has(sub)) return "write_reversible";
  if (GIT_SAFE_SUBCOMMANDS.has(sub)) return "read";

  return "write_potent";
}

// ------------------------------------------------------------------
// 辅助函数
// ------------------------------------------------------------------
