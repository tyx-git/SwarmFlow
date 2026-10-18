import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

declare const pointerBrand: unique symbol

// This module owns OpenTUI's native FFI surface. Portable code imports this
// file instead of requiring node:ffi directly, so pointer and type-name
// differences are normalized once at the backend boundary.

// External FFI producers may expose their own branded pointer types. Public APIs
// that consume foreign pointers should accept the raw pointer shape and normalize
// it before crossing OpenTUI's native boundary.
export type PointerInput = number | bigint

// node:ffi 的指针是 bigint，但调用方（Yoga/zig 绑定、测试夹具）也会传 number，
// 因此这里保留两种形状，只在后端内部收窄。
export type Pointer = PointerInput & { readonly [pointerBrand]: "Pointer" }

type PointerSource = ArrayBufferLike | ArrayBufferView

// 类型名沿用上游 OpenTUI 的 FFI 名称；到 node:ffi 的映射在库装载时统一做一次，
// 不包装每一次原生调用。
export const FFIType = {
  char: "char",
  int8_t: "int8_t",
  i8: "i8",
  uint8_t: "uint8_t",
  u8: "u8",
  int16_t: "int16_t",
  i16: "i16",
  uint16_t: "uint16_t",
  u16: "u16",
  int32_t: "int32_t",
  i32: "i32",
  int: "int",
  uint32_t: "uint32_t",
  u32: "u32",
  int64_t: "int64_t",
  i64: "i64",
  uint64_t: "uint64_t",
  u64: "u64",
  double: "double",
  f64: "f64",
  float: "float",
  f32: "f32",
  bool: "bool",
  ptr: "ptr",
  pointer: "pointer",
  void: "void",
  cstring: "cstring",
  function: "function",
  usize: "usize",
  callback: "callback",
  napi_env: "napi_env",
  napi_value: "napi_value",
  buffer: "buffer",
} as const

export type FFIType = (typeof FFIType)[keyof typeof FFIType]
// 上游调用点沿用 FFITypeOrString 这个名字；Node 后端只接受这一种形状，保留别名。
export type FFITypeOrString = FFIType

// A function definition describes one native symbol. `ptr` overrides the symbol
// address and follows the same pointer safety rules as normal pointer values.
export interface FFIFunction {
  readonly args?: readonly FFITypeOrString[]
  readonly returns?: FFITypeOrString
  readonly ptr?: Pointer
  readonly threadsafe?: boolean
}

// A callback instance owns a native trampoline. `close()` invalidates `ptr`;
// callers must not pass that pointer to native code after close.
export interface FFICallbackInstance {
  readonly ptr: Pointer | null
  readonly threadsafe: boolean
  close(): void
}

// A loaded library owns callbacks created through `createCallback()`.
//
// Typical use:
// const callback = library.createCallback(handler, { args: ["ptr"], returns: "void" })
// library.symbols.setLogCallback(callback.ptr)
//
// `close()` first closes the native library, then closes any callbacks that
// remain open.
export interface Library<Fns extends Record<string, FFIFunction>> {
  symbols: { [K in keyof Fns]: (...args: any[]) => any }
  createCallback(callback: (...args: any[]) => any, definition: FFIFunction): FFICallbackInstance
  close(): void
}

// A backend normalizes runtime differences once. Do not wrap hot symbol calls
// here unless a backend must adapt them.
interface FfiBackend {
  dlopen<Fns extends Record<string, FFIFunction>>(path: string | URL, symbols: Fns): Library<Fns>
  ptr(value: PointerSource): Pointer
  suffix: string
  toArrayBuffer(pointer: Pointer, offset: number | undefined, length: number): ArrayBuffer
}

interface NodeFFIFunction {
  readonly arguments: readonly string[]
  readonly return: string
}

interface NodeDynamicLibrary {
  close(): void
  registerCallback(signature: NodeFFIFunction, callback: (...args: any[]) => any): bigint
  unregisterCallback(pointer: bigint): void
}

interface NodeFfiLibrary {
  readonly lib: NodeDynamicLibrary
  readonly functions: Record<string, (...args: any[]) => any>
}

