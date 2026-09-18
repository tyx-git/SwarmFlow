import { type RenderableOptions, Renderable } from "../Renderable.js"
import { type RenderContext } from "../types.js"
import { type ColorInput, RGBA, parseColor } from "../lib/RGBA.js"
import { OptimizedBuffer } from "../buffer.js"

const defaultThumbBackgroundColor = RGBA.fromHex("#9a9ea3")
const defaultTrackBackgroundColor = RGBA.fromHex("#252527")
const verticalUnitsPerCell = 8
const verticalEighthBlocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const

export interface SliderOptions extends RenderableOptions<SliderRenderable> {
  orientation: "vertical" | "horizontal"
  value?: number
  min?: number
  max?: number
  viewPortSize?: number
  minThumbSize?: number
  backgroundColor?: ColorInput
  foregroundColor?: ColorInput
  onChange?: (value: number) => void
}

export class SliderRenderable extends Renderable {
  public readonly orientation: "vertical" | "horizontal"
  private _value: number
  private _min: number
  private _max: number
  private _viewPortSize: number
  private _minThumbSize: number
  private _backgroundColor: RGBA
  private _foregroundColor: RGBA
  private _onChange?: (value: number) => void

  constructor(ctx: RenderContext, options: SliderOptions) {
    super(ctx, { flexShrink: 0, ...options })
    this.orientation = options.orientation
    this._min = options.min ?? 0
    this._max = options.max ?? 100
    this._value = options.value ?? this._min
    this._viewPortSize = options.viewPortSize ?? Math.max(1, (this._max - this._min) * 0.1)
    this._minThumbSize = Math.max(0, options.minThumbSize ?? 0)
    this._onChange = options.onChange
    this._backgroundColor = options.backgroundColor ? parseColor(options.backgroundColor) : defaultTrackBackgroundColor
    this._foregroundColor = options.foregroundColor ? parseColor(options.foregroundColor) : defaultThumbBackgroundColor

    this.setupMouseHandling()
  }

  get value(): number {
    return this._value
  }

  set value(newValue: number) {
    const clamped = Math.max(this._min, Math.min(this._max, newValue))
    if (clamped !== this._value) {
      this._value = clamped
      this._onChange?.(clamped)
      this.emit("change", { value: clamped })
      this.requestRender()
    }
  }

  get min(): number {
    return this._min
  }

  set min(newMin: number) {
    if (newMin !== this._min) {
      this._min = newMin
      if (this._value < newMin) {
        this.value = newMin
      }
      this.requestRender()
    }
  }

  get max(): number {
    return this._max
  }

  set max(newMax: number) {
    if (newMax !== this._max) {
      this._max = newMax
      if (this._value > newMax) {
        this.value = newMax
      }
      this.requestRender()
    }
  }

  set viewPortSize(size: number) {
    const clampedSize = Math.max(0.01, Math.min(size, this._max - this._min))
    if (clampedSize !== this._viewPortSize) {
      this._viewPortSize = clampedSize
      this.requestRender()
    }
  }

  get viewPortSize(): number {
    return this._viewPortSize
  }

  set minThumbSize(size: number) {
    const clampedSize = Math.max(0, size)
    if (clampedSize !== this._minThumbSize) {
      this._minThumbSize = clampedSize
      this.requestRender()
    }
  }

  get minThumbSize(): number {
    return this._minThumbSize
  }

  get backgroundColor(): RGBA {
    return this._backgroundColor
  }

  set backgroundColor(value: ColorInput) {
    this._backgroundColor = parseColor(value)
    this.requestRender()
  }

  get foregroundColor(): RGBA {
    return this._foregroundColor
  }

  set foregroundColor(value: ColorInput) {
    this._foregroundColor = parseColor(value)
    this.requestRender()
  }

  private calculateDragOffsetVirtual(event: any): number {
    if (this.orientation === "vertical") {
      const trackUnits = this.height * verticalUnitsPerCell
      const mouseUnits = Math.max(0, Math.min(trackUnits, (event.y - this.y) * verticalUnitsPerCell))
      const { startUnits, sizeUnits } = this.getVerticalThumbUnits()

      return Math.max(0, Math.min(sizeUnits, mouseUnits - startUnits))
    }

    const mousePos = event.x - this.x
    const virtualMousePos = Math.max(0, Math.min(this.width * 2, mousePos * 2))
    const virtualThumbStart = this.getVirtualThumbStart()
    const virtualThumbSize = this.getVirtualThumbSize()

    return Math.max(0, Math.min(virtualThumbSize, virtualMousePos - virtualThumbStart))
  }

