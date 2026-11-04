# Third-Party Notices

## OpenAI Codex `apply-patch`

Files under `src/patches/apply-patch/` are a TypeScript port of
`external/codex/codex-rs/apply-patch` from OpenAI Codex.

- Copyright 2025 OpenAI
- Licensed under the Apache License, Version 2.0
- Full license text: `src/patches/apply-patch/LICENSE`
- Upstream NOTICE: `src/patches/apply-patch/NOTICE`
- Modifications: TypeScript port; heredoc/shell invocation removed; filesystem
  access is injected so the tool can enforce workspace scoping and atomic writes.

The port intentionally preserves upstream parsing, matching, line-ending, and
error-message semantics for compatibility with the upstream test fixtures.
