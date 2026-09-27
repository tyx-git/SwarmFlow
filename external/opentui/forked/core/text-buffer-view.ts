import { RGBA } from "./lib/RGBA.js"
import { resolveRenderLib, type LineInfo, type RenderLib, type TextBufferViewHandle } from "./zig.js"
import type { TextBuffer } from "./text-buffer.js"

/**
 * Node 26 的 FFI 绑定对 uint32 形参会做严格校验：非有限数（NaN/Infinity）、
 * 负数、小数或超出 0xFFFFFFFF 的值都会抛 `Argument N must be a uint32`
 * (ERR_INVALID_ARG_TYPE)。
 *
 * 这个异常发生在渲染主路径上（updateFromLayout -> onResize -> setViewport），
 * 只能被 main.tsx 的 uncaughtException 兜住 —— 结果是整个 TUI 直接退出、
 * 终端留在半损坏状态并持续吐乱码。Yoga 在首帧、容器尺寸为 0、或出现
 * 测量循环时确实会给出 NaN / 小数，所以这里必须在 FFI 边界统一兜底。
 *
 * 注意：返回值保持"原本合法就原样透传"，只修正非法值，避免改变既有行为。
 */
function toViewportArg(value: number, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return min
  const floored = Math.floor(value)
  if (floored < min) return min
  if (floored > 0xffffffff) return 0xffffffff
  return floored
}

/** 坐标 / 偏移 / 滚动量（允许 0）。 */
const u32 = (value: number): number => toViewportArg(value, 0)

/** 尺寸（宽/高至少为 1，与 Renderable.updateFromLayout 的 Math.max(x,1) 一致）。 */
const u32Extent = (value: number): number => toViewportArg(value, 1)

export class TextBufferView {
  private lib: RenderLib
  private viewPtr: TextBufferViewHandle
  private textBuffer: TextBuffer
  private _destroyed: boolean = false

  constructor(lib: RenderLib, ptr: TextBufferViewHandle, textBuffer: TextBuffer) {
    this.lib = lib
    this.viewPtr = ptr
    this.textBuffer = textBuffer
  }

  static create(textBuffer: TextBuffer): TextBufferView {
    const lib = resolveRenderLib()
    const viewPtr = lib.createTextBufferView(textBuffer.ptr)
    return new TextBufferView(lib, viewPtr, textBuffer)
  }

  // Fail loud and clear
  private guard(): void {
    if (this._destroyed) throw new Error("TextBufferView is destroyed")
  }

  public get ptr(): TextBufferViewHandle {
    this.guard()
    return this.viewPtr
  }

  public setSelection(start: number, end: number, bgColor?: RGBA, fgColor?: RGBA): void {
    this.guard()
    this.lib.textBufferViewSetSelection(this.viewPtr, u32(start), u32(end), bgColor || null, fgColor || null)
  }

  public updateSelection(end: number, bgColor?: RGBA, fgColor?: RGBA): void {
    this.guard()
    this.lib.textBufferViewUpdateSelection(this.viewPtr, u32(end), bgColor || null, fgColor || null)
  }

  public resetSelection(): void {
    this.guard()
    this.lib.textBufferViewResetSelection(this.viewPtr)
  }

  public getSelection(): { start: number; end: number } | null {
    this.guard()
    return this.lib.textBufferViewGetSelection(this.viewPtr)
  }

  public hasSelection(): boolean {
    this.guard()
    return this.getSelection() !== null
  }

  public setLocalSelection(
    anchorX: number,
    anchorY: number,
    focusX: number,
    focusY: number,
    bgColor?: RGBA,
    fgColor?: RGBA,
  ): boolean {
    this.guard()
    return this.lib.textBufferViewSetLocalSelection(
      this.viewPtr,
      u32(anchorX),
      u32(anchorY),
      u32(focusX),
      u32(focusY),
      bgColor || null,
      fgColor || null,
    )
  }

  public updateLocalSelection(
    anchorX: number,
    anchorY: number,
    focusX: number,
    focusY: number,
    bgColor?: RGBA,
    fgColor?: RGBA,
  ): boolean {
    this.guard()
    return this.lib.textBufferViewUpdateLocalSelection(
      this.viewPtr,
      u32(anchorX),
      u32(anchorY),
      u32(focusX),
      u32(focusY),
      bgColor || null,
      fgColor || null,
    )
  }

  public resetLocalSelection(): void {
    this.guard()
    this.lib.textBufferViewResetLocalSelection(this.viewPtr)
  }

  public setWrapWidth(width: number | null): void {
    this.guard()
    this.lib.textBufferViewSetWrapWidth(this.viewPtr, u32(width ?? 0))
  }

  public setWrapMode(mode: "none" | "char" | "word"): void {
    this.guard()
    this.lib.textBufferViewSetWrapMode(this.viewPtr, mode)
  }

  public setFirstLineOffset(offset: number): void {
    this.guard()
    this.lib.textBufferViewSetFirstLineOffset(this.viewPtr, u32(offset))
  }

  public setViewportSize(width: number, height: number): void {
    this.guard()
    this.lib.textBufferViewSetViewportSize(this.viewPtr, u32Extent(width), u32Extent(height))
  }

  public setViewport(x: number, y: number, width: number, height: number): void {
    this.guard()
    this.lib.textBufferViewSetViewport(this.viewPtr, u32(x), u32(y), u32Extent(width), u32Extent(height))
  }

  public get lineInfo(): LineInfo {
    this.guard()
    return this.lib.textBufferViewGetLineInfo(this.viewPtr)
  }

  public get logicalLineInfo(): LineInfo {
    this.guard()
    return this.lib.textBufferViewGetLogicalLineInfo(this.viewPtr)
  }

  public getSelectedText(): string {
    this.guard()
    const byteSize = this.textBuffer.byteSize
    if (byteSize === 0) return ""

    const selectedBytes = this.lib.textBufferViewGetSelectedTextBytes(this.viewPtr, byteSize)

    if (!selectedBytes) return ""

    return this.lib.decoder.decode(selectedBytes)
  }

  public getPlainText(): string {
    this.guard()
    const byteSize = this.textBuffer.byteSize
    if (byteSize === 0) return ""

    const plainBytes = this.lib.textBufferViewGetPlainTextBytes(this.viewPtr, byteSize)

    if (!plainBytes) return ""

    return this.lib.decoder.decode(plainBytes)
  }

  public setTabIndicator(indicator: string | number): void {
    this.guard()
    const codePoint = typeof indicator === "string" ? (indicator.codePointAt(0) ?? 0) : indicator
    this.lib.textBufferViewSetTabIndicator(this.viewPtr, u32(codePoint))
  }

  public setTabIndicatorColor(color: RGBA): void {
    this.guard()
    this.lib.textBufferViewSetTabIndicatorColor(this.viewPtr, color)
  }

  public setTruncate(truncate: boolean): void {
    this.guard()
    this.lib.textBufferViewSetTruncate(this.viewPtr, truncate)
  }

  public measureForDimensions(width: number, height: number): { lineCount: number; widthColsMax: number } | null {
    this.guard()
    return this.lib.textBufferViewMeasureForDimensions(this.viewPtr, u32Extent(width), u32Extent(height))
  }

  public getVirtualLineCount(): number {
    this.guard()
    return this.lib.textBufferViewGetVirtualLineCount(this.viewPtr)
  }

  public destroy(): void {
    if (this._destroyed) return
    this._destroyed = true
    this.lib.destroyTextBufferView(this.viewPtr)
  }
}