  private setupMouseHandling(): void {
    let isDragging = false
    let dragOffsetVirtual = 0

    this.onMouseDown = (event) => {
      event.stopPropagation()
      event.preventDefault()

      const thumb = this.getThumbRect()
      const inThumb =
        event.x >= thumb.x && event.x < thumb.x + thumb.width && event.y >= thumb.y && event.y < thumb.y + thumb.height

      if (inThumb) {
        isDragging = true

        dragOffsetVirtual = this.calculateDragOffsetVirtual(event)
      } else {
        this.updateValueFromMouseDirect(event)
        isDragging = true

        dragOffsetVirtual = this.calculateDragOffsetVirtual(event)
      }
    }

    this.onMouseDrag = (event) => {
      if (!isDragging) return
      event.stopPropagation()
      this.updateValueFromMouseWithOffset(event, dragOffsetVirtual)
    }

    this.onMouseUp = (event) => {
      if (isDragging) {
        this.updateValueFromMouseWithOffset(event, dragOffsetVirtual)
      }
      isDragging = false
    }
  }

  private updateValueFromMouseDirect(event: any): void {
    const trackStart = this.orientation === "vertical" ? this.y : this.x
    const trackSize = this.orientation === "vertical" ? this.height : this.width
    const mousePos = this.orientation === "vertical" ? event.y : event.x

    const relativeMousePos = mousePos - trackStart
    const clampedMousePos = Math.max(0, Math.min(trackSize, relativeMousePos))
    const ratio = trackSize === 0 ? 0 : clampedMousePos / trackSize
    const range = this._max - this._min
    const newValue = this._min + ratio * range

    this.value = newValue
  }

  private updateValueFromMouseWithOffset(event: any, offsetVirtual: number): void {
    if (this.orientation === "vertical") {
      const trackUnits = this.height * verticalUnitsPerCell
      const mouseUnits = Math.max(0, Math.min(trackUnits, (event.y - this.y) * verticalUnitsPerCell))
      const { sizeUnits } = this.getVerticalThumbUnits()
      const maxThumbStartUnits = Math.max(0, trackUnits - sizeUnits)

      let desiredThumbStartUnits = mouseUnits - offsetVirtual
      desiredThumbStartUnits = Math.max(0, Math.min(maxThumbStartUnits, desiredThumbStartUnits))

      const ratio = maxThumbStartUnits === 0 ? 0 : desiredThumbStartUnits / maxThumbStartUnits
      const range = this._max - this._min
      const newValue = this._min + ratio * range

      this.value = newValue
      return
    }

    const trackStart = this.x
    const trackSize = this.width
    const mousePos = event.x

    const virtualTrackSize = trackSize * 2
    const relativeMousePos = mousePos - trackStart
    const clampedMousePos = Math.max(0, Math.min(trackSize, relativeMousePos))
    const virtualMousePos = clampedMousePos * 2

    const virtualThumbSize = this.getVirtualThumbSize()
    const maxThumbStart = Math.max(0, virtualTrackSize - virtualThumbSize)

    let desiredThumbStart = virtualMousePos - offsetVirtual
    desiredThumbStart = Math.max(0, Math.min(maxThumbStart, desiredThumbStart))

    const ratio = maxThumbStart === 0 ? 0 : desiredThumbStart / maxThumbStart
    const range = this._max - this._min
    const newValue = this._min + ratio * range

    this.value = newValue
  }

