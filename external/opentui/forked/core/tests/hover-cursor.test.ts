import { beforeEach, describe, expect, test, afterEach } from "bun:test"
import { createTestRenderer, MouseButtons, type MockMouse, type TestRenderer } from "../testing.js"
import { BoxRenderable } from "../renderables/index.js"
import { Renderable } from "../Renderable.js"
import type { MousePointerStyle } from "../types.js"

describe("mouse pointer style", () => {
  let renderer: TestRenderer
  let mockMouse: MockMouse
  let renderOnce: () => Promise<void>

  beforeEach(async () => {
    ;({ renderer, mockMouse, renderOnce } = await createTestRenderer({ width: 40, height: 20 }))
  })

  afterEach(() => {
    renderer.destroy()
  })

  test("setMousePointer sets style", async () => {
    renderer.setMousePointer("pointer")
    expect((renderer as any)._currentMousePointerStyle).toBe("pointer")
  })

  test("setMousePointer with 'default' clears style", async () => {
    renderer.setMousePointer("pointer")
    renderer.setMousePointer("default")
    expect((renderer as any)._currentMousePointerStyle).toBe("default")
  })

  test("setMousePointer supports all style types", async () => {
    const styles: MousePointerStyle[] = ["default", "pointer", "text", "crosshair", "move", "not-allowed"]
    for (const style of styles) {
      renderer.setMousePointer(style)
      expect((renderer as any)._currentMousePointerStyle).toBe(style)
    }
  })

  // Never touch the pointer while the terminal is unfocused: emitting a shape
  // change then would poison the terminal's recorded shape (it records but
  // doesn't repaint while unfocused), and an identical shape on focus regain is
  // de-duplicated — the cursor sticks stale. Suppressing the change keeps the
  // recorded shape consistent so the first hover after refocus repaints cleanly.
  test("setMousePointer is suppressed while the terminal is unfocused", () => {
    ;(renderer as any)._terminalFocusState = false
    renderer.setMousePointer("pointer")
    expect((renderer as any)._currentMousePointerStyle).toBeUndefined()

    ;(renderer as any)._terminalFocusState = true
    renderer.setMousePointer("pointer")
    expect((renderer as any)._currentMousePointerStyle).toBe("pointer")
  })

  test("onMouseOver callback can set mouse pointer", async () => {
    let pointerSet = false
    const box = new BoxRenderable(renderer, {
      position: "absolute",
      left: 5,
      top: 5,
      width: 10,
      height: 5,
      onMouseOver() {
        this.ctx.setMousePointer("pointer")
        pointerSet = true
      },
    })
    renderer.root.add(box)
    await renderOnce()

    await mockMouse.moveTo(10, 7)
    await renderOnce()

    expect(pointerSet).toBe(true)
    expect((renderer as any)._currentMousePointerStyle).toBe("pointer")
  })

  test("onMouseOut callback can reset mouse pointer", async () => {
    let pointerReset = false
    const box = new BoxRenderable(renderer, {
      position: "absolute",
      left: 5,
      top: 5,
      width: 10,
      height: 5,
      onMouseOver() {
        this.ctx.setMousePointer("pointer")
      },
      onMouseOut() {
        this.ctx.setMousePointer("default")
        pointerReset = true
      },
    })
    renderer.root.add(box)
    await renderOnce()

    // Move into box
    await mockMouse.moveTo(10, 7)
    await renderOnce()
    expect((renderer as any)._currentMousePointerStyle).toBe("pointer")

    // Move out of box
    await mockMouse.moveTo(1, 1)
    await renderOnce()

    expect(pointerReset).toBe(true)
    expect((renderer as any)._currentMousePointerStyle).toBe("default")
  })

  // Regression: the native render loop only flushes the OSC 22 pointer escape
  // during a render tick, but a render tick's sync block hides the text cursor
  // before the pointer section opens it — leaving the cursor invisible when
  // only the pointer changed. So setMousePointer emits the OSC 22 directly
  // via writeOut() instead of requestRender(), bypassing the sync block.
  // This test guards that the pointer escape IS emitted (via writeOut, not
  // requestRender) and that the tracked style is updated.
  test("setMousePointer emits the pointer escape directly", () => {
    let writeOutCalls = 0
    const original = (renderer as any).writeOut.bind(renderer)
    ;(renderer as any).writeOut = (...args: any[]) => {
      writeOutCalls++
      return original(...args)
    }
    renderer.setMousePointer("pointer")
    expect(writeOutCalls).toBeGreaterThan(0)
    expect((renderer as any)._currentMousePointerStyle).toBe("pointer")
  })

  // An element's own onMouseDown auto-resolves to a pointer, but an explicit
  // cursor on the same element must win — otherwise a container that handles
  // mouse-down for its own reasons (the full-screen click-to-dismiss/focus
  // background) turns every empty screen edge into a hand cursor.
  test("explicit cursor overrides the onMouseDown auto-pointer", () => {
    const button = new BoxRenderable(renderer, { onMouseDown() {} })
    expect(Renderable.resolveMouseCursor(button)).toBe("pointer")

    const background = new BoxRenderable(renderer, { cursor: "default", onMouseDown() {} })
    expect(Renderable.resolveMouseCursor(background)).toBe("default")
  })

  test("pointer resets on renderer destroy", async () => {
    renderer.setMousePointer("pointer")
    renderer.destroy()
    // After destroy, the reset is called internally - just verify no error
  })
})
