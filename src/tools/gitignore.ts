/**
 * JS 回退路径的 ignore 文件匹配。
 *
 * 默认读取：全局 gitignore（最低优先级）+ 遍历目录内的 .gitignore。
 * glob 额外读取 .ignore；grep 保持只读 .gitignore（与 rg 的 JS 侧现状一致）。
 * 全局文件解析对齐 git 的常用形态：GIT_CONFIG_GLOBAL 优先；否则读
 * ~/.gitconfig 与 $XDG_CONFIG_HOME/git/config 的 core.excludesFile；
 * 未配置时回退 $XDG_CONFIG_HOME/git/ignore。
 *
 * 同一目录内后加载的文件优先（.ignore > .gitignore）；no_ignore=true 时
 * 整个栈禁用，与 --no-ignore 对齐。
 */

import ignore, { type Ignore } from "ignore";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

interface IgnoreLayer {
  baseDir: string;
  matcher: Ignore;
}

interface DirFrame {
  baseDir: string;
  layerCount: number;
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(home, value.slice(2));
  return value;
}

/** git config 的双引号值支持 \n / \t / \b / \\ / \" 转义。 */
function unquoteConfigValue(raw: string): string {
  const value = raw.trim();
  if (value.length < 2 || !value.startsWith("\"") || !value.endsWith("\"")) return value;
  return value.slice(1, -1).replace(/\\([\\"nbt])/g, (_, ch: string) =>
    ch === "n" ? "\n" : ch === "t" ? "\t" : ch === "b" ? "\b" : ch,
  );
}

function isEnvTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLocaleLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

/**
 * 扫描一个 git config 文件，按位置展开无条件 include.path。
 * 后出现的值覆盖先出现的值；includeIf 等条件 include 不处理。
 */
function scanConfigFile(
  configFile: string,
  depth: number,
  visited: Set<string>,
  result: { value: string | null },
  home: string,
): void {
  if (depth > 10) return;
  const absolute = path.resolve(configFile);
  if (visited.has(absolute)) return;
  visited.add(absolute);

  let text: string;
  try {
    text = readFileSync(absolute, "utf8");
  } catch {
    return;
  }

  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      const parts = header[1]!.trim().split(/\s+/);
      // [core "sub"] 是子节；core.excludesFile 只在普通 [core] 生效。
      section = parts.length === 1
        ? parts[0]!.toLocaleLowerCase()
        : `${parts[0]!.toLocaleLowerCase()}.${parts.slice(1).join(" ")}`;
      continue;
    }
    const assignment = /^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.*)$/.exec(line);
    if (!assignment) continue;
    const key = assignment[1]!.toLocaleLowerCase();
    const value = unquoteConfigValue(assignment[2]!);
    if (section === "core" && key === "excludesfile") {
      result.value = value || null;
      continue;
    }
    if (section === "include" && key === "path" && value) {
      // include.path 相对包含它的 config 文件解析。
      const included = path.resolve(path.dirname(absolute), expandHome(value, home));
      scanConfigFile(included, depth + 1, visited, result, home);
    }
  }
}

/**
 * 解析全局 gitignore 文件（至多一个，遵循 core.excludesFile 覆盖默认值的语义）。
 *
 * 边界：
 * - 顺序：system → XDG global config → ~/.gitconfig（后者覆盖前者）；
 *   GIT_CONFIG_GLOBAL 只读该文件；GIT_CONFIG_NOSYSTEM 跳过 system。
 * - 支持无条件 include.path（相对包含文件、带环检测）；includeIf 不处理。
 * - 支持 ~/、引号与常见转义；相对 excludesFile 保持相对（git 按 cwd 解析）。
 * - Windows 的 system config 位置随安装目录变化，只认 GIT_CONFIG_SYSTEM；
 *   POSIX 默认 /etc/gitconfig。
 */
export function resolveGlobalIgnoreFiles(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  const result: { value: string | null } = { value: null };
  const visited = new Set<string>();

  if (!isEnvTruthy(env.GIT_CONFIG_NOSYSTEM)) {
    const systemConfig = env.GIT_CONFIG_SYSTEM?.trim()
      || (platform === "win32" ? "" : "/etc/gitconfig");
    if (systemConfig) scanConfigFile(systemConfig, 0, visited, result, home);
  }

  const globalOverride = env.GIT_CONFIG_GLOBAL?.trim();
  if (globalOverride) {
    scanConfigFile(globalOverride, 0, visited, result, home);
  } else {
    scanConfigFile(path.join(configHome, "git", "config"), 0, visited, result, home);
    scanConfigFile(path.join(home, ".gitconfig"), 0, visited, result, home);
  }

  if (result.value) return [expandHome(result.value, home)];
  return [path.join(configHome, "git", "ignore")];
}

export class GitIgnoreStack {
  private readonly layers: IgnoreLayer[] = [];
  private readonly frames: DirFrame[] = [];
  private readonly enabled: boolean;
  private readonly fileNames: readonly string[];
  private readonly globalFiles: readonly string[];
  private globalSeeded = false;

  constructor(
    enabled: boolean,
    fileNames: readonly string[] = [".gitignore"],
    globalFiles: readonly string[] = resolveGlobalIgnoreFiles(),
  ) {
    this.enabled = enabled;
    this.fileNames = fileNames;
    this.globalFiles = globalFiles;
  }

  /** 在遍历根加载全局 gitignore（最低优先级，必须最先调用）。 */
  seedGlobal(baseDir: string): void {
    if (!this.enabled || this.globalSeeded) return;
    this.globalSeeded = true;
    const base = path.resolve(baseDir);
    for (const file of this.globalFiles) {
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (!content.trim()) continue;
      this.layers.push({ baseDir: base, matcher: ignore().add(content) });
    }
  }

  /**
   * 预加载搜索目录以上的 ignore 文件（从项目根到父目录）。
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

  /** 进入目录时加载该目录的 ignore 文件；没有文件时只留一个空帧。 */
  push(dir: string): void {
    if (!this.enabled) return;
    const baseDir = path.resolve(dir);
    const last = this.frames[this.frames.length - 1];
    if (last?.baseDir === baseDir) return;
    let layerCount = 0;
    for (const fileName of this.fileNames) {
      let content: string;
      try {
        content = readFileSync(path.join(baseDir, fileName), "utf8");
      } catch {
        continue;
      }
      if (!content.trim()) continue;
      this.layers.push({ baseDir, matcher: ignore().add(content) });
      layerCount += 1;
    }
    this.frames.push({ baseDir, layerCount });
  }

  /** 离开目录时弹出该目录加载的全部层。 */
  pop(dir: string): void {
    if (!this.enabled) return;
    const baseDir = path.resolve(dir);
    const frame = this.frames[this.frames.length - 1];
    if (!frame || frame.baseDir !== baseDir) return;
    this.frames.pop();
    if (frame.layerCount > 0) this.layers.splice(this.layers.length - frame.layerCount);
  }

  /** 深目录规则优先；同目录内后加载的文件优先；显式否定（!pattern）覆盖忽略。 */
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