  private getThumbRect(): { x: number; y: number; width: number; height: number } {
    if (this.orientation === "vertical") {
      const { startUnits, sizeUnits } = this.getVerticalThumbUnits()
      const realThumbStart = Math.floor(startUnits / verticalUnitsPerCell)
      const realThumbEnd = Math.ceil((startUnits + sizeUnits) / verticalUnitsPerCell)

      return {
        x: this.x,
        y: this.y + realThumbStart,
        width: this.width,
        height: Math.max(1, realThumbEnd - realThumbStart),
      }
    }

    const virtualThumbSize = this.getVirtualThumbSize()
    const virtualThumbStart = this.getVirtualThumbStart()

    const realThumbStart = Math.floor(virtualThumbStart / 2)
    const realThumbSize = Math.ceil((virtualThumbStart + virtualThumbSize) / 2) - realThumbStart

    return {
      x: this.x + realThumbStart,
      y: this.y,
      width: Math.max(1, realThumbSize),
      height: this.height,
    }
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    if (this.orientation === "horizontal") {
      this.renderHorizontal(buffer)
    } else {
      this.renderVertical(buffer)
    }
  }

  private renderHorizontal(buffer: OptimizedBuffer): void {
    const virtualThumbSize = this.getVirtualThumbSize()
    const virtualThumbStart = this.getVirtualThumbStart()
    const virtualThumbEnd = virtualThumbStart + virtualThumbSize

    buffer.fillRect(this.x, this.y, this.width, this.height, this._backgroundColor)

    const realStartCell = Math.floor(virtualThumbStart / 2)
    const realEndCell = Math.ceil(virtualThumbEnd / 2) - 1
    const startX = Math.max(0, realStartCell)
    const endX = Math.min(this.width - 1, realEndCell)

    for (let realX = startX; realX <= endX; realX++) {
      const virtualCellStart = realX * 2
      const virtualCellEnd = virtualCellStart + 2

      const thumbStartInCell = Math.max(virtualThumbStart, virtualCellStart)
      const thumbEndInCell = Math.min(virtualThumbEnd, virtualCellEnd)
      const coverage = thumbEndInCell - thumbStartInCell

      let char = " "

      if (coverage >= 2) {
        char = "█"
      } else {
        const isLeftHalf = thumbStartInCell === virtualCellStart
        if (isLeftHalf) {
          char = "▌"
        } else {
          char = "▐"
        }
      }

      for (let y = 0; y < this.height; y++) {
        buffer.setCellWithAlphaBlending(this.x + realX, this.y + y, char, this._foregroundColor, this._backgroundColor)
      }
    }
  }

  private renderVertical(buffer: OptimizedBuffer): void {
    const { startUnits, sizeUnits } = this.getVerticalThumbUnits()
    const endUnits = startUnits + sizeUnits

    buffer.fillRect(this.x, this.y, this.width, this.height, this._backgroundColor)

    const startY = Math.max(0, Math.floor(startUnits / verticalUnitsPerCell))
    const endY = Math.min(this.height - 1, Math.ceil(endUnits / verticalUnitsPerCell) - 1)

    for (let realY = startY; realY <= endY; realY++) {
      const cellStartUnits = realY * verticalUnitsPerCell
      const cellEndUnits = cellStartUnits + verticalUnitsPerCell
      const thumbStartInCell = Math.max(startUnits, cellStartUnits)
      const thumbEndInCell = Math.min(endUnits, cellEndUnits)
      const coverageUnits = thumbEndInCell - thumbStartInCell

      if (coverageUnits <= 0) continue

      const { char, foregroundColor, backgroundColor } = this.getVerticalThumbCell(
        coverageUnits,
        thumbStartInCell > cellStartUnits,
        thumbEndInCell < cellEndUnits,
      )

      for (let x = 0; x < this.width; x++) {
        buffer.setCellWithAlphaBlending(this.x + x, this.y + realY, char, foregroundColor, backgroundColor)
      }
    }
  }

  private getVerticalThumbCell(
    coverageUnits: number,
    startsInsideCell: boolean,
    endsInsideCell: boolean,
  ): { char: string; foregroundColor: RGBA; backgroundColor: RGBA } {
    if (coverageUnits >= verticalUnitsPerCell || (!startsInsideCell && !endsInsideCell)) {
      return {
        char: "█",
        foregroundColor: this._foregroundColor,
        backgroundColor: this._backgroundColor,
      }
    }

    const thumbEighths = Math.max(1, Math.min(7, coverageUnits))

    if (startsInsideCell) {
      return {
        char: verticalEighthBlocks[thumbEighths - 1] ?? "█",
        foregroundColor: this._foregroundColor,
        backgroundColor: this._backgroundColor,
      }
    }

    const trackEighths = 8 - thumbEighths
    return {
      char: verticalEighthBlocks[trackEighths - 1] ?? "█",
      foregroundColor: this._backgroundColor,
      backgroundColor: this._foregroundColor,
    }
  }

