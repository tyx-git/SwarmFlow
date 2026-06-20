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
        try { proc.kill(); } catch { }
        resolve(false);
      }, 2000);
      proc.on("error", () => { clearTimeout(timer); resolve(false); });
      proc.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
      // 使用 UTF-16LE BOM 前缀可保留 Unicode 往返一致性。
      // 没有 BOM 时，clip.exe 会回退到活动 ANSI 代码页，导致 CJK/emoji 乱码。
      const bom = Buffer.from([0xff, 0xfe]);
      const body = Buffer.from(text, "utf16le");
      proc.stdin.end(Buffer.concat([bom, body]));
    } catch {
      resolve(false);
    }
  });
}

function buildReadImageScript(outPath: string): string {
  // PowerShell 脚本：加载 WinForms，获取剪贴板图像，保存为 PNG。
  // 反引号转义路径中的特殊字符。成功时返回 "png"，无图像时返回空字符串。
  //
  // `$null -ne $img`（而非 `$img -ne $null`）符合 PSScriptAnalyzer 推荐的
  // 顺序——当左侧是集合时更安全，因为 PowerShell 的 `-ne` 会分布到数组上。
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
    // 异步 spawn（而非 spawnSync）：PowerShell 启动约 300 ms，调用最长可达 5 秒超时。
    // 同步 spawn 会在此窗口期间阻塞 Node 事件循环，在用户粘贴时冻结所有 TUI 渲染和输入。
    // execFile 在非零退出时拒绝，由 catch 转换为 null。
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
      // 忽略清理错误
    }
  }
}

export const win32Clipboard: ClipboardProvider = {
  id: "win32-clip.exe+powershell",

  async writeText(text: string): Promise<boolean> {
    if (process.platform !== "win32") return false;
    const ok = await writeTextViaClipExe(text);
    if (ok) return true;
    // 尾部回退：通过终端 OSC 52。在 Windows Terminal、ConEmu、Cmder 中有效。
    // 在传统 cmd.exe 窗口中无效。
    return osc52Clipboard.writeText(text);
  },

  async readImage(): Promise<ClipboardImage | null> {
    if (process.platform !== "win32") return null;
    return readImageViaPowerShell();
  },
};