interface NodeFfiBackend {
  dlopen(path: string | null, symbols: Record<string, NodeFFIFunction>): NodeFfiLibrary
  getRawPointer(source: ArrayBuffer): bigint
  suffix: string
  toArrayBuffer(pointer: bigint, length: number, copy?: boolean): ArrayBuffer
}

export const FFI_UNAVAILABLE = "OpenTUI native FFI is not available for this runtime yet"
export const LIBRARY_CLOSED = "Cannot create FFI callback after library.close() has been called"
export const NODE_CALLBACK_THREADSAFE =
  "Node FFI callbacks are same-thread only and do not support threadsafe callbacks"
export const NODE_NAPI_UNSUPPORTED = "Node FFI backend does not support N-API FFI types"
export const NODE_POINTER_OVERRIDE = "Node FFI backend does not support FFIFunction.ptr overrides"
export const NODE_POINTER_ARGUMENT = "Node FFI pointer arguments must be a Pointer, ArrayBuffer, or ArrayBufferView"
export const NODE_PTR_VALUE =
  "node:ffi ptr() only supports ArrayBuffer and ArrayBufferView values backed by ArrayBuffer"
export const NODE_STRING_RETURN = "Node FFI backend does not normalize string return values (yet)"
export const NODE_USIZE_UNSUPPORTED = "Node FFI backend does not support usize yet"
export const POINTER_NEGATIVE = "Pointer must be non-negative"
export const POINTER_OFFSET_NEGATIVE = "Pointer offset must be non-negative"
export const POINTER_OFFSET_UNSAFE = "Pointer offset must be a safe integer"
export const POINTER_UNSAFE = "Pointer exceeds safe integer range"

function unavailable(cause?: unknown): never {
  throw new Error(FFI_UNAVAILABLE, { cause })
}

// node:ffi 拿不到时（低版本 Node，或未开 --experimental-ffi）用占位后端兜住模块加载，
// 真正的失败推迟到第一次触碰原生边界时抛出。
function createUnsupportedBackend(cause?: unknown): FfiBackend {
  return {
    dlopen() {
      return unavailable(cause)
    },
    ptr() {
      return unavailable(cause)
    },
    suffix: "",
    toArrayBuffer() {
      return unavailable(cause)
    },
  }
}

const requireModule = createRequire(import.meta.url)
const backend = loadBackend()

function loadBackend(): FfiBackend {
  try {
    const nodeFfi = requireModule("node:ffi") as NodeFfiBackend & { default?: NodeFfiBackend }
    return createNodeBackend(nodeFfi.default ?? nodeFfi)
  } catch (error) {
    return createUnsupportedBackend(error)
  }
}

// 把外部指针值归一化成 node:ffi 需要的 bigint，再传给原生代码。
export function toPointer(value: PointerInput): Pointer {
  if (typeof value === "number") {
    return toSafeBigIntPointer(value) as Pointer
  }

  return value as Pointer
}

export function ffiBool(value: boolean): 0 | 1 {
  return value ? 1 : 0
}

function toSafeBigIntPointer(pointer: number): bigint {
  if (pointer < 0) {
    throw new Error(POINTER_NEGATIVE)
  }

  if (!Number.isSafeInteger(pointer)) {
    throw new Error(POINTER_UNSAFE)
  }

  return BigInt(pointer)
}

// Wrap a backend callback so the loaded library can close it later. The wrapper
// keeps `ptr` live until close, then clears it so callers cannot reuse a stale
// trampoline pointer.
function createManagedCallback(raw: FFICallbackInstance, callbacks: Set<FFICallbackInstance>): FFICallbackInstance {
  let ptr = raw.ptr
  let closed = false

  const instance: FFICallbackInstance = {
    get ptr() {
      return ptr
    },
    get threadsafe() {
      return raw.threadsafe
    },
    close() {
      if (closed) {
        return
      }

      closed = true
      callbacks.delete(instance)
      try {
        raw.close()
      } finally {
        // Clear the pointer even if the backend close throws. The trampoline is
        // no longer safe to use.
        ptr = null
      }
    },
  }

  callbacks.add(instance)

  return instance
}

