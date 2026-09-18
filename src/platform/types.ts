/**
 * 平台抽象层 — 提供者接口。
 *
 * 定义 swarmflow 需要的每个跨平台能力，在同级子目录中
 * 每个支持的操作系统有一个实现。
 *
 * 业务代码通过 `src/platform/index.ts` 导入活动 provider，
 * 永远不直接在 `process.platform` 上分支。Windows
 * 实现是存根，会抛出清晰错误直到被填充。
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";

// --------------------------------------------------------------------
// Shell
// --------------------------------------------------------------------

/** 标识驱动 "bash" 工具的 shell 风格。
 * 业务代码使用它来选择解析器、提示措辞和
 * 产生参数 — 从不进行原始的 `process.platform` 检查。 */
export type ShellKind = "bash" | "sh" | "pwsh" | "powershell";

export interface ShellSpawnRequest {
  /** 通过 `-c` (POSIX) 或 `-Command` (PowerShell) 传递的命令字符串。 */
  command: string;
  cwd?: string;
  /** 是否将 shell 生成为登录 shell (POSIX `-lc`)。 */
  loginShell?: boolean;
  /** 覆盖传递给子进程的 env。如果省略，则使用
   * 平台默认的 `process.env` 的 allowlist 筛选器。 */
  env?: NodeJS.ProcessEnv;
  /** 标准 SpawnOptions 覆盖；通常只有 `stdio` 由调用者设置。
   * 提供者处理 `detached` 和进程组内部语义。 */
  stdio?: SpawnOptions["stdio"];
}

export interface ShellProvider {
  /** Shell 风格 — 决定提示措辞、解析器和 spawn 参数。 */
  readonly kind: ShellKind;
  /** 解析后的 shell 二进制文件的绝对路径。 */
  readonly path: string;

  /**
   * 通过平台 shell 产生一个命令字符串。始终返回一个
   * ChildProcess，其进程树可通过 `killTree` 杀死。
   */
  spawn(request: ShellSpawnRequest): ChildProcess;

  /**
   * 杀死由 `spawn` 产生的子进程的整个后代树。
   * POSIX 使用进程组信号 (`process.kill(-pid, sig)`)；
   * Windows 使用 `taskkill /T /F`。
   */
  killTree(child: ChildProcess, signal: NodeJS.Signals): void;

  /** 通过平台默认的 allowlist 过滤 `process.env`。 */
  buildChildEnv(): NodeJS.ProcessEnv;
}

// --------------------------------------------------------------------
// Clipboard
// --------------------------------------------------------------------

export type ClipboardImageMediaType = "image/png" | "image/jpeg" | "image/tiff";

export interface ClipboardImage {
  buffer: Buffer;
  mediaType: ClipboardImageMediaType;
}

export interface ClipboardProvider {
  /** 活动实现的标识符，用于诊断。 */
  readonly id: string;

  /**
   * 将纯文本写入系统剪贴板。如果主要机制成功，返回 true。
   * 实现可能尝试多种工具（例如 wl-copy → xclip → OSC 52），
   * 并在第一个成功时报告成功。
   */
  writeText(text: string): Promise<boolean>;

  /**
   * 从系统剪贴板读取图像。当剪贴板不包含图像、
   * 缺少所需工具或平台不支持剪贴板图像读取时，返回 null。
   */
  readImage(): Promise<ClipboardImage | null>;
}

// --------------------------------------------------------------------
// Browser / system file opener
// --------------------------------------------------------------------

export interface BrowserProvider {
  /** 在用户默认浏览器中打开 http(s):// URL。 */
  openUrl(url: string): void;

  /**
   * 在系统默认应用程序中打开本地文件。在
   * darwin/linux/win 上，此操作路由到与 `openUrl` 相同的命令
   * （`open` / `xdg-open` / `start`）。
   */
  openFile(path: string): void;
}

// --------------------------------------------------------------------
// Binary asset (release tarball naming + install paths)
// --------------------------------------------------------------------

export interface BinaryAssetProvider {
  /** 例如 "swarmflow-darwin-arm64.tar.gz"。 */
  readonly tarballName: string;
  /** POSIX 上为 "swarmflow"，Windows 上为 "swarmflow.exe"。 */
  readonly executableName: string;
  /** 安装后是否应运行 `xattr -dr com.apple.quarantine`。 */
  readonly needsQuarantineRemoval: boolean;
}

// --------------------------------------------------------------------
// OS capabilities — 粗粒度的 yes/no 标志，表示主机操作系统实现了什么。
// 业务代码使用这些标志来跳过不适用于当前平台的操作
// （例如 Windows 上的 POSIX chmod）。将这些保持为布尔标志，
// 而不是 `process.platform` 检查，使业务代码保持平台无关。
// --------------------------------------------------------------------

export interface OsCapabilities {
  /**
   * macOS 和 Linux 上为 true，Windows 上为 false。POSIX 权限位
   * （chmod、0o600 / 0o755 模型）只在 POSIX 文件系统上有意义。
   * 使用此标志跳过 `chmodSync` 调用，而不是在 `process.platform === "win32"` 上分支。
   */
  readonly supportsPosixPermissions: boolean;

