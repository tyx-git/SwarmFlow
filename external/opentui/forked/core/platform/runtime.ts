import { existsSync } from "node:fs"
import { mkdir, writeFile as writeFileNode } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import stringWidthLib from "string-width"
import stripAnsiLib from "strip-ansi"

export interface WriteFileOptions {
  createPath?: boolean
  mode?: number
}

interface FileImportModule {
  default: string
}

type FilePathFallback = string | URL | (() => string | URL)

const TEXT_ENCODER = new TextEncoder()

// 本项目只跑在 Node 上（tsx 开发态与打包后的 SEA exe），因此这里不再做运行时探测，
// 每个能力直接用 Node 实现。上游 fork 的 Bun 分支不在我们的运行图里。
export const sleep: (msOrDate: number | Date) => Promise<void> = standardSleep
export const stringWidth: (text: string) => number = stringWidthLib
export const stripANSI: (text: string) => string = stripAnsiLib
export const writeFile: (
  destination: string | URL,
  data: string | ArrayBufferView,
  options?: WriteFileOptions,
) => Promise<number> = writeFilePortable

/**
 * 解析随包的 tree-sitter 资产（.scm / .wasm）路径。
 *
 * 打包器会把 `import()` 回调重写成发射产物（`./assets/<name>-<hash>`）的路径，
 * 所以只能执行 loader 拿结果，不能去读它的源码。开发态（tsx）没有重写，
 * import 的是源文件本身，回退路径就是正确答案 —— 先试回退路径存在与否，
 * 覆盖两种布局。
 */
export async function resolveBundledFilePath(
  loadBundledFile: () => Promise<FileImportModule>,
  fallbackPath: FilePathFallback,
  metaUrl: string,
): Promise<string> {
  const path = resolveFallbackFilePath(fallbackPath, metaUrl)
  if (existsSync(path)) {
    return path
  }

  return normalizeLoadedFilePath((await loadBundledFile()).default, metaUrl)
}

function resolveFallbackFilePath(fallbackPath: FilePathFallback, metaUrl: string): string {
  const path = typeof fallbackPath === "function" ? fallbackPath() : fallbackPath
  return fileURLToPath(path instanceof URL ? path : new URL(path, metaUrl))
}

function normalizeLoadedFilePath(loadedPath: string, baseUrl: string): string {
  if (loadedPath.startsWith("file:")) {
    return fileURLToPath(loadedPath)
  }

  if (isAbsolute(loadedPath)) {
    return loadedPath
  }

  return resolve(dirname(fileURLToPath(baseUrl)), loadedPath)
}

function standardSleep(msOrDate: number | Date): Promise<void> {
  const ms = msOrDate instanceof Date ? msOrDate.getTime() - Date.now() : msOrDate
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function writeFilePortable(
  destination: string | URL,
  data: string | ArrayBufferView,
  options?: WriteFileOptions,
): Promise<number> {
  const destinationPath = destination instanceof URL ? fileURLToPath(destination) : destination

  if (options?.createPath) {
    await mkdir(dirname(destinationPath), { recursive: true })
  }

  const bytes =
    typeof data === "string" ? TEXT_ENCODER.encode(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)

  await writeFileNode(destinationPath, bytes, { mode: options?.mode })

  return bytes.byteLength
}
