/**
 * Linux 剪贴板 provider。
 *
 * 在模块加载时探测环境一次：
 *   1. Wayland（设置了 `$WAYLAND_DISPLAY` + `$PATH` 上有 `wl-copy`/`wl-paste`）
 *      → 使用 wl-clipboard
 *   2. X11（设置了 `$DISPLAY` + `$PATH` 上有 `xclip`）→ 使用 xclip
 *   3. 否则 → 回退到 OSC 52（仅文本）
 *
 * 图片读取仅在有正确工具的 Wayland 或 X11 下工作；
 * 回退返回 null。
 */

import { spawn } from "node:child_process";

import type { ClipboardImage, ClipboardImageMediaType, ClipboardProvider } from "../types.js";
import { commandExists, linuxDisplayServer } from "../detect.js";
import { osc52Clipboard } from "./osc52.js";

interface LinuxClipboardTooling {
  /** 用于诊断的标识符。 */
  id: string;
  /** 返回通过 stdin 写入文本的命令 + 参数。 */
  writeTextCmd: () => { command: string; args: string[] };
  /** 返回将给定 UTI 的图像字节输出到 stdout 的命令 + 参数，不支持时返回 null。 */
  readImageCmd: ((mime: string) => { command: string; args: string[] }) | null;
}

function wlClipboardTooling(): LinuxClipboardTooling | null {
  if (!commandExists("wl-copy")) return null;
  return {
    id: "linux-wayland-wl-clipboard",
    writeTextCmd: () => ({ command: "wl-copy", args: [] }),
    readImageCmd: commandExists("wl-paste")
      ? (mime) => ({ command: "wl-paste", args: ["-t", mime] })
      : null,
  };
}

function xclipTooling(): LinuxClipboardTooling | null {
  if (!commandExists("xclip")) return null;
  return {
    id: "linux-x11-xclip",
    writeTextCmd: () => ({ command: "xclip", args: ["-selection", "clipboard"] }),
    readImageCmd: (mime) => ({
      command: "xclip",
      args: ["-selection", "clipboard", "-t", mime, "-o"],
    }),
  };
}

function xselTooling(): LinuxClipboardTooling | null {
  if (!commandExists("xsel")) return null;
  return {
    id: "linux-x11-xsel",
    writeTextCmd: () => ({ command: "xsel", args: ["--clipboard", "--input"] }),
    // xsel 不支持图像读取。
    readImageCmd: null,
  };
}

/**
 * 可用剪贴板工具的有序列表。显示服务器设置的是*优先级*，而不是*排他性*：
 * 在 Wayland 下，XWayland 几乎是通用的，因此 xclip/xsel 仍可针对桥接剪贴板工作，
 * 在 wl-clipboard 缺失时必须作为回退（M-2 bug：Wayland 会话 + xclip 但无 wl-clipboard
 * 此前会直接落到 OSC 52）。当未检测到显示服务器时，我们构建一个空链，因此 writeText
 * 直接进入 OSC 52 尾部，readImage 返回 null。这实现了 types.ts 中记录的
 * wl-copy → xclip → OSC 52 级联。
 */
function pickToolingChain(): LinuxClipboardTooling[] {
  const server = linuxDisplayServer();
  if (server === "none") return [];

  const wl = wlClipboardTooling();
  const xclip = xclipTooling();
  const xsel = xselTooling();

  // 首先优先选用活动显示服务器的原生工具，将其他 GUI 工具保留为回退。
  const ordered = server === "wayland"
    ? [wl, xclip, xsel]
    : [xclip, xsel, wl];
  return ordered.filter((t): t is LinuxClipboardTooling => t !== null);
}

const toolingChain = pickToolingChain();

async function writeViaTooling(t: LinuxClipboardTooling, text: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const { command, args } = t.writeTextCmd();
      const proc = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
      const timer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { }
        resolve(false);
      }, 2000);
      proc.on("error", () => { clearTimeout(timer); resolve(false); });
      proc.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
      proc.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}

async function readImageBytes(
  t: LinuxClipboardTooling,
  mime: string,
): Promise<Buffer | null> {
  if (!t.readImageCmd) return null;
  return new Promise<Buffer | null>((resolve) => {
    try {
      const { command, args } = t.readImageCmd!(mime);
      const proc = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { }
        resolve(null);
      }, 5000);
      proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      proc.on("error", () => { clearTimeout(timer); resolve(null); });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && chunks.length > 0) {
          resolve(Buffer.concat(chunks));
        } else {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

const IMAGE_MIME_TYPES: { mime: string; mediaType: ClipboardImageMediaType }[] = [
  { mime: "image/png", mediaType: "image/png" },
  { mime: "image/jpeg", mediaType: "image/jpeg" },
  { mime: "image/tiff", mediaType: "image/tiff" },
];

export const linuxClipboard: ClipboardProvider = {
  // 反映模块加载时选择的主要机制。注意单次 writeText() 调用会遍历整个工具链，
  // 并可能回退到 OSC 52，因此单次调用实际使用的机制可能与此 id 不同。
  // 将其视为诊断上下文，而非每次调用的精确性保证。
  id: toolingChain[0] ? toolingChain[0].id : "linux-osc52-fallback",

  async writeText(text: string): Promise<boolean> {
    // 按优先级顺序遍历链；第一个成功的工具获胜。
    for (const tooling of toolingChain) {
      const ok = await writeViaTooling(tooling, text);
      if (ok) return true;
    }
    // 链尾：终端 OSC 52。
    return osc52Clipboard.writeText(text);
  },

  async readImage(): Promise<ClipboardImage | null> {
    for (const tooling of toolingChain) {
      if (!tooling.readImageCmd) continue;
      for (const { mime, mediaType } of IMAGE_MIME_TYPES) {
        const buffer = await readImageBytes(tooling, mime);
        if (buffer && buffer.length > 0) {
          return { buffer, mediaType };
        }
      }
    }
    return null;
  },
};