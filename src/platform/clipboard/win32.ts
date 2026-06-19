/**
 * Windows 剪贴板 provider。
 *
 * 文本：通过 `clip.exe`（自 Vista 以来内置于 Windows）传输，
 *       带有 UTF-16LE 字节顺序标记，以便非 ASCII（CJK、emoji 等）
 *       存活往返。clip.exe 将其记录为全 Unicode 支持的
 *       预期编码；原始 UTF-8 通过活动 ANSI 代码页解释，
 *       会损坏 CJK。
 *
 *       当 clip.exe 失败时（罕见——出现在 Nano Server、
 *       某些容器设置中），回退到 OSC 52，以便在
 *       Windows Terminal / ConEmu / Cmder 中运行的用户仍能获得可用的复制。
 *
 * 图片：PowerShell `[System.Windows.Forms.Clipboard]::GetImage()`
 *       将 PNG 写入临时文件。由于 PowerShell 启动
 *       （约 300 ms）较慢，但在 stock Windows 10+ 上可靠。
 *
 * 两种方法都遵循推测调用约定：当能力不可用或剪贴板
 * 不包含相关内容时，返回 null / false 而不是抛出。
 */

import { spawn, execFile } from "node:child_process";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import type { ClipboardImage, ClipboardProvider } from "../types.js";
import { osc52Clipboard } from "./osc52.js";

function writeTextViaClipExe(text: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const proc = spawn("clip.exe", {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        try { proc.kill(); } catch {}
        resolve(false);
      }, 2000);
      proc.on("error", () => { clearTimeout(timer); resolve(false); });
      proc.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
      // clip.exe with a UTF-16LE BOM prefix preserves Unicode round-trip.
      // Without the BOM clip.exe falls back to the active ANSI code
      // page and mangles CJK / emoji.
      const bom = Buffer.from([0xff, 0xfe]);
      const body = Buffer.from(text, "utf16le");
      proc.stdin.end(Buffer.concat([bom, body]));
    } catch {
      resolve(false);
    }
  });
}

function buildReadImageScript(outPath: string): string {
  // PowerShell script: load WinForms, fetch clipboard image, save as
  // PNG. Backticks escape special chars in the path. Returns "png" on
  // success or empty string when there's no image.
  //
  // `$null -ne $img` (vs. `$img -ne $null`) matches PSScriptAnalyzer's
  // recommended order —safer when the LHS is a collection because
  // PowerShell's `-ne` distributes over arrays.
  const escapedPath = outPath.replace(/'/g, "''");
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$img = [System.Windows.Forms.Clipboard]::GetImage()",
    `if ($null -ne $img) { $img.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png); 'png' } else { '' }`,
  ].join("; ");
}

async function readImageViaPowerShell(): Promise<ClipboardImage | null> {
  const tempPath = join(tmpdir(), `swarmflow-clipboard-${process.pid}-${Date.now()}.png`);

  try {
    // Async spawn (not spawnSync): PowerShell startup is ~300 ms and
    // the call can run up to the 5 s timeout. A synchronous spawn would
    // block the single Node event loop for that whole window, freezing
    // all TUI rendering and input while the user pastes. execFile
    // rejects on a non-zero exit, which the catch turns into null.
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", buildReadImageScript(tempPath)],
      { encoding: "utf8", windowsHide: true, timeout: 5000 },
    );

    const out = typeof stdout === "string" ? stdout.trim() : "";
    if (out !== "png") return null;
    if (!existsSync(tempPath)) return null;

    const buffer = readFileSync(tempPath);
    if (buffer.length === 0) return null;

    return { buffer, mediaType: "image/png" };
  } catch {
    return null;
  } finally {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // ignore cleanup errors
    }
  }
}

export const win32Clipboard: ClipboardProvider = {
  id: "win32-clip.exe+powershell",

  async writeText(text: string): Promise<boolean> {
    if (process.platform !== "win32") return false;
    const ok = await writeTextViaClipExe(text);
    if (ok) return true;
    // Tail fallback: OSC 52 via terminal. Works in Windows Terminal,
    // ConEmu, Cmder. Won't help in the legacy cmd.exe window.
    return osc52Clipboard.writeText(text);
  },

  async readImage(): Promise<ClipboardImage | null> {
    if (process.platform !== "win32") return null;
    return readImageViaPowerShell();
  },
};
