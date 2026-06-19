/**
 * OSC 52 剪贴板回退。
 *
 * 通过 OSC 52 转义序列将文本写入终端模拟器的剪贴板。
 * 被大多数现代终端支持（kitty、wezterm、iTerm2、alacritty（需配置）、
 * 最近的 gnome-terminal、tmux 2.6+ 且 `set -g set-clipboard on`）。
 *
 * 用作 Linux 上调度链的尾部（当 wl-copy/xclip 缺失时）
 * 和各地的优雅降级。
 *
 * 无法读取剪贴板——该协议从应用程序端是只写的，没有协作终端，
 * 这在实践中基本上永远不起作用。
 */

import type { ClipboardImage, ClipboardProvider } from "../types.js";

/**
 * Wrap an OSC 52 sequence for a terminal multiplexer so it reaches the
 * outer terminal instead of being swallowed.
 *
 * - tmux: emit the sequence UNCHANGED. tmux's `set-clipboard` (default
 *   `external`/`on` since 3.2) already intercepts an app's OSC 52 and
 *   forwards it to the outer terminal. The `\x1bPtmux; DCS-passthrough
 *   form would instead REQUIRE `allow-passthrough on` —OFF by default
 *   since tmux 3.3 —and be silently dropped otherwise, regressing users
 *   whose copy previously worked via set-clipboard.
 * - screen: wrap as `\x1bP<seq>\x1b\\`. screen has no set-clipboard
 *   forwarding, so the DCS passthrough envelope is the only way out.
 *   (Note: GNU screen truncates very long DCS strings (~768 bytes), so a
 *   large clipboard payload may still be clipped under screen.)
 *
 * Detected via `$TMUX` / `$STY` and the `$TERM` prefix. Outside a
 * multiplexer the sequence is returned unchanged.
 */
function wrapForMultiplexer(seq: string): string {
  const term = process.env["TERM"] ?? "";
  const inTmux = Boolean(process.env["TMUX"]) || term.startsWith("tmux");
  if (inTmux) return seq;
  const inScreen = Boolean(process.env["STY"]) || term.startsWith("screen");
  if (inScreen) return `\x1bP${seq}\x1b\\`;
  return seq;
}

export const osc52Clipboard: ClipboardProvider = {
  id: "osc52",

  async writeText(text: string): Promise<boolean> {
    try {
      // If stderr isn't a TTY the escape sequence can't reach a
      // terminal —report failure honestly so the caller can fall
      // through to a stronger path (e.g. the renderer's own OSC 52,
      // which is gated on real terminal capability detection) instead
      // of being told the copy succeeded when nothing happened.
      if (!process.stderr.isTTY) return false;
      // Encode payload as base64; OSC 52 is `\x1b]52;c;<base64>\x07`.
      // `c` selects the system clipboard. We deliberately write to
      // stderr so the sequence doesn't get mingled with subprocess
      // stdout in pipelines. Wrap for tmux/screen so the sequence isn't
      // swallowed by the multiplexer.
      const payload = Buffer.from(text, "utf8").toString("base64");
      process.stderr.write(wrapForMultiplexer(`\x1b]52;c;${payload}\x07`));
      return true;
    } catch {
      return false;
    }
  },

  async readImage(): Promise<ClipboardImage | null> {
    // OSC 52 is write-only in practice.
    return null;
  },
};