// Create a Node backend from node:ffi.
export function createNodeBackend(nodeFfi: NodeFfiBackend): FfiBackend {
  return {
    dlopen(path, symbols) {
      const { lib, functions } = nodeFfi.dlopen(toNodeLibraryPath(path), normalizeNodeDefinitions(symbols))
      const callbacks = new Set<FFICallbackInstance>()
      let closed = false
      let libraryClosed = false

      return {
        symbols: wrapNodeSymbols(functions, symbols, nodeFfi),
        createCallback(callback, definition) {
          if (closed) {
            throw new Error(LIBRARY_CLOSED)
          }

          if (definition.threadsafe) {
            throw new Error(NODE_CALLBACK_THREADSAFE)
          }

          const callbackPointer = lib.registerCallback(normalizeNodeDefinition(definition), callback)
          const raw: FFICallbackInstance = {
            ptr: callbackPointer as Pointer,
            threadsafe: false,
            close() {
              if (!libraryClosed) {
                lib.unregisterCallback(callbackPointer)
              }
            },
          }

          return createManagedCallback(raw, callbacks)
        },
        close() {
          if (closed) {
            return
          }

          closed = true

          try {
            libraryClosed = true
            lib.close()
          } finally {
            for (const callback of [...callbacks]) {
              callback.close()
            }
          }
        },
      }
    },
    ptr(value) {
      return toNodeSourcePointer(nodeFfi, value) as Pointer
    },
    suffix: nodeFfi.suffix,
    toArrayBuffer(pointer, offset, length) {
      return nodeFfi.toArrayBuffer(toBigIntPointer(pointer) + toNodePointerOffset(offset), length, false)
    },
  }
}

function toNodeLibraryPath(path: string | URL | null): string | null {
  return path instanceof URL ? fileURLToPath(path) : path
}

function normalizeNodeDefinitions<Fns extends Record<string, FFIFunction>>(
  definitions: Fns,
): Record<string, NodeFFIFunction> {
  return Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => [name, normalizeNodeDefinition(definition)]),
  )
}

function wrapNodeSymbols<Fns extends Record<string, FFIFunction>>(
  functions: Record<string, (...args: any[]) => any>,
  definitions: Fns,
  nodeFfi: NodeFfiBackend,
): { [K in keyof Fns]: (...args: any[]) => any } {
  return Object.fromEntries(
    Object.entries(functions).map(([name, fn]) => [name, wrapNodeSymbol(fn, definitions[name], nodeFfi)]),
  ) as { [K in keyof Fns]: (...args: any[]) => any }
}

function wrapNodeSymbol(
  fn: (...args: any[]) => any,
  definition: FFIFunction,
  nodeFfi: NodeFfiBackend,
): (...args: any[]) => any {
  const pointerArgIndexes = (definition.args ?? []).flatMap((type, index) =>
    isNodePointerArgumentType(type) ? [index] : [],
  )

  if (pointerArgIndexes.length === 0) {
    return fn
  }

  return (...args: any[]) => {
    const normalizedArgs = args.slice()

    for (const index of pointerArgIndexes) {
      normalizedArgs[index] = toNodePointerArgument(nodeFfi, normalizedArgs[index])
    }

    return fn(...normalizedArgs)
  }
}

function isNodePointerArgumentType(type: FFITypeOrString): boolean {
  return type === FFIType.ptr || type === FFIType.pointer || type === FFIType.function || type === FFIType.callback
}

function toNodePointerArgument(nodeFfi: NodeFfiBackend, value: unknown): bigint {
  if (value == null) {
    return 0n
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return toBigIntPointer(value as Pointer)
  }

  if (ArrayBuffer.isView(value)) {
    if (value.byteLength === 0) {
      return 0n
    }

    return toNodeSourcePointer(nodeFfi, value)
  }

  if (value instanceof ArrayBuffer) {
    if (value.byteLength === 0) {
      return 0n
    }

    return toNodeSourcePointer(nodeFfi, value)
  }

  throw new TypeError(NODE_POINTER_ARGUMENT)
}

