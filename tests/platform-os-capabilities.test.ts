import { afterEach, describe, expect, it } from "bun:test";

import { selectOsCapabilities } from "../src/platform/os-capabilities/index.js";

/**
 * `selectOsCapabilities()` reads `process.platform` through
 * `currentPlatform()`. The tests below temporarily override
 * `process.platform` so all three branches are exercised on any host
 * — `bun test` runs only on macOS here but the dispatcher must hold
 * up on every platform CI eventually runs on.
 */
function withPlatform<T>(value: NodeJS.Platform, fn: () => T): T {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
}

describe("selectOsCapabilities", () => {
  afterEach(() => {
    // Defensive: every test restores process.platform via withPlatform,
    // but if a test throws inside fn() before the restore, this
    // afterEach lets the following test start from a known state.
    Object.defineProperty(process, "platform", { value: process.platform, configurable: true });
  });

  it("reports POSIX permissions on darwin", () => {
    const caps = withPlatform("darwin", selectOsCapabilities);
    expect(caps.supportsPosixPermissions).toBe(true);
    expect(caps.platformSpecificDangerCommands.size).toBe(0);
    expect(caps.platformSpecificCatastrophicCommands.size).toBe(0);
    // Default macOS APFS/HFS+ is case-insensitive, so command-name
    // matching in the classifier must be case-insensitive too.
    expect(caps.caseInsensitiveFilesystem).toBe(true);
    expect(caps.scriptShimsRequireShell).toBe(false);
    expect(caps.toolIndicatorGlyph).toBe("⏺"); // U+23FA, renders correctly in mono fonts on macOS
    expect(caps.conversationScrollMultiplier).toBe(1);
  });

  it("reports POSIX permissions on linux", () => {
    const caps = withPlatform("linux", selectOsCapabilities);
    expect(caps.supportsPosixPermissions).toBe(true);
    expect(caps.platformSpecificDangerCommands.size).toBe(0);
    expect(caps.platformSpecificCatastrophicCommands.size).toBe(0);
    // Default Linux ext4/btrfs are case-sensitive — `RM` is a distinct
    // file from `rm`, so the classifier keeps case-sensitive matching.
    expect(caps.caseInsensitiveFilesystem).toBe(false);
    expect(caps.scriptShimsRequireShell).toBe(false);
    expect(caps.toolIndicatorGlyph).toBe("⏺");
    expect(caps.conversationScrollMultiplier).toBe(1);
  });

  it("disables POSIX permissions and ships Windows danger commands on win32", () => {
    const caps = withPlatform("win32", selectOsCapabilities);
    expect(caps.supportsPosixPermissions).toBe(false);
    // NTFS / Git Bash (MSYS2) resolve command names case-insensitively.
    expect(caps.caseInsensitiveFilesystem).toBe(true);
    expect(caps.scriptShimsRequireShell).toBe(true);
    expect(caps.platformSpecificDangerCommands.has("reg")).toBe(true);
    expect(caps.platformSpecificDangerCommands.has("bcdedit")).toBe(true);
    expect(caps.platformSpecificDangerCommands.has("netsh")).toBe(true);
    expect(caps.platformSpecificDangerCommands.has("taskkill")).toBe(true);
    expect(caps.platformSpecificDangerCommands.has("wmic")).toBe(true);
    // Disk-wipe tools are catastrophic (yolo still prompts), not merely
    // danger — they live in the catastrophic set, not the danger set.
    expect(caps.platformSpecificDangerCommands.has("format")).toBe(false);
    expect(caps.platformSpecificDangerCommands.has("diskpart")).toBe(false);
    expect(caps.platformSpecificCatastrophicCommands.has("format")).toBe(true);
    expect(caps.platformSpecificCatastrophicCommands.has("diskpart")).toBe(true);
    expect(caps.toolIndicatorGlyph).toBe("⬤"); // U+2B24 — avoids PowerShell's square-outlined record icon fallback
    expect(caps.conversationScrollMultiplier).toBe(3);
  });

  it("stores Windows danger/catastrophic command names lowercased so the classifier's case-insensitive lookup works", () => {
    const caps = withPlatform("win32", selectOsCapabilities);
    for (const name of caps.platformSpecificDangerCommands) {
      expect(name).toBe(name.toLowerCase());
    }
    for (const name of caps.platformSpecificCatastrophicCommands) {
      expect(name).toBe(name.toLowerCase());
    }
  });

  it("falls back to the linux profile for unknown platforms", () => {
    // BSDs, sunos, aix — `currentPlatform()` clamps to linux for these.
    const caps = withPlatform("freebsd" as NodeJS.Platform, selectOsCapabilities);
    expect(caps.supportsPosixPermissions).toBe(true);
  });
});
