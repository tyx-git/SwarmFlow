/**
 * 内置 OpenTUI fork 的类型增强（ambient declaration）。
 *
 * 背景：TUI 同时使用 npm 包 @opentui/react + @opentui/core 0.4.1 和仓库内 fork 的
 * Renderable/ScrollBox 增量能力；这些声明只覆盖两边确实缺少的类型信息。
 *
 * 本文件只登记“应用确实用到、且已在内置 fork 中确认存在”的增量成员，语义与 fork 源码一致
 * （每条注释给出对应源码位置）。今后用到新的扩展 API 时请在此同步登记，
 * 否则类型又会与运行期不一致。
 */
import type {
  BaseRenderable,
  MousePointerStyle,
  ScrollBoxRenderable,
} from "@opentui/core";

declare module "@opentui/core" {
  /** external/opentui/forked/core/Renderable.ts:133 */
  interface RenderableOptions<T extends BaseRenderable = BaseRenderable> {
    cursor?: MousePointerStyle;
    /** external/opentui/forked/core/renderables/Box.ts:38 */
    fillTransparentBackground?: boolean;
  }

  /** external/opentui/forked/core/renderables/ScrollBox.ts:75 */
  interface ScrollBoxOptions {
    /** true 时内容按自然高度收缩，不填满视口。 */
    fitContent?: boolean;
  }

  /** external/opentui/forked/core/renderer.ts:1551 / 3139 */
  interface CliRenderer {
    /** 强制下一帧全量重绘（会话恢复后重新断言终端物理状态）。 */
    requestFullRepaint(): void;
    resetMouseTracking(): void;
  }
}
