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
 * 为终端复用器包装 OSC 52 序列，使其到达外部终端而不会被吞没。
 *
 * - tmux：原样发出序列。tmux 的 `set-clipboard`（自 3.2 起默认为 `external`/`on`）
 *   已拦截应用程序的 OSC 52 并将其转发到外部终端。而 `\x1bPtmux; DCS-passthrough`
 *   形式则需要 `allow-passthrough on`——自 tmux 3.3 起默认关闭——否则会被静默丢弃，
 *   使之前通过 set-clipboard 正常复制的用户退化。
 * - screen：包装为 `\x1bP<seq>\x1b\\`。screen 没有 set-clipboard 转发，
 *   因此 DCS 直通信封是唯一的出口。
 *   （注意：GNU screen 会截断非常长的 DCS 字符串（约 768 字节），因此在 screen 下
 *   大型剪贴板负载仍可能被截断。）
 *
 * 通过 `$TMUX` / `$STY` 和 `$TERM` 前缀检测。在复用器外部，序列原样返回。
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
      // 如果 stderr 不是 TTY，转义序列无法到达终端——诚实地报告失败，
      // 以便调用者可以回退到更强的路径（例如渲染器自身的 OSC 52，
      // 它基于真实的终端能力检测），而不是在什么都没发生的情况下被告知复制成功。
      if (!process.stderr.isTTY) return false;
      // 将负载编码为 base64；OSC 52 格式为 `\x1b]52;c;<base64>\x07`。
      // `c` 选择系统剪贴板。我们故意写入 stderr，以免序列在管道中与子进程 stdout 混合。
      // 为 tmux/screen 包装，使序列不会被复用器吞没。
      const payload = Buffer.from(text, "utf8").toString("base64");
      process.stderr.write(wrapForMultiplexer(`\x1b]52;c;${payload}\x07`));
      return true;
    } catch {
      return false;
    }
  },

  async readImage(): Promise<ClipboardImage | null> {
    // OSC 52 在实践中是只写的。
    return null;
  },
};