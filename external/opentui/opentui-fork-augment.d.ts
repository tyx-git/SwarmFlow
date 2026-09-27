/**
 * 内置 OpenTUI fork 的类型增强（ambient declaration）。
 *
 * 背景：TUI 运行期用的是仓库内的 fork（external/opentui/forked/core，由 main.tsx 注册
 * forked/core/renderables/*.js），而 JSX/props 类型来自 npm 包 @opentui/react + @opentui/core
 * 0.4.1 —— 那是 fork 的一个较旧子集。因此只要用到 fork 独有 API，编辑器就会报
 * "Property 'x' does not exist on type 'BoxProps' / 'ScrollBoxProps' / 'CliRenderer'"。
 *
 * 本文件只登记“应用确实用到、且已在内置 fork 中确认存在”的增量成员，语义与 fork 源码一致
 * （每条注释给出 fork 中的 file:line）。今后用到新的 fork 独有 API 时请在此同步登记，
 * 否则类型又会与运行期不一致。
 */
import type {
  BaseRenderable,
  BoxRenderable,
  ColorInput,
  MarkdownRenderable,
  MousePointerStyle,
  Renderable,
  ScrollBoxRenderable,
} from "@opentui/core";

declare module "@opentui/core" {
  /** forked/core/Renderable.ts:133 —— 所有 renderable 都可指定鼠标指针形状。 */
  interface RenderableOptions<T extends BaseRenderable = BaseRenderable> {
    cursor?: MousePointerStyle;
  }

  /** forked/core/renderables/Box.ts:31-38 —— box 的分隔线与透明填充扩展。 */
  interface BoxOptions<TRenderable extends Renderable = BoxRenderable> {
    /** 顶边框竖直分隔线的位置（0–1，按 box 宽度的比例）。 */
    dividerRatio?: number;
    /** 分隔线之后的标题文本。 */
    dividerTitle?: string;
    /** 分隔线标题颜色（默认取 borderColor）。 */
    dividerTitleColor?: ColorInput;
    /** 用透明背景填充，避免父级背景透出。 */
    fillTransparentBackground?: boolean;
  }

  /** forked/core/renderables/ScrollBox.ts:75 */
  interface ScrollBoxOptions {
    /** true 时内容按自然高度收缩，不填满视口。 */
    fitContent?: boolean;
  }

  /** forked/core/renderables/Code.ts:39 */
  interface CodeOptions {
    /** 流式输出期间预留高度，避免逐行跳动。 */
    reserveHeightWhileStreaming?: boolean;
  }

  /** forked/core/renderables/Markdown.ts:119 */
  interface MarkdownOptions {
    reserveHeightWhileStreaming?: boolean;
  }

  /** forked/core/renderer.ts:1551 / 3139 —— fork 给渲染器补的控制方法。 */
  interface CliRenderer {
    /** 强制下一帧全量重绘（会话恢复后重新断言终端物理状态）。 */
    requestFullRepaint(): void;
    resetMouseTracking(): void;
  }
}

/**
 * 让本文件引用的 fork 类型只作为类型来源存在，避免打包器把它当成一个空模块入口。
 * `MarkdownRenderable` / `ScrollBoxRenderable` 在个别接口的泛型默认值里被间接用到。
 */
export type ForkAugmentedRenderables = MarkdownRenderable | ScrollBoxRenderable;
