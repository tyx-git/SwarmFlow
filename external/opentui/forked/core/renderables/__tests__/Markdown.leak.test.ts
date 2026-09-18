/**
 * Leak characterization: rendering a large streamed markdown code block and
 * then destroying the renderable must return the live-renderable population
 * (Renderable.renderablesByNumber) to its baseline. A residual after destroy
 * means block renderables (and their native TextBuffers) are orphaned — the
 * suspected source of the "short task → 1GB" RSS the A/B repro showed.
 */

import { test, expect, beforeEach, afterEach } from "bun:test"
import { MarkdownRenderable } from "../Markdown.js"
import { Renderable } from "../../Renderable.js"
import { SyntaxStyle } from "../../syntax-style.js"
import { RGBA } from "../../lib/RGBA.js"
import { createTestRenderer, type TestRenderer } from "../../testing.js"

let renderer: TestRenderer
let renderOnce: () => Promise<void>

const syntaxStyle = SyntaxStyle.fromStyles({
  default: { fg: RGBA.fromValues(1, 1, 1, 1) },
})

beforeEach(async () => {
  const t = await createTestRenderer({ width: 80, height: 40 })
  renderer = t.renderer
  renderOnce = t.renderOnce
})

afterEach(async () => {
  if (renderer) renderer.destroy()
})

function bigCodeBlock(lines: number): string {
  const body = Array.from({ length: lines }, (_, i) =>
    `    const value_${i} = computeSomething(${i}, "a moderately long string argument ${i}");`,
  ).join("\n")
  return "Here is the file:\n\n```typescript\n" + body + "\n```\n\nDone.\n"
}

function liveCount(): number {
  return Renderable.renderablesByNumber.size
}

test("destroying a streamed markdown code block returns to the renderable baseline", async () => {
  const baseline = liveCount()

  const full = bigCodeBlock(400)
  const md = new MarkdownRenderable(renderer, {
    id: "leak-md",
    content: "",
    syntaxStyle,
    streaming: true,
    conceal: true,
    internalBlockMode: "top-level",
    width: "100%",
  })
  renderer.root.add(md)

  // Simulate streaming: grow the content in chunks, re-rendering each step
  // (this is the path that churned RSS to >1GB).
  const STEPS = 40
  for (let s = 1; s <= STEPS; s++) {
    md.content = full.slice(0, Math.floor((full.length * s) / STEPS))
    await renderOnce()
  }
  md.content = full
  md.streaming = false
  await renderOnce()

  const peak = liveCount()
  expect(peak).toBeGreaterThan(baseline) // blocks were actually created

  // Unmount the way the reconciler does on delete: detach from parent, then
  // destroyRecursively (detachDeletedInstance fires destroy when !parent).
  renderer.root.remove(md.id)
  md.destroyRecursively()
  await renderOnce()

  const after = liveCount()

  if (after > baseline) {
    // Surface what leaked so the fix can target it.
    const counts = new Map<string, number>()
    for (const r of Renderable.renderablesByNumber.values()) {
      const name = r.constructor.name
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    // eslint-disable-next-line no-console
    console.log("LEAKED renderables after destroy:", Object.fromEntries(counts), "delta:", after - baseline)
  }

  expect(after).toBe(baseline)
})

test("repeated create→stream→destroy cycles do not grow the JS heap (leak vs churn)", async () => {
  const full = bigCodeBlock(600)
  const runCycle = async () => {
    const md = new MarkdownRenderable(renderer, {
      id: `cycle-md`,
      content: "",
      syntaxStyle,
      streaming: true,
      conceal: true,
      internalBlockMode: "top-level",
      width: "100%",
    })
    renderer.root.add(md)
    for (let s = 1; s <= 20; s++) {
      md.content = full.slice(0, Math.floor((full.length * s) / 20))
      await renderOnce()
    }
    md.streaming = false
    md.content = full
    await renderOnce()
    renderer.root.remove(md.id)
    md.destroyRecursively()
    await renderOnce()
  }

  // Warm up (first cycle allocates lazily-initialized singletons/caches).
  await runCycle()
  Bun.gc(true)
  const baseRenderables = Renderable.renderablesByNumber.size
  const baseHeap = process.memoryUsage().heapUsed

  const CYCLES = 6
  for (let i = 0; i < CYCLES; i++) await runCycle()

  Bun.gc(true)
  const afterRenderables = Renderable.renderablesByNumber.size
  const afterHeap = process.memoryUsage().heapUsed
  const grownMB = (afterHeap - baseHeap) / (1024 * 1024)

  // eslint-disable-next-line no-console
  console.log(
    `heap base=${(baseHeap / 1048576).toFixed(1)}MB after ${CYCLES} cycles=${(afterHeap / 1048576).toFixed(1)}MB ` +
    `grown=${grownMB.toFixed(1)}MB | renderables base=${baseRenderables} after=${afterRenderables}`,
  )

  // Live renderables must not accumulate across cycles.
  expect(afterRenderables).toBe(baseRenderables)
  // A real leak would grow the heap roughly linearly with cycles (each cycle
  // renders a 600-line block). Allow generous slack for caches/fragmentation
  // but fail if it grows unbounded (> ~3MB/cycle sustained).
  expect(grownMB).toBeLessThan(CYCLES * 3)
})
