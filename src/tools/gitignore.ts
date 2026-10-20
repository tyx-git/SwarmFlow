/**
 * JS 回退路径的 .gitignore 匹配。
 *
 * native rg/fd 默认只在检测到 git 仓库时读取 .gitignore；这里通过
 * --no-require-git 让二进制路径也无条件尊重 .gitignore。JS 回退使用
 * ignore 包保持同一语义，并支持嵌套 .gitignore（深目录规则优先）。
 *
 * no_ignore=true 时整个栈禁用，与 --no-ignore 对齐。
 */

import ignore, { type Ignore } from "ignore";
import { readFileSync } from "node:fs";
import path from "node:path";

interface IgnoreLayer {
  baseDir: string;
  matcher: Ignore;
}

export class GitIgnoreStack {
  private readonly layers: IgnoreLayer[] = [];
  private readonly enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  /**
   * 预加载搜索目录以上的 .gitignore（从项目根到父目录）。
   * 遍历开始后由 push/pop 继续处理当前目录及子目录。
   */
  seedAncestors(root: string | undefined, searchPath: string): void {
    if (!this.enabled || !root) return;
    const rootAbs = path.resolve(root);
    const searchAbs = path.resolve(searchPath);
    const rel = path.relative(rootAbs, searchAbs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return;
    const parts = rel.split(/[\\/]+/).filter(Boolean);
    let dir = rootAbs;
    this.push(dir);
    for (const part of parts.slice(0, -1)) {
      dir = path.join(dir, part);
      this.push(dir);
    }
  }

  /** 进入目录时加载该目录的 .gitignore；没有文件时不留占位层。 */
  push(dir: string): void {
    if (!this.enabled) return;
    const baseDir = path.resolve(dir);
    if (this.layers.length > 0 && this.layers[this.layers.length - 1]!.baseDir === baseDir) return;
    let content: string;
    try {
      content = readFileSync(path.join(baseDir, ".gitignore"), "utf8");
    } catch {
      return;
    }
    if (!content.trim()) return;
    this.layers.push({ baseDir, matcher: ignore().add(content) });
  }

  /** 离开目录时只弹出本目录实际加载的层。 */
  pop(dir: string): void {
    if (!this.enabled) return;
    const baseDir = path.resolve(dir);
    if (this.layers.length > 0 && this.layers[this.layers.length - 1]!.baseDir === baseDir) {
      this.layers.pop();
    }
  }

  /** 深目录规则优先；显式否定（!pattern）覆盖浅层忽略。 */
  ignores(fullPath: string, isDir: boolean): boolean {
    if (!this.enabled) return false;
    for (let i = this.layers.length - 1; i >= 0; i -= 1) {
      const layer = this.layers[i]!;
      const rel = path.relative(layer.baseDir, fullPath).replace(/\\/g, "/");
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
      // 目录规则（foo/）只有在路径带尾斜杠时才会命中。
      const result = layer.matcher.test(isDir ? `${rel}/` : rel);
      if (result.ignored) return true;
      if (result.unignored) return false;
    }
    return false;
  }
}
