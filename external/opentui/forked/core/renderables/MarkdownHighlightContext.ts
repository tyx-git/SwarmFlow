import type { OnHighlightCallback } from "./Code.js"
import { getTreeSitterClient, type TreeSitterClient } from "../lib/tree-sitter/index.js"
import type { SimpleHighlight } from "../lib/tree-sitter/types.js"

const FRONT_MATTER_OPENER_RE = /^(?:---|\+\+\+)(?:[ \t]*(?:\r?\n|$))/

function shiftHighlights(highlights: SimpleHighlight[], offset: number): SimpleHighlight[] {
  const shifted: SimpleHighlight[] = []

  for (const highlight of highlights) {
    const start = highlight[0] - offset
    const end = highlight[1] - offset
    if (end <= 0) continue

    shifted.push([
      Math.max(0, start),
      end,
      highlight[2],
      highlight[3],
    ])
  }

  return shifted
}

export function createMarkdownSyntheticBlockHighlighter(
  getClient: () => TreeSitterClient | undefined,
): OnHighlightCallback {
  return async (_highlights, context) => {
    if (context.filetype !== "markdown" || !FRONT_MATTER_OPENER_RE.test(context.content)) {
      return undefined
    }

    const prefix = "\n"
    const client = getClient() ?? getTreeSitterClient()
    const result = await client.highlightOnce(`${prefix}${context.content}`, "markdown")
    return shiftHighlights(result?.highlights ?? [], prefix.length)
  }
}
