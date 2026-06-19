import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("patched markdown renderer does not treat synthetic thematic break as front matter", async () => {
  await import("./patch-opentui-markdown.js")

  const {
    CodeRenderable,
    MarkdownRenderable,
    RGBA,
    SyntaxStyle,
    TreeSitterClient,
  } = await import("@opentui/core")
  const { createTestRenderer } = await import("./core/testing/test-renderer.js")

  const dataPath = join(tmpdir(), "tree-sitter-patched-markdown-renderable-test-data")
  await mkdir(dataPath, { recursive: true })

  const treeSitterClient = new TreeSitterClient({ dataPath })
  await treeSitterClient.initialize()

  const testRenderer = await createTestRenderer({ width: 80, height: 30 })
  const { renderer, renderOnce, captureCharFrame } = testRenderer

  try {
    const syntaxStyle = SyntaxStyle.fromStyles({
      default: { fg: RGBA.fromValues(1, 1, 1, 1) },
    })

    const markdown = `| Name |
|---|
| Alice |
---
### UI 双轨
- **OpenTUI**（\`opentui-src/\`）—— 终端界面
---
### 技术栈
TypeScript`

    const md = new MarkdownRenderable(renderer, {
      id: "patched-markdown",
      content: markdown,
      syntaxStyle,
      treeSitterClient,
      conceal: true,
      tableOptions: { widthMode: "content" },
    })

    renderer.root.add(md)

    const hasPendingMarkdownHighlights = (): boolean =>
      md
        .getChildren()
        .some((child: unknown) =>
          child instanceof CodeRenderable &&
          child.filetype === "markdown" &&
          child.isHighlighting
        )

    await renderOnce()
    const startedAt = Date.now()
    while (hasPendingMarkdownHighlights() && Date.now() - startedAt < 2000) {
      await Bun.sleep(10)
      await renderOnce()
    }
    await renderOnce()

    const rendered = captureCharFrame()

    expect(rendered).toContain("UI 双轨")
    expect(rendered).toContain("- OpenTUI（opentui-src/）—— 终端界面")
    expect(rendered).toContain("技术栈")
    expect(rendered).not.toContain("### UI 双轨")
    expect(rendered).not.toContain("**OpenTUI**")
    expect(rendered).not.toContain("`opentui-src/`")
    expect(rendered).not.toContain("### 技术栈")
  } finally {
    renderer.destroy()
    await treeSitterClient.destroy()
  }
})

test("patched markdown renderer keeps coalesced spacing after tables", async () => {
  await import("./patch-opentui-markdown.js")

  const {
    CodeRenderable,
    MarkdownRenderable,
    RGBA,
    SyntaxStyle,
    TreeSitterClient,
  } = await import("@opentui/core")
  const { createTestRenderer } = await import("./core/testing/test-renderer.js")

  const dataPath = join(tmpdir(), "tree-sitter-patched-markdown-spacing-test-data")
  await mkdir(dataPath, { recursive: true })

  const treeSitterClient = new TreeSitterClient({ dataPath })
  await treeSitterClient.initialize()

  const testRenderer = await createTestRenderer({ width: 80, height: 30 })
  const { renderer, renderOnce, captureCharFrame } = testRenderer

  try {
    const syntaxStyle = SyntaxStyle.fromStyles({
      default: { fg: RGBA.fromValues(1, 1, 1, 1) },
    })

    const markdown = `| A | B |
|---|---|
| 1 | 2 |

### Heading`

    const md = new MarkdownRenderable(renderer, {
      id: "patched-markdown-spacing",
      content: markdown,
      syntaxStyle,
      treeSitterClient,
      conceal: true,
      tableOptions: { widthMode: "content" },
    })

    renderer.root.add(md)

    const hasPendingMarkdownHighlights = (): boolean =>
      md
        .getChildren()
        .some((child: unknown) =>
          child instanceof CodeRenderable &&
          child.filetype === "markdown" &&
          child.isHighlighting
        )

    await renderOnce()
    const startedAt = Date.now()
    while (hasPendingMarkdownHighlights() && Date.now() - startedAt < 2000) {
      await Bun.sleep(10)
      await renderOnce()
    }
    await renderOnce()

    const lines = captureCharFrame()
      .split("\n")
      .map((line) => line.trimEnd())
    const tableBottom = lines.findIndex((line) => line.includes("└"))
    const heading = lines.findIndex((line) => line.trim() === "Heading")

    expect(tableBottom).toBeGreaterThanOrEqual(0)
    expect(heading).toBe(tableBottom + 2)
  } finally {
    renderer.destroy()
    await treeSitterClient.destroy()
  }
})

