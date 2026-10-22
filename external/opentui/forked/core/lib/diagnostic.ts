import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { rotateLogFile } from "../../../../../src/logging/rotation.js"
import { env, registerEnvVar } from "./env.js"

registerEnvVar({
  name: "OPENTUI_DIAG",
  description: "Enable synchronous JSONL diagnostics for SwarmFlow's OpenTUI integration.",
  type: "boolean",
  default: false,
})

registerEnvVar({
  name: "OPENTUI_DIAG_PATH",
  description: "Path for SwarmFlow OpenTUI diagnostic JSONL output.",
  type: "string",
  // 默认落在 ~/.swarmflow/ 下，和 stderr.log 放在一起 —— 排查问题时只需要
  // 翻一个目录。历史上默认值是 POSIX 的 /tmp/opentui-diag.jsonl，在 Windows
  // 上会落到当前盘的 \tmp\ 里，极难发现。
  default: join(homedir(), ".swarmflow", "opentui-diag.jsonl"),
})

const MAX_DIAG_BYTES = 8 * 1024 * 1024
/** 同一次运行内允许写到单个日志文件的最大字节数，超出后丢弃后续记录。 */
/** 启动时把上一次的日志归档成 .1/.2/...，最多保留这么多份。 */
const DIAG_ARCHIVE_KEEP = 5
let currentBytes = 0
let didReset = false
let didTruncate = false
let sequence = 0

function sanitize(value: unknown, depth: number = 0): unknown {
  if (depth > 4) return "[max-depth]"
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    }
  }
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}...[truncated]` : value
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value
  }
  if (typeof value === "bigint") {

    return value.toString()

  }
  if (typeof value === "undefined") {

    return undefined

  }
  if (Array.isArray(value)) {

    return value.slice(0, 32).map((item) => sanitize(item, depth + 1))
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      out[key] = sanitize(entry, depth + 1)
    }
    return out
  }
  return String(value)
}
function appendLine(line: string): void {
  const path = getOpenTuiDiagPath()
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, line, "utf8")
  currentBytes += Buffer.byteLength(line)
}
export function isOpenTuiDiagEnabled(): boolean {
  return Boolean(env.OPENTUI_DIAG)
}
export function getOpenTuiDiagPath(): string {
  return String(env.OPENTUI_DIAG_PATH)
}
export function resetOpenTuiDiagLog(context: Record<string, unknown> = {}): void {
  if (!isOpenTuiDiagEnabled()) return
  const path = getOpenTuiDiagPath()
  mkdirSync(dirname(path), { recursive: true })

  // 归档上一次的运行记录，而不是直接清空 —— 出问题时往往要对比"上一次能跑、
  // 这一次挂了"的差异，把历史抹掉等于把唯一的证据也抹掉了。
  if (!rotateLogFile(path, DIAG_ARCHIVE_KEEP)) {
    try {
      writeFileSync(path, "", "utf8")
    } catch {
      // ignore
    }
  }

  writeFileSync(path, "", "utf8")
  currentBytes = 0
  didReset = true
  didTruncate = false
  sequence = 0
  writeOpenTuiDiag("diag.start", context)
}
export function writeOpenTuiDiag(event: string, payload: Record<string, unknown> = {}): void {
  if (!isOpenTuiDiagEnabled()) return
  if (!didReset) {
    resetOpenTuiDiagLog({ reason: "implicit-reset" })
  }
  const record = {
    seq: ++sequence,
    ts: new Date().toISOString(),
    pid: process.pid,
    event,
    ...(sanitize(payload) as Record<string, unknown>),
  }
  const line = `${JSON.stringify(record)}\n`
  if (currentBytes + Buffer.byteLength(line) > MAX_DIAG_BYTES) {
    if (!didTruncate) {
      didTruncate = true
      appendLine(
        `${JSON.stringify({
          seq: ++sequence,
          ts: new Date().toISOString(),
          pid: process.pid,
          event: "diag.truncated",
          maxBytes: MAX_DIAG_BYTES,
        })}\n`,
      )
    }
    return
  }
  appendLine(line)
}
export function previewLatin1Sequence(input: string, maxChars: number = 160): string {
  const preview = JSON.stringify(input)
  if (preview.length <= maxChars) return preview
  return `${preview.slice(0, maxChars)}...[truncated]`
}
export function previewLatin1Hex(input: string, maxBytes: number = 64): string {
  return Buffer.from(input, "latin1").subarray(0, maxBytes).toString("hex")
}