  private getVerticalThumbUnits(): { startUnits: number; sizeUnits: number } {
    const trackUnits = this.height * verticalUnitsPerCell
    const range = this._max - this._min

    if (trackUnits <= 0) return { startUnits: 0, sizeUnits: 0 }
    if (range === 0) return { startUnits: 0, sizeUnits: trackUnits }

    const viewportSize = Math.max(1, this._viewPortSize)
    const contentSize = range + viewportSize

    if (contentSize <= viewportSize) return { startUnits: 0, sizeUnits: trackUnits }

    const thumbRatio = viewportSize / contentSize
    const calculatedUnits = Math.round(trackUnits * thumbRatio)
    // Floor at 2 units (one virtual half-cell, since getVirtualThumbSize divides by 4)
    // to mirror the horizontal path's half-cell minimum — not a full cell. Otherwise a
    // tiny vertical thumb is forced to a whole cell, breaking sub-cell symmetry with
    // horizontal and contradicting the sub-cell rendering this slider already supports.
    const minimumUnits = Math.max(2, Math.round(this._minThumbSize * verticalUnitsPerCell))
    const sizeUnits = Math.min(Math.max(calculatedUnits, minimumUnits), trackUnits)
    const maxStartUnits = Math.max(0, trackUnits - sizeUnits)
    const valueRatio = (this._value - this._min) / range
    const startUnits = Math.max(0, Math.min(maxStartUnits, Math.round(maxStartUnits * valueRatio)))

    return { startUnits, sizeUnits }
  }

  private getThumbMetrics(): { start: number; size: number } {
    if (this.orientation === "vertical") {
      const { startUnits, sizeUnits } = this.getVerticalThumbUnits()
      return {
        start: startUnits / verticalUnitsPerCell,
        size: sizeUnits / verticalUnitsPerCell,
      }
    }

    const trackSize = this.width
    const range = this._max - this._min

    if (trackSize <= 0) return { start: 0, size: 0 }
    if (range === 0) return { start: 0, size: trackSize }

    const viewportSize = Math.max(1, this._viewPortSize)
    const contentSize = range + viewportSize

    if (contentSize <= viewportSize) return { start: 0, size: trackSize }

    const thumbRatio = viewportSize / contentSize
    const calculatedSize = trackSize * thumbRatio
    const minimumSize = Math.max(1, this._minThumbSize)
    const size = Math.min(Math.max(calculatedSize, minimumSize), trackSize)
    const valueRatio = (this._value - this._min) / range
    const start = Math.max(0, (trackSize - size) * valueRatio)

    return { start, size }
  }

  private getVirtualThumbSize(): number {
    if (this.orientation === "vertical") {
      const { sizeUnits } = this.getVerticalThumbUnits()
      return Math.max(1, Math.min(Math.round(sizeUnits / 4), this.height * 2))
    }

    const virtualTrackSize = this.width * 2
    const range = this._max - this._min

    if (range === 0) return virtualTrackSize

    const viewportSize = Math.max(1, this._viewPortSize)
    const contentSize = range + viewportSize

    if (contentSize <= viewportSize) return virtualTrackSize

    const thumbRatio = viewportSize / contentSize
    const calculatedSize = Math.floor(virtualTrackSize * thumbRatio)
    const minimumSize = Math.max(1, Math.floor(this._minThumbSize * 2))

    return Math.min(Math.max(calculatedSize, minimumSize), virtualTrackSize)
  }

  private getVirtualThumbStart(): number {
    if (this.orientation === "vertical") {
      const { startUnits } = this.getVerticalThumbUnits()
      return Math.max(0, Math.min(Math.round(startUnits / 4), this.height * 2))
    }

    const virtualTrackSize = this.width * 2
    const range = this._max - this._min

    if (range === 0) return 0

    const valueRatio = (this._value - this._min) / range
    const virtualThumbSize = this.getVirtualThumbSize()

    return Math.round(valueRatio * (virtualTrackSize - virtualThumbSize))
  }
}