test("patched markdown renderer keeps one separator before a tight fenced code block", async () => {
  // Regression for the monkeypatch coalescer: a paragraph immediately followed by a fenced
  // code block (no blank line in source) must still render exactly one separator row. The
  // patched buildRenderableTokens wins at runtime, so it must carry the in-tree
  // `currentIsSeparate` rule — otherwise this collapses to zero rows in the real app.
  await import("./patch-opentui-markdown.js")

  const {
    CodeRenderable,
    MarkdownRenderable,
    RGBA,
    SyntaxStyle,
    TreeSitterClient,
  } = await import("@opentui/core")
  const { createTestRenderer } = await import("./core/testing/test-renderer.js")

  const dataPath = join(tmpdir(), "tree-sitter-patched-markdown-tight-code-test-data")
  await mkdir(dataPath, { recursive: true })

  const treeSitterClient = new TreeSitterClient({ dataPath })
  await treeSitterClient.initialize()

  const testRenderer = await createTestRenderer({ width: 80, height: 30 })
  const { renderer, renderOnce, captureCharFrame } = testRenderer

  try {
    const syntaxStyle = SyntaxStyle.fromStyles({
      default: { fg: RGBA.fromValues(1, 1, 1, 1) },
    })

    // No blank line between the paragraph and the fence — the "tight" case.
    const markdown = "Before\n```js\nconst value = 1\n```"

    const md = new MarkdownRenderable(renderer, {
      id: "patched-markdown-tight-code",
      content: markdown,
      syntaxStyle,
      treeSitterClient,
      conceal: true,
    })

    renderer.root.add(md)

    const hasPendingMarkdownHighlights = (): boolean =>
      md
        .getChildren()
        .some((child: unknown) =>
          child instanceof CodeRenderable &&
          child.filetype === "markdown" &&
          child.isHighlighting
        )

    await renderOnce()
    const startedAt = Date.now()
    while (hasPendingMarkdownHighlights() && Date.now() - startedAt < 2000) {
      await Bun.sleep(10)
      await renderOnce()
    }
    await renderOnce()

    const lines = captureCharFrame()
      .split("\n")
      .map((line) => line.trimEnd())
    const before = lines.findIndex((line) => line.trim() === "Before")
    // The fenced code block renders as a bordered box; its top border is the first row of
    // the block. Exactly one blank separator row between the paragraph and that border means
    // the box top sits at before + 2 (before + 1 would mean the separator collapsed).
    const codeBoxTop = lines.findIndex((line) => line.includes("╭"))

    expect(before).toBeGreaterThanOrEqual(0)
    expect(codeBoxTop).toBe(before + 2)
  } finally {
    renderer.destroy()
    await treeSitterClient.destroy()
  }
})

