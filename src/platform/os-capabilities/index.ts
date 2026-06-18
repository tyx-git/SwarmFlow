/**
 * Coarse OS capability flags. Used to gate operations whose semantics
 * differ (or simply don't exist) on Windows without leaking
 * `process.platform` checks into business code.
 */

import type { OsCapabilities } from "../types.js";
import { currentPlatform } from "../detect.js";

// Fields shared by both POSIX platforms (macOS + Linux). They diverge
// only on caseInsensitiveFilesystem, so each spreads this base and
// sets that flag explicitly below.
const POSIX_SHARED: Omit<OsCapabilities, "caseInsensitiveFilesystem"> = {
  supportsPosixPermissions: true,
  // POSIX has no platform-specific danger/catastrophic commands beyond
  // the shared POSIX sets already in classify.ts (rm/sudo/chmod and
  // mkfs/fdisk/dd respectively).
  platformSpecificDangerCommands: new Set(),
  platformSpecificCatastrophicCommands: new Set(),
  // POSIX execs every $PATH entry directly 鈥?no shell needed for shims.
  scriptShimsRequireShell: false,
  toolIndicatorGlyph: "鈴?, // 鈴?BLACK CIRCLE FOR RECORD
  conversationScrollMultiplier: 1,
};

const DARWIN_CAPS: OsCapabilities = {
  ...POSIX_SHARED,
  // Default macOS APFS/HFS+ is case-insensitive, so the shell resolves
  // `RM`/`SUDO` to the same binary as the lowercase form.
  caseInsensitiveFilesystem: true,
};

const LINUX_CAPS: OsCapabilities = {
  ...POSIX_SHARED,
  // Default Linux ext4/btrfs are case-sensitive.
  caseInsensitiveFilesystem: false,
};

// Lowercased 鈥?see OsCapabilities.platformSpecificDangerCommands
// JSDoc for the case-insensitivity rationale.
const WIN32_DANGER_COMMANDS: ReadonlySet<string> = new Set([
  "reg",        // registry editor
  "bcdedit",    // boot configuration
  "netsh",      // network configuration
  "taskkill",   // kill processes by name/pid
  "wmic",       // WMI command-line
]);

// Irreversible disk-wipe executables 鈥?escalate to catastrophic (the
// only class that still prompts in yolo mode), not merely write_danger.
const WIN32_CATASTROPHIC_COMMANDS: ReadonlySet<string> = new Set([
  "format",     // disk format
  "diskpart",   // disk partitioning
]);

const WIN32_CAPS: OsCapabilities = {
  supportsPosixPermissions: false,
  // NTFS and Git Bash (MSYS2) resolve command names case-insensitively.
  caseInsensitiveFilesystem: true,
  platformSpecificDangerCommands: WIN32_DANGER_COMMANDS,
  platformSpecificCatastrophicCommands: WIN32_CATASTROPHIC_COMMANDS,
  // `.cmd`/`.bat` shims (npm/npx/prettier) need a shell to launch.
  scriptShimsRequireShell: true,
  toolIndicatorGlyph: "猬?, // 猬?BLACK LARGE CIRCLE 鈥?see OsCapabilities JSDoc
  // Windows Terminal / PowerShell deliver raw wheel ticks without
  // OS-level acceleration. 3脳 brings the perceived scroll speed
  // closer to the macOS default, which is what most users compare
  // against. See OsCapabilities JSDoc for the rationale.
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
