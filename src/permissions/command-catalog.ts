/** 命令与工具的权限分类目录：安全/可逆/危险/灾难四档的命令集合与别名表。 */


import { osCapabilities } from "../platform/index.js";

// ------------------------------------------------------------------
// Tree-sitter 解析器（延迟异步初始化）
// ------------------------------------------------------------------

/** 只读工具集合 */
export const READ_TOOLS = new Set([
  "read_file", "list_dir", "glob", "grep", "find_symbol", "jq",
  "web_fetch", "web_search", "$web_search",
  "ask", "check_status", "await_event", "send",
  "skill", "time",
  "kill_shell",
  // 任务清单是会话态，只读查看无副作用
  "task_list", "task_get",
]);

/** 可逆写工具集合 */
export const WRITE_REVERSIBLE_TOOLS = new Set([
  "write_file", "edit_file",
  // 任务清单写入仅改会话态，可逆且不触碰工作区文件
  "task_create", "task_update", "task_resume",
]);

/** 派生工具集合 */
export const SPAWN_TOOLS = new Set([
  "spawn",
]);

/** 危险写工具集合 */
export const WRITE_DANGER_TOOLS = new Set([
  "kill_agent",
]);

// ------------------------------------------------------------------
// Bash 命令集合
// ------------------------------------------------------------------

/** Bash 安全命令集合 */
export const BASH_SAFE_COMMANDS = new Set([
  "ls", "ll", "la", "dir", "cat", "head", "tail", "less", "more",
  "wc", "file", "stat", "readlink", "realpath", "basename", "dirname",
  "tree",
  "grep", "egrep", "fgrep", "rg", "ag", "ack",
  "pwd", "whoami", "hostname", "uname", "arch", "id", "groups",
  "which", "where", "whence", "type", "command",
  "echo", "printf", "true", "false", "test", "[", "[[", "expr", "seq",
  "sort", "uniq", "cut", "tr", "paste", "nl", "rev", "fmt",
  "comm", "cmp", "diff",
  "jq", "yq",
  "date", "env", "printenv", "uptime", "ps", "df", "du", "free",
  "lsof", "pgrep", "tput",
  "md5sum", "sha256sum", "shasum", "base64",
  "sleep",
  "cd",
]);

/** Bash 可逆命令（mkdir） */
export const BASH_REVERSIBLE_COMMANDS = new Set(["mkdir"]);

/** Bash 动态可逆命令（cp, mv） */
export const BASH_DYNAMIC_REVERSIBLE = new Set(["cp", "mv"]);

/**
 * POSIX 共享的危险命令。以小写存储。
 * 查找在仅区分大小写的文件系统（Linux）上是区分大小写的：
 * 在那里 `RM` 与 `rm` 是不同的文件。在不区分大小写的
 * 文件系统（macOS 和 Windows Git Bash 默认）上，
 * classifyParsedCommand 在比较前将解析的名称小写化 — 参见
 * caseInsensitiveFilesystem 能力 — 所以大写拼写
 * 无法绕过门控。
 *
 * 平台特定危险命令（Windows 注册表/磁盘/网络工具）
 * 位于 osCapabilities.platformSpecificDangerCommands 中，
 * 以不区分大小写的方式匹配，因为 Windows 文件查找
 * 是不区分大小写的（REG QUERY → reg.exe）。
 */
const BASH_DANGER_COMMANDS = new Set([
  "rm", "rmdir",
  "sudo", "su", "doas",
  "chmod", "chown", "chgrp",
  "kill", "killall", "pkill",
  "reboot", "shutdown", "halt", "poweroff", "init",
  "mount", "umount",
  "iptables", "ip6tables", "nft",
  "systemctl", "service", "launchctl",
  "useradd", "userdel", "usermod", "groupadd", "groupdel",
  "passwd",
  "crontab",
]);

export function isDangerCommand(name: string): boolean {
  if (BASH_DANGER_COMMANDS.has(name)) return true;
  // Windows 特定名称：小写比较使 `REG`、`Reg`、`reg` 都标记
  //（Git Bash 使用 Win32 不区分大小写的文件查找）
  return osCapabilities.platformSpecificDangerCommands.has(name.toLowerCase());
}

/** Bash 强能力命令集合 */
export const BASH_POTENT_COMMANDS = new Set([
  "touch", "ln", "tee",
  "npm", "npx", "pnpm", "yarn",
  "pip", "pip3", "uv",
  "cargo", "go",
  "python", "python3", "node", "deno",
  "ruby", "gem", "bundle",
  "java", "javac", "gradle", "mvn",
  "gcc", "g++", "clang", "clang++",
  "make", "cmake",
  "rustc",
  "docker", "podman", "kubectl",
  "bash", "sh", "zsh",
  "sed", "awk", "xargs",
  "curl", "wget",
  "tar", "gzip", "gunzip", "bzip2", "xz", "unzip", "zip",
  "scp", "rsync", "sftp",
  "tsc", "esbuild", "vite", "webpack", "rollup", "parcel",
  "jest", "vitest", "mocha", "pytest",
  "eslint", "prettier", "biome",
  "brew", "apt", "apt-get", "yum", "dnf", "pacman",
  "ssh-keygen",
  "openssl",
]);

/** 进程包装器 */
export const PROCESS_WRAPPERS = new Set([
  "timeout", "time", "nice", "nohup", "stdbuf", "command", "builtin",
]);

