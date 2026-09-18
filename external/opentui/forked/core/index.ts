// Core exports without 3D dependencies.
//
// Explicit re-exports for symbols that downstream pre-bundled chunks
// (notably @opentui/react/chunk-pr7s7hvy.js) `extends`. Bun
// --compile on Windows hits an ESM module-evaluation order bug where
// these symbols resolve to an uninitialised namespace binding when
// imported through the deeper `export * from "./renderables/index.js"`
// chain (which itself is a re-export hub for 23 files). Pulling them
// up as direct re-exports gives the bundler a single-hop resolution
// path that's evaluated alongside the rest of this module.
export {
  TextNodeRenderable,
  RootTextNodeRenderable,
} from "./renderables/TextNode.js"

export * from "./Renderable.js"
export * from "./types.js"
export * from "./utils.js"
export * from "./buffer.js"
export * from "./text-buffer.js"
export * from "./text-buffer-view.js"
export * from "./edit-buffer.js"
export * from "./editor-view.js"
export * from "./syntax-style.js"
export * from "./post/effects.js"
export * from "./post/filters.js"
export * from "./post/matrices.js"
export * from "./animation/Timeline.js"
export * from "./lib/index.js"
export * from "./renderer.js"
export * from "./plugins/types.js"
export * from "./plugins/registry.js"
export * from "./plugins/core-slot.js"
export * from "./NativeSpanFeed.js"
export * from "./audio.js"
export * from "./renderables/index.js"
export * from "./zig.js"
export * from "./console.js"
export * as Yoga from "./yoga.js"
