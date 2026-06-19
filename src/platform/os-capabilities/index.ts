/**
 * 粗粒度操作系统能力标志。用于门控语义不同
 *（或根本不存在）于 Windows 上的操作，而不将
 * `process.platform` 检查泄漏到业务代码中。
 */

import type { OsCapabilities } from "../types.js";
import { currentPlatform } from "../detect.js";

// macOS + Linux 两个 POSIX 平台共用的字段。它们只在
// caseInsensitiveFilesystem 上有差异，因此每个平台扩展此基类并
// 在下面显式设置该标志。
const POSIX_SHARED: Omit<OsCapabilities, "caseInsensitiveFilesystem"> = {
  supportsPosixPermissions: true,
  // POSIX 没有超出 classify.ts 中已共享的 POSIX 集合的平台特定危险/灾难性命令
  //（分别是 rm/sudo/chmod 和 mkfs/fdisk/dd）。
  platformSpecificDangerCommands: new Set(),
  platformSpecificCatastrophicCommands: new Set(),
  // POSIX 直接执行每个 $PATH 条目 — shims 不需要 shell。
  scriptShimsRequireShell: false,
  toolIndicatorGlyph: "●", // ● 录制黑色圆圈
  conversationScrollMultiplier: 1,
};

const DARWIN_CAPS: OsCapabilities = {
  ...POSIX_SHARED,
  // 默认 macOS APFS/HFS+ 是大小写不敏感的，所以 shell 将
  // `RM`/`SUDO` 解析为与小写形式相同的二进制文件。
  caseInsensitiveFilesystem: true,
};

const LINUX_CAPS: OsCapabilities = {
  ...POSIX_SHARED,
  // 默认 Linux ext4/btrfs 是大小写敏感的。
  caseInsensitiveFilesystem: false,
};

// 小写化 — 见 OsCapabilities.platformSpecificDangerCommands
// JSDoc 用于解释大小写不敏感的原因。
const WIN32_DANGER_COMMANDS: ReadonlySet<string> = new Set([
  "reg",        // 注册表编辑器
  "bcdedit",    // 启动配置
  "netsh",      // 网络配置
  "taskkill",   // 按名称/pid 终止进程
  "wmic",       // WMI 命令行
]);

// 不可逆的磁盘擦除可执行文件 — 升级为 catastrophic（这是 yolo 模式下
// 仍会提示的唯一类别），而不仅仅是 write_danger。
const WIN32_CATASTROPHIC_COMMANDS: ReadonlySet<string> = new Set([
  "format",     // 磁盘格式化
  "diskpart",   // 磁盘分区
]);

const WIN32_CAPS: OsCapabilities = {
  supportsPosixPermissions: false,
  // NTFS 和 Git Bash (MSYS2) 大小写不敏感地解析命令名称。
  caseInsensitiveFilesystem: true,
  platformSpecificDangerCommands: WIN32_DANGER_COMMANDS,
  platformSpecificCatastrophicCommands: WIN32_CATASTROPHIC_COMMANDS,
  // `.cmd`/`.bat` shims（npm/npx/prettier）需要 shell 来启动。
  scriptShimsRequireShell: true,
  toolIndicatorGlyph: "●", // ● 黑色大圆圈 — 见 OsCapabilities JSDoc
  // Windows Terminal / PowerShell 直接传递原始滚轮刻度，
  // 没有 OS 级加速。3× 使感知到的滚动速度
  // 更接近 macOS 默认值，这是大多数用户比较的标准。
  // 见 OsCapabilities JSDoc 了解原理。
  conversationScrollMultiplier: 3,
};

export function selectOsCapabilities(): OsCapabilities {
  switch (currentPlatform()) {
    case "darwin":
      return DARWIN_CAPS;
    case "linux":
      return LINUX_CAPS;
    case "win32":
      return WIN32_CAPS;
  }
}
