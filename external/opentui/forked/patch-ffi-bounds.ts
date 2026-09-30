// @ts-nocheck
/**
 * 运行时补齐 @opentui/core 的 FFI 数字参数边界。
 *
 * 背景（本仓库的 fork 分工）：
 *   `./core/` 是 OpenTUI `packages/core/src` 的源码镜像，只用于类型与阅读
 *   参照；运行期真正加载的是 `node_modules/@opentui/core` 的预编译产物
 *   （build 时原样拷进 runtime/）。因此凡是需要生效的行为修正，都必须像
 *   `patch-opentui-markdown.ts` 一样在运行期对成品包打猴子补丁。
 *
 * 修复的崩溃（~/.swarmflow/stderr.log 实录）：
 *   TypeError: Argument 3 must be a uint32
 *     at writeNumericArg (node:internal/ffi-shared-buffer:129:7)
 *     at FFIRenderLib.textBufferViewSetViewport (...)
 *     at TextBufferView.setViewport (...)
 *     at TextBufferRenderable.onResize (...)
 *     at TextRenderable.onLayoutResize / updateFromLayout (...)
 *     at BoxRenderable.updateLayout (...)
 *     code: 'ERR_INVALID_ARG_TYPE'
 *
 * Yoga 在首帧、容器尺寸为 0、或出现测量循环时会给出 NaN / 小数 / 负数的
 * computed layout。`Renderable.updateFromLayout` 里的 `Math.max(width, 1)`
 * 对 NaN 无效（Math.max(NaN, 1) === NaN），NaN 顺着 onResize 传进 FFI，
 * node:module 的严格校验直接抛异常。该异常发生在渲染主路径上，只能被
 * main.tsx 的 uncaughtException 兜住 —— 结果是整个 TUI 退出、终端被留在
 * 半损坏状态并持续吐乱码，用户只能关闭终端。
 *
 * 这里在 FFI 边界统一兜底：原本合法的值原样透传，非法的（NaN / Infinity /
 * 小数 / 负数 / 超范围）归一到合法值。与 `./core/text-buffer-view.ts` 的
 * 源码镜像修正保持一致（源码那份不改运行期产物，仅作镜像）。
 *
 * 注意调用时机：不要在模块顶层调用 installFfiBoundsPatch()。本文件 import 的
 * ./core/lib/diagnostic.js 会间接引用 @opentui/core，顶层执行时 TextBufferView
 * 可能还处于循环依赖的 TDZ 中（本仓库此前踩过 SpanRenderable extends
 * TextNodeRenderable 的同类坑），补丁会静默失效。由 main.tsx 在 import 全部
 * 落地之后、createCliRenderer 之前显式调用。
 */
import { TextBufferRenderable, TextBufferView } from "@opentui/core"
import { writeOpenTuiDiag } from "./core/lib/diagnostic.js"
import { clampInteger } from "../display/layout/metrics.js"

/**
 * 坐标 / 偏移 / 滚动量：允许 0，下限由 min 指定。
 * NaN / Infinity / 小数 / 负数 / 超范围一律归一到合法 uint32。
 */
function toU32(value: number, min: number): number {
  return clampInteger(value, min, 0xffffffff)
}

/** 宽 / 高：至少为 1（与上游 updateFromLayout 的 Math.max(x, 1) 意图一致）。 */
function toExtent(value: number): number {
  return toU32(value, 1)
}

let installed = false

export function installFfiBoundsPatch(): void {
  if (installed) return
  installed = true

  // ---- 1) FFI 边界：所有数字入参统一归一 ----
  // 注意：这些原型方法的签名里并没有 viewPtr —— 它是 this.viewPtr，由原方法
  // 自己传给 lib。所以下面的下标就是 JS 调用参数的下标。
  const proto = TextBufferView?.prototype as Record<string, any> | undefined
  if (proto) {
    const wrap = (name: string, transform: (args: unknown[]) => unknown[]) => {
      const original = proto[name]
      if (typeof original !== "function") return
      proto[name] = function patched(this: unknown, ...args: unknown[]) {
        return original.apply(this, transform(args))
      }
    }

    /** 前 count 个参数是坐标类（可为 0），其余原样透传。 */
    const leadingOffsets = (count: number) => (args: unknown[]) => {
      for (let i = 0; i < count; i += 1) args[i] = toU32(args[i] as number, 0)
      return args
    }

    // setViewport(x, y, width, height) —— 崩溃栈里的函数
    wrap("setViewport", (args) => [
      toU32(args[0] as number, 0),
      toU32(args[1] as number, 0),
      toExtent(args[2] as number),
      toExtent(args[3] as number),
    ])
    // setViewportSize(width, height)
    wrap("setViewportSize", (args) => [toExtent(args[0] as number), toExtent(args[1] as number)])
    // measureForDimensions(width, height)
    wrap("measureForDimensions", (args) => [
      toExtent(args[0] as number),
      toExtent(args[1] as number),
    ])
    wrap("setFirstLineOffset", leadingOffsets(1))
    wrap("setWrapWidth", leadingOffsets(1))
    wrap("setTabIndicator", leadingOffsets(1))
    // setSelection(start, end, bg?, fg?)
    wrap("setSelection", leadingOffsets(2))
    // updateSelection(end, bg?, fg?)
    wrap("updateSelection", leadingOffsets(1))
    // set/updateLocalSelection(anchorX, anchorY, focusX, focusY, bg?, fg?)
    wrap("setLocalSelection", leadingOffsets(4))
    wrap("updateLocalSelection", leadingOffsets(4))
  }

  // ---- 2) 兜底：渲染主路径不能再把整个 TUI 打死 ----
  const renderableProto = TextBufferRenderable?.prototype as Record<string, any> | undefined
  if (renderableProto && typeof renderableProto.onResize === "function") {
    const originalOnResize = renderableProto.onResize
    renderableProto.onResize = function patchedOnResize(width: number, height: number) {
      try {
        return originalOnResize.call(this, toExtent(width), toExtent(height))
      } catch (err) {
        // 只记录不抛出：一次坏尺寸不该终结整个会话。
        writeOpenTuiDiag("ffi-bounds.onResize_failed", {
          width,
          height,
          error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
        })
      }
    }
  }
}
