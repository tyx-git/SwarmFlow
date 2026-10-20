This directory contains local OpenTUI forks used by the OpenTUI prototype.

Current fork scope:
- `core/`
  A vendored copy of `packages/core/src` from OpenTUI.

Origin:
- Upstream project: OpenTUI
- Upstream repository: `https://github.com/anomalyco/opentui`
- Upstream license: MIT
- Local copy of the upstream MIT license: `LICENSE.opentui`

Why this fork exists:
- Preserve markdown whitespace and blank-line semantics more faithfully.
- Avoid OpenTUI's default markdown block spacing behavior for this app.
- Keep fenced code blocks aligned with the terminal's default foreground color.

Scope:
- This is currently a full local copy of OpenTUI core source so that local modifications can resolve relative imports safely.
- In practice, the only intentional behavior changes so far are in `core/renderables/Markdown.ts`.
- Renderer, scroll, input, mouse, selection, and other runtime systems are still behaviorally aligned with OpenTUI unless changed locally.