  /**
   * 当主机的文件系统（因此 shell 的 $PATH 命令解析）不区分大小写时为 true：
   * 默认 macOS（APFS/HFS+）和 Windows（NTFS / MSYS2 上的 Git Bash）。
   * Linux 上为 false，因为其默认的 ext4/btrfs 区分大小写。
   *
   * 那些比较操作系统不区分大小写地解析的名称/路径的使用者必须查阅此标志：
   *  - bash 命令分类器，在将解析的命令名称与其危险/灾难性集合匹配之前
   *    （`RM`/`Sudo`/`MKFS` 解析为与小写形式相同的二进制文件，因此区分大小写的
   *    匹配会让大写拼写绕过安全门）；
   *  - 外部路径权限规则，在将解析的路径与存储的规则进行前缀匹配时
   *    （`D:\Data` 对 `d:\data\file`）。
   * 在 Linux 上，比较保持区分大小写 — 一个真正命名为 `RM` 的文件与 `rm` 不同。
   *
   * 注意：macOS 可以格式化为区分大小写（罕见）；将默认视为不区分大小写
   * 是安全、保守的选择。
   */
  readonly caseInsensitiveFilesystem: boolean;

  /**
   * 当通过裸 exec（命令 + argv，无 shell）启动 PATHEXT 脚本填充程序
   * （`.cmd` / `.bat`，例如 Windows 上的 `npm` / `npx` / `prettier`）失败时为 true，
   * 因此执行配置命令（钩子）的调用者必须通过 shell 路由。Windows 上为 true；
   * POSIX 上为 false，因为 $PATH 上的每个可执行文件都可以直接 exec。
   *
   * 现代 Node 在要求无 `shell: true` 而产生 `.bat`/`.cmd` 时甚至会抛出（EINVAL，CVE-2024-27980 后）。
   */
  readonly scriptShimsRequireShell: boolean;

  /**
   * 主要存在于该平台上的危险可执行文件名称。
   * 由 bash 命令分类器用于标记 LLM 可能通过 shell 调用的命令。
   *
   * 以小写形式存储；分类器必须与 `name.toLowerCase()` 比较。
   * Windows 文件查找不区分大小写，因此来自 Git Bash 的 `REG QUERY ...`
   * 解析为与 `reg query ...` 相同的 `reg.exe`；区分大小写的查找会让 LLM
   * 通过改变大小写轻松绕过危险门。
   *
   * POSIX 共享的危险命令（rm、sudo、chmod、...）保留在 `classify.ts` 中，
   * 使用区分大小写的匹配 — Unix 约定是区分大小写的路径，并且一个真正
   * 命名为 `RM` 的文件不应与 `rm` 冲突。
   */
  readonly platformSpecificDangerCommands: ReadonlySet<string>;

  /**
   * 唯一一个在 yolo 模式下仍然强制提示的类别。
   */
  readonly platformSpecificCatastrophicCommands: ReadonlySet<string>;

  readonly toolIndicatorGlyph: string;

  /**
   * 在主对话中应用于鼠标滚轮增量的乘数
   * 滚动视口。macOS / Linux 上终端通常提供 1
   * （用户首选的操作系统级滚动加速已经完成）。
   * Windows 终端 / PowerShell 提供单一
   * 无操作系统端加速的每刻钟原始增量，使得与原生 macOS 相比，默认滚动感觉迟缓
   * 惯性：通过注入一个常量滚动加速进入对话滚动视口。
   */
  readonly conversationScrollMultiplier: number;
}

// --------------------------------------------------------------------
// 系统代理 — Node 的 `fetch` 不会自动读取系统级代理配置。
// HTTP_PROXY / HTTPS_PROXY 环境
// 变量，但在 Windows 上它忽略 WinINET 系统代理（Internet
// 选项 → 局域网设置 / 大多数 VPN 和代理客户端切换的设置）。
// 此提供程序呈现该配置，以便启动代码可以将其规范化
// 到环境变量中，从而通过它路由每个出站 fetch。
// --------------------------------------------------------------------

export interface SystemProxyConfig {
  /** http:// 目标的代理 URL，例如 "http://127.0.0.1:7890"。 */
  httpProxy?: string;
  /** https:// 目标的代理 URL。 */
  httpsProxy?: string;
  /** NO_PROXY 格式的逗号分隔的绕过列表（如果有）。 */
  noProxy?: string;
}

export interface SystemProxyProvider {
  /** 用于诊断的活动实现的标识符。 */
  readonly id: string;

  /**
   * 读取操作系统级代理配置。当没有系统代理配置时返回 null，
   * 当平台没有额外的系统代理配置时（POSIX），
   * 或者当配置无法静态解析时（例如 Windows PAC "自动配置"）。
   */
  getSystemProxy(): SystemProxyConfig | null;
}

// --------------------------------------------------------------------
// Aggregate
// --------------------------------------------------------------------

export interface PlatformProviders {
  shell: ShellProvider;
  clipboard: ClipboardProvider;
  browser: BrowserProvider;
  binaryAsset: BinaryAssetProvider;
  osCapabilities: OsCapabilities;
  systemProxy: SystemProxyProvider;
}
