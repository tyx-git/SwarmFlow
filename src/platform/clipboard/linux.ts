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
  /** Identifier for diagnostics. */
  id: string;
  /** Returns command + args to write text via stdin. */
  writeTextCmd: () => { command: string; args: string[] };
  /** Returns command + args that emit image bytes for the given UTI to stdout, or null when unsupported. */
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
    // xsel doesn't support image reads.
    readImageCmd: null,
  };
}

/**
 * Ordered list of available clipboard tools. The display server sets
 * *priority*, not *exclusivity*: under Wayland, XWayland is near-
 * universal so xclip/xsel still work against the bridged clipboard and
 * must remain fallbacks when wl-clipboard is absent (the M-2 bug:
 * Wayland session + xclip-but-no-wl-clipboard previously fell straight
 * through to OSC 52). When no display server is detected we build an
 * empty chain so writeText goes straight to the OSC 52 tail and
 * readImage returns null. This realizes the wl-copy →xclip →OSC 52
 * cascade documented in types.ts.
 */
function pickToolingChain(): LinuxClipboardTooling[] {
  const server = linuxDisplayServer();
  if (server === "none") return [];

  const wl = wlClipboardTooling();
  const xclip = xclipTooling();
  const xsel = xselTooling();

  // Prefer the active display server's native tool first, keep the
  // other GUI tools as fallbacks.
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
        try { proc.kill("SIGKILL"); } catch {}
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
  // Reflects the primary mechanism chosen at module load. Note that a
  // single writeText() call walks the whole tool chain and may fall
  // through to OSC 52, so the actual mechanism used for an individual
  // call may differ from this id. Treated as diagnostic context, not a
  // per-call accuracy guarantee.
  id: toolingChain[0] ? toolingChain[0].id : "linux-osc52-fallback",

  async writeText(text: string): Promise<boolean> {
    // Walk the chain in priority order; first tool that succeeds wins.
    for (const tooling of toolingChain) {
      const ok = await writeViaTooling(tooling, text);
      if (ok) return true;
    }
    // Tail of the chain: terminal OSC 52.
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
