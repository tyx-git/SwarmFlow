import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
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
  default: "/tmp/opentui-diag.jsonl",
})

registerEnvVar({
  name: "OPENTUI_DISABLE_MARKDOWN_PATCH",
  description: "Disable SwarmFlow's local OpenTUI markdown monkey patch.",
  type: "boolean",
  default: false,
})

registerEnvVar({
  name: "OPENTUI_ASSISTANT_RENDERER",
  description: "Assistant message renderer: 'markdown' or 'code'.",
  type: "string",
  default: "markdown",
})

const MAX_DIAG_BYTES = 8 * 1024 * 1024
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
export function isMarkdownPatchDisabled(): boolean {
  return Boolean(env.OPENTUI_DISABLE_MARKDOWN_PATCH)
}
export function getAssistantRenderer(): "markdown" | "code" {
  const value = String(env.OPENTUI_ASSISTANT_RENDERER ?? "markdown").trim().toLowerCase()
  return value === "code" ? "code" : "markdown"
}
export function resetOpenTuiDiagLog(context: Record<string, unknown> = {}): void {
  if (!isOpenTuiDiagEnabled()) return
  const path = getOpenTuiDiagPath()
  mkdirSync(dirname(path), { recursive: true })
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