test("patched markdown renderer respects non-streaming markdown height floors", async () => {
  await import("./patch-opentui-markdown.js")

  const {
    MarkdownRenderable,
    RGBA,
    SyntaxStyle,
    TreeSitterClient,
  } = await import("@opentui/core")
  const { createTestRenderer } = await import("./core/testing/test-renderer.js")

  const dataPath = join(tmpdir(), "tree-sitter-patched-markdown-height-floor-test-data")
  await mkdir(dataPath, { recursive: true })

  const treeSitterClient = new TreeSitterClient({ dataPath })
  await treeSitterClient.initialize()

  const testRenderer = await createTestRenderer({ width: 80, height: 30 })
  const { renderer, renderOnce } = testRenderer

  try {
    const syntaxStyle = SyntaxStyle.fromStyles({
      default: { fg: RGBA.fromValues(1, 1, 1, 1) },
    })

    const md = new MarkdownRenderable(renderer, {
      id: "patched-markdown-height-floor",
      content: "Paragraph",
      syntaxStyle,
      treeSitterClient,
      streaming: false,
      conceal: true,
    })

    renderer.root.add(md)
    await renderOnce()

    const renderable = md._blockStates[0]?.renderable as { reserveHeightWhileStreaming?: boolean } | undefined
    expect(renderable?.reserveHeightWhileStreaming).toBe(false)
  } finally {
    renderer.destroy()
    await treeSitterClient.destroy()
  }
})

test("patched top-level markdown renderer avoids stale spacing when a streaming table forms", async () => {
  await import("./patch-opentui-markdown.js")

  const {
    CodeRenderable,
    MarkdownRenderable,
    RGBA,
    SyntaxStyle,
    TreeSitterClient,
  } = await import("@opentui/core")
  const { createTestRenderer } = await import("./core/testing/test-renderer.js")

  const dataPath = join(tmpdir(), "tree-sitter-patched-markdown-top-level-streaming-table-test-data")
  await mkdir(dataPath, { recursive: true })

  const treeSitterClient = new TreeSitterClient({ dataPath })
  await treeSitterClient.initialize()

  const testRenderer = await createTestRenderer({ width: 80, height: 30 })
  const { renderer, renderOnce, captureCharFrame } = testRenderer

  try {
    const syntaxStyle = SyntaxStyle.fromStyles({
      default: { fg: RGBA.fromValues(1, 1, 1, 1) },
    })

    const md = new MarkdownRenderable(renderer, {
      id: "patched-markdown-top-level-streaming-table",
      content: "### 总结\n\n| A | B |\n| 1 | 2 |",
      syntaxStyle,
      treeSitterClient,
      streaming: true,
      internalBlockMode: "top-level",
      conceal: true,
      tableOptions: {
        widthMode: "content",
        borders: true,
        outerBorder: true,
      },
    })

    renderer.root.add(md)

    const hasPendingMarkdownHighlights = (): boolean =>
      md
        .getChildren()
        .some((child: unknown) =>
          child instanceof CodeRenderable &&
          child.filetype === "markdown" &&
          child.isHighlighting
        )

    await renderOnce()
    const startedAt = Date.now()
    while (hasPendingMarkdownHighlights() && Date.now() - startedAt < 2000) {
      await Bun.sleep(10)
      await renderOnce()
    }
    await renderOnce()

    const headingBefore = md._blockStates[0]?.renderable

    md.content = "### 总结\n\n| A | B |\n|---|---|\n| 1 | 2 |"
    await renderOnce()

    expect(md._blockStates.map((state) => state.token.type)).toEqual(["heading", "table"])
    expect(md._blockStates[0]?.renderable).toBe(headingBefore)
    expect(md._blockStates[0]?.renderable.height).toBe(1)

    const lines = captureCharFrame()
      .split("\n")
      .map((line) => line.trimEnd())

    const heading = lines.findIndex((line) => line.trim() === "总结")
    const tableTop = lines.findIndex((line) => line.includes("┌"))

    expect(heading).toBeGreaterThanOrEqual(0)
    expect(tableTop).toBe(heading + 2)
    expect(lines.some((line) => line.includes("| A | B |"))).toBe(false)
  } finally {
    renderer.destroy()
    await treeSitterClient.destroy()
  }
})
