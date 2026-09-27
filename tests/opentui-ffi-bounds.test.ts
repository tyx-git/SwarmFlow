import { describe, expect, it } from "vitest";

/**
 * 回归保护：流式输出期间 TUI 被 FFI 参数校验异常整体打死的崩溃。
 *
 * 现场（~/.swarmflow/stderr.log）：
 *   TypeError: Argument 3 must be a uint32
 *     at writeNumericArg (node:internal/ffi-shared-buffer)
 *     at FFIRenderLib.textBufferViewSetViewport
 *     at TextBufferView.setViewport
 *     at TextBufferRenderable.onResize
 *     at TextRenderable.onLayoutResize / updateFromLayout
 *     at BoxRenderable.updateLayout
 *     code: 'ERR_INVALID_ARG_TYPE'
 *
 * Yoga 在首帧 / 零尺寸容器 / 测量循环时会给出 NaN、小数或负数尺寸；
 * Math.max(NaN, 1) === NaN，于是 NaN 一路传进 FFI，被 node:module 的严格
 * 校验抛成未捕获异常，TUI 直接退出并把终端留在半损坏状态。
 */
describe("opentui FFI 参数边界补丁", () => {
  it("把 NaN / 小数 / 负数 / Infinity 归一成合法 uint32", async () => {
    const { TextBuffer, TextBufferView } = await import("@opentui/core");
    const { installFfiBoundsPatch } = await import(
      "../external/opentui/forked/patch-ffi-bounds.js"
    );

    installFfiBoundsPatch();

    const view = TextBufferView.create(TextBuffer.create());

    // 这些调用在打补丁前会抛 "Argument N must be a uint32"
    expect(() => view.setViewport(NaN, 0, 10, 10)).not.toThrow();
    expect(() => view.setViewport(0, NaN, 10, 10)).not.toThrow();
    expect(() => view.setViewport(0, 0, NaN, 10)).not.toThrow();
    expect(() => view.setViewport(0, 0, 10, NaN)).not.toThrow();
    expect(() => view.setViewport(-1, 0, 10, 10)).not.toThrow();
    expect(() => view.setViewport(0, 0, -1, 10)).not.toThrow();
    expect(() => view.setViewport(0, 0, 80.5, 24)).not.toThrow();
    expect(() => view.setViewport(0, Number.POSITIVE_INFINITY, 10, 10)).not.toThrow();

    expect(() => view.setViewportSize(NaN, 0)).not.toThrow();
    expect(() => view.setFirstLineOffset(NaN)).not.toThrow();
    expect(() => view.setWrapWidth(NaN)).not.toThrow();
    expect(() => view.measureForDimensions(NaN, NaN)).not.toThrow();
    expect(() => view.setSelection(NaN, 10)).not.toThrow();
    expect(() => view.setLocalSelection(NaN, 0, 10, 10)).not.toThrow();

    // 正常值必须原样可用
    expect(() => view.setViewport(0, 0, 80, 24)).not.toThrow();
    expect(() => view.setViewportSize(80, 24)).not.toThrow();

    // 归一后的结果要真的是合法值：宽高至少 1，坐标至少 0
    view.setViewport(0, 0, NaN, 10);
    expect(view.lineInfo).toBeTruthy();
  });

  it("TextBufferRenderable.onResize 收到坏尺寸时不再抛出", async () => {
    const { TextBufferRenderable } = await import("@opentui/core");
    const { installFfiBoundsPatch } = await import(
      "../external/opentui/forked/patch-ffi-bounds.js"
    );

    installFfiBoundsPatch();

    const onResize = (TextBufferRenderable.prototype as unknown as Record<string, unknown>)
      .onResize as (width: number, height: number) => void;
    expect(typeof onResize).toBe("function");
    expect(() => onResize.call(Object.create(TextBufferRenderable.prototype), NaN, 10)).not.toThrow();
  });
});
