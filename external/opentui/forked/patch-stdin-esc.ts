// @ts-nocheck
/**
 * 运行时补齐 @opentui/core 的裸 ESC 判定，让"按下 Esc"一定能送达应用。
 *
 * 背景（本仓库的 fork 分工，见 patch-ffi-bounds.ts:5-9）：`./core/` 只是源码
 * 镜像，运行期加载的是 node_modules/@opentui/core 的预编译产物，因此需要生效
 * 的行为修正必须对成品包打运行期补丁。本文件与 ./core/lib/stdin-parser.ts
 * 里 `splitElapsedLoneEsc` 的镜像修正是同一处修正的两个面。
 *
 * 修的故障（用户实录）：主会话派生的子代理正在刷屏时按 Esc 完全无反应，
 * 只有 Ctrl+C 能中断。裸 ESC 必须等超时才判定为按键（成品包 StdinParser
 * 的 "esc" 状态，timeoutMs 由渲染器构造时固定传 20），而这 20ms 内到达的任何
 * 字节都会被当作子协议判别符，于是"Esc 键 + 紧随其后的上报序列"被合并成同一个
 * 协议单元。上报序列（焦点报告 ESC [ I、SGR/X10 鼠标上报、终端能力与 CPR 回复）
 * 全部以 ESC 引导，而子代理刷屏时鼠标移动与焦点切换都会产生它们。合并单元一旦
 * 不是可识别按键就降级成 response 被静默丢弃 —— 用户那枚 Esc 就此消失；
 * Ctrl+C 是单字节 0x03，无需超时判定，所以总能送达。conhost / PowerShell 不协商
 * kitty，恒走这条 raw + 超时路径。
 *
 * 补齐方式：包住解析器实例的 push。新分片以 ESC 开头、而此刻正挂着一枚已挂满
 * 判定窗口的裸 ESC 时，先走既有的超时冲刷路径把那枚 ESC 冲刷成 Escape 事件
 * （交回队列头部，投递顺序不变），再让新分片按原逻辑解析。这样任何类型的上报
 * 序列都吞不掉用户刚按下的 Esc。
 *
 * 只碰成品包未被压缩的成员（state / pending / pendingSinceMs / timeoutMs /
 * forceFlush / events / read / push），挂不上就返回原因并由调用方记入诊断日志，
 * 不允许静默失效。Alt+组合键（新分片在窗口内到达，未挂满）保持合并语义不变。
 *
 * 注意调用时机：必须在 createCliRenderer 之后 —— 解析器实例由渲染器构造函数创建，
 * 与 patch-ffi-bounds 的"创建之前"相反。
 */
import { writeOpenTuiDiag } from "./core/lib/diagnostic.js";

const ESC_BYTE = 0x1b;

export interface StdinEscapePatchResult {
  patched: boolean;
  reason?: string;
}

/** 成品包解析器的最小形状（未被压缩的成员名）。 */
interface StdinParserLike {
  state?: { tag?: string };
  pending?: { length?: number };
  pendingSinceMs?: number | null;
  timeoutMs?: number;
  forceFlush?: boolean;
  events?: unknown[];
  read?: () => unknown;
  push?: (data: Uint8Array) => void;
  clock?: { now(): number };
  __swarmflowEscPatch?: boolean;
}

function parseableLike(renderer: unknown): StdinParserLike | null {
  const parser = (renderer as { stdinParser?: StdinParserLike } | null | undefined)?.stdinParser;
  if (!parser) return null;
  return parser;
}

/**
 * 给渲染器的 stdin 解析器装上 Esc 补齐。返回是否真的挂上：
 * 挂不上（成品包结构变化、成员改名）必须由调用方记入诊断日志。
 */
export function installStdinEscapePatch(renderer: unknown): StdinEscapePatchResult {
  const parser = parseableLike(renderer);
  if (!parser) return { patched: false, reason: "stdin_parser_missing" };
  if (typeof parser.push !== "function" || typeof parser.read !== "function") {
    return { patched: false, reason: "parser_api_missing" };
  }
  if (!Array.isArray(parser.events)) return { patched: false, reason: "event_queue_missing" };
  if (typeof parser.timeoutMs !== "number") return { patched: false, reason: "timeout_member_missing" };
  if (parser.__swarmflowEscPatch) return { patched: true };

  const originalPush = parser.push.bind(parser);
  const events = parser.events;
  // 用解析器自己的时钟（渲染器可注入 clock），退化到 performance.now。
  const now = (): number => (typeof parser.clock?.now === "function" ? parser.clock.now() : performance.now());
  parser.push = (data: Uint8Array): void => {
    // 迟到的上报序列不得吞掉用户按下的那枚 Esc：已挂满判定窗口的裸 ESC
    // 先冲刷成 Escape 事件，新分片再从干净状态解析。
    if (
      data && data.length > 0 && data[0] === ESC_BYTE
      && parser.state?.tag === "esc"
      && parser.pending?.length === 1
      && parser.pendingSinceMs !== null && parser.pendingSinceMs !== undefined
      && now() - parser.pendingSinceMs >= parser.timeoutMs
    ) {
      parser.forceFlush = true;
      const flushed = parser.read();
      if (flushed) {
        // 交回队列头部：投递顺序与不补齐时完全一致，只是这条不再会消失。
        events.unshift(flushed);
      }
    }
    return originalPush(data);
  };
  parser.__swarmflowEscPatch = true;

  writeOpenTuiDiag("patch.stdin_escape.installed", { patched: true });
  return { patched: true };
}