// ------------------------------------------------------------------
// PowerShell 命令集合（不区分大小写 — 所有条目都是小写）
// ------------------------------------------------------------------

/** PowerShell 安全命令集合 */
export const PS_SAFE_COMMANDS = new Set([
  "get-childitem", "get-content", "get-item", "get-itemproperty",
  "test-path", "resolve-path", "split-path", "join-path",
  "get-location", "get-psdrive",
  "select-string", "select-object", "sort-object", "group-object",
  "where-object", "foreach-object", "measure-object",
  "format-table", "format-list", "format-wide", "format-custom",
  "out-string", "out-null", "out-host",
  "write-output", "write-host", "write-verbose", "write-debug", "write-warning",
  "get-process", "get-service",
  "get-date", "get-random", "get-filehash",
  "get-command", "get-help", "get-alias", "get-module",
  "get-variable", "get-host", "get-culture",
  "compare-object", "measure-command",
  "convertto-json", "convertfrom-json",
  "convertto-csv", "convertfrom-csv",
  "get-acl", "get-executionpolicy",
]);

/**
 * 仅文件系统操作的命令是可逆的。能够针对非文件系统
 * 提供程序（注册表、环境等）的 cmdlet 是强能力的。
 */
export const PS_REVERSIBLE_COMMANDS = new Set([
  "add-content",
]);

/**
 * Set-Location/Push-Location 是强能力的（不可逆），
 * 因为 cd-context 跟踪器只理解 bash `cd` — PowerShell
 * 目录更改会绕过 external-cwd 检测，让后续读取
 * 从项目根目录外自动静默允许。
 */
export const PS_CWD_COMMANDS = new Set([
  "set-location", "push-location", "pop-location",
]);

/** PowerShell 危险命令集合 */
export const PS_DANGER_COMMANDS = new Set([
  "remove-item", "clear-content", "clear-item",
  "stop-process", "stop-service", "restart-service",
  "remove-itemproperty",
  "clear-recyclebin",
  "restart-computer", "stop-computer",
  "set-executionpolicy",
]);

/** PowerShell 强能力命令集合 */
export const PS_POTENT_COMMANDS = new Set([
  "new-item", "copy-item", "move-item", "rename-item",
  "new-itemproperty", "set-itemproperty",
  "set-content", "out-file",
  "invoke-webrequest", "invoke-restmethod",
  "start-process", "start-job", "start-service",
  "invoke-command",
  "new-object",
  "install-module", "import-module", "save-module",
  "install-package",
  "expand-archive", "compress-archive",
  "register-scheduledjob", "register-scheduledtask",
  "set-acl",
]);

/** 危险的 PowerShell 模式：eval 等价物和代码注入向量 */
export const PS_EVAL_COMMANDS = new Set([
  "invoke-expression", "iex",
]);

/**
 * PowerShell 磁盘管理 cmdlet，会不可逆地销毁数据 —
 * 升级为 catastrophic（yolo 仍会提示的唯一类别），
 * 与 classifyParsedCommand 中 POSIX mkfs/fdisk/dd 处理对应。
 */
export const PS_CATASTROPHIC_COMMANDS = new Set([
  "format-volume", "clear-disk", "initialize-disk", "remove-partition",
]);

/** PowerShell 常见别名 → 规范 cmdlet 名称（小写） */
export const PS_ALIASES = new Map<string, string>([
  // 导航
  ["cd", "set-location"], ["chdir", "set-location"],
  ["pushd", "push-location"], ["popd", "pop-location"],
  // 文件
  ["ls", "get-childitem"], ["dir", "get-childitem"], ["gci", "get-childitem"],
  ["cat", "get-content"], ["type", "get-content"], ["gc", "get-content"],
  ["cp", "copy-item"], ["copy", "copy-item"], ["ci", "copy-item"],
  ["mv", "move-item"], ["move", "move-item"], ["mi", "move-item"],
  ["rm", "remove-item"], ["del", "remove-item"], ["rd", "remove-item"],
  ["rmdir", "remove-item"], ["erase", "remove-item"], ["ri", "remove-item"],
  ["ren", "rename-item"], ["rni", "rename-item"],
  ["ni", "new-item"], ["md", "new-item"], ["mkdir", "new-item"],
  // 输出
  ["echo", "write-output"], ["write", "write-output"],
  // 搜索
  ["sls", "select-string"],
  // 进程
  ["ps", "get-process"], ["gps", "get-process"],
  ["kill", "stop-process"], ["spps", "stop-process"],
  // 过滤/迭代（这些执行脚本块！）
  ["where", "where-object"], ["?", "where-object"],
  ["foreach", "foreach-object"], ["%", "foreach-object"],
  // 其他
  ["cls", "clear-host"], ["clear", "clear-host"],
  ["iex", "invoke-expression"],
  ["iwr", "invoke-webrequest"],
  ["irm", "invoke-restmethod"],
  ["icm", "invoke-command"],
  ["sal", "set-alias"],
  ["sv", "set-variable"],
  ["sleep", "start-sleep"],
  ["sc", "set-content"],
  ["ac", "add-content"],
  ["ii", "invoke-item"],
  ["start", "start-process"], ["saps", "start-process"],
]);

// ------------------------------------------------------------------
// Git 子命令集合（仅用于未被 classifyGitDetailed 处理的命令）
// ------------------------------------------------------------------