function toNodeSourcePointer(nodeFfi: NodeFfiBackend, value: PointerSource): bigint {
  if (ArrayBuffer.isView(value)) {
    if (!(value.buffer instanceof ArrayBuffer)) {
      throw new TypeError(NODE_PTR_VALUE)
    }

    return nodeFfi.getRawPointer(value.buffer) + BigInt(value.byteOffset)
  }

  if (value instanceof ArrayBuffer) {
    return nodeFfi.getRawPointer(value)
  }

  throw new TypeError(NODE_PTR_VALUE)
}

function toNodePointerOffset(offset: number | undefined): bigint {
  if (offset == null) {
    return 0n
  }

  if (offset < 0) {
    throw new Error(POINTER_OFFSET_NEGATIVE)
  }

  if (!Number.isSafeInteger(offset)) {
    throw new Error(POINTER_OFFSET_UNSAFE)
  }

  return BigInt(offset)
}

function normalizeNodeDefinition(definition: FFIFunction): NodeFFIFunction {
  if (definition.ptr != null) {
    throw new Error(NODE_POINTER_OVERRIDE)
  }

  return {
    arguments: (definition.args ?? []).map((type) => toNodeFFIType(type, "parameter")),
    return: toNodeFFIType(definition.returns ?? FFIType.void, "result"),
  }
}

function toNodeFFIType(type: FFITypeOrString, position: "parameter" | "result"): string {
  switch (type) {
    case FFIType.char:
      return "char"
    case FFIType.int8_t:
    case FFIType.i8:
      return "i8"
    case FFIType.uint8_t:
    case FFIType.u8:
      return "u8"
    case FFIType.int16_t:
    case FFIType.i16:
      return "i16"
    case FFIType.uint16_t:
    case FFIType.u16:
      return "u16"
    case FFIType.int32_t:
    case FFIType.int:
    case FFIType.i32:
      return "i32"
    case FFIType.uint32_t:
    case FFIType.u32:
      return "u32"
    case FFIType.int64_t:
    case FFIType.i64:
      return "i64"
    case FFIType.uint64_t:
    case FFIType.u64:
      return "u64"
    case FFIType.double:
    case FFIType.f64:
      return "f64"
    case FFIType.float:
    case FFIType.f32:
      return "f32"
    case FFIType.bool:
      return "bool"
    case FFIType.ptr:
    case FFIType.pointer:
      return "pointer"
    case FFIType.void:
      return "void"
    case FFIType.cstring:
      // TODO(audit): cstring 与 string 的封送语义并不等价。node:ffi 的 `string`
      // 形参会把 JS 字符串拷进一块只在本次调用内有效的 NUL 结尾 UTF-8 缓冲区，
      // 调用方应当自己编码成字节缓冲区再传指针，不要依赖后端的字符串处理；
      // 作为返回值时 node:ffi 没有等价封送，直接拒绝。
      if (position === "result") {
        throw new Error(NODE_STRING_RETURN)
      }

      return "string"
    case FFIType.function:
    case FFIType.callback:
      // Pointer-like types (pointer, string, buffer, arraybuffer, and function)
      // are all passed as pointers in node:ffi.
      return "pointer"
    case FFIType.usize:
      // `usize` needs an ABI audit before Node support; use u64 would require
      // BigInt call sites and u32 can truncate pointers.
      throw new Error(NODE_USIZE_UNSUPPORTED)
    case FFIType.napi_env:
    case FFIType.napi_value:
      // N-API 桥接类型与 node:ffi 的裸指针并不等价，映射不了就直接拒绝。
      throw new Error(NODE_NAPI_UNSUPPORTED)
    case FFIType.buffer:
      return "buffer"
    default:
      return unsupportedNodeFFIType(type)
  }
}

function unsupportedNodeFFIType(type: never): never {
  throw new Error(`Unsupported FFIType for node:ffi: ${String(type)}`)
}

function toBigIntPointer(pointer: Pointer): bigint {
  if (typeof pointer === "bigint") {
    if (pointer < 0n) {
      throw new Error(POINTER_NEGATIVE)
    }

    return pointer
  }

  return toSafeBigIntPointer(pointer)
}

export const dlopen = backend.dlopen
export const ptr = backend.ptr
export const suffix = backend.suffix
export const toArrayBuffer = backend.toArrayBuffer
