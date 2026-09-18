/**
 * macOS 剪贴板 provider。
 *
 * 文本：pbcopy
 * 图片：osascript + AppKit NSPasteboard
 *
 * 从 macOS 剪贴板读取图片数据需要 AppleScript，
 * 因为没有命令行工具暴露任意 UTI 的原始字节。我们通过 NSData
 * writeToFile:atomically: 导出到临时文件并读取。
 */

import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ClipboardImage, ClipboardImageMediaType, ClipboardProvider } from "../types.js";

const execFileAsync = promisify(execFile);

const UTI_TO_MEDIA_TYPE: Record<string, ClipboardImageMediaType> = {
  "public.png": "image/png",
  "public.tiff": "image/tiff",
  "public.jpeg": "image/jpeg",
};

function buildExportScript(outPath: string): string {
  return `
use framework "AppKit"
set pb to current application's NSPasteboard's generalPasteboard()
set types to {"public.png", "public.tiff", "public.jpeg"}
repeat with t in types
  set d to pb's dataForType:t
  if d is not missing value then
    d's writeToFile:"${outPath}" atomically:true
    return t as text
  end if
end repeat
return ""
`;
}

export const darwinClipboard: ClipboardProvider = {
  id: "darwin-pbcopy+osascript",

  async writeText(text: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      try {
        const proc = spawn("pbcopy", { stdio: ["pipe", "ignore", "ignore"] });
        const timer = setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch {}
          resolve(false);
        }, 2000);
        proc.on("error", () => { clearTimeout(timer); resolve(false); });
        proc.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
        proc.stdin.end(text);
      } catch {
        resolve(false);
      }
    });
  },

  async readImage(): Promise<ClipboardImage | null> {
    const tempPath = join(tmpdir(), `swarmflow-clipboard-${process.pid}-${Date.now()}.img`);

    try {
      const { stdout } = await execFileAsync("osascript", ["-e", buildExportScript(tempPath)], {
        timeout: 5000,
      });

      const uti = stdout.trim();
      const mediaType = UTI_TO_MEDIA_TYPE[uti];
      if (!mediaType) return null;

      if (!existsSync(tempPath)) return null;

      const buffer = readFileSync(tempPath);
      if (buffer.length === 0) return null;

      return { buffer, mediaType };
    } catch {
      return null;
    } finally {
      try {
        if (existsSync(tempPath)) unlinkSync(tempPath);
      } catch {
        // ignore cleanup errors
      }
    }
  },
};
