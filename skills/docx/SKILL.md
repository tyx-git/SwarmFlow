---
name: docx
description: Create or edit Microsoft Word (.docx) documents — headings, paragraphs, tables, styles, images, find-and-replace, extract text. Use when the user wants to read, generate, or modify a .docx file.
license: original (see skills/ATTRIBUTIONS.md)
source: original clean-room; uses python-docx (MIT), user-installed
---

# Word (.docx)

`.docx` is a zipped OOXML package — don't hand-edit it. Drive it with
`python-docx`, writing a small tailored script for the task.

## Requirements (preflight)

```bash
python3 -c "import docx" 2>/dev/null || python3 -m pip install python-docx
```

`python-docx` (MIT) is not bundled — install on demand, respecting an active
venv. If install isn't possible, say so; don't pretend.

## Reading / extracting

Write a short script that opens the doc and walks `document.paragraphs`,
`document.tables`, headers/footers. For a quick text dump, iterate paragraphs
and print `.text`. Report structure (headings, table count) so the user sees
what's there before editing.

## Creating / editing

- **Prefer styles over manual formatting**: apply named styles
  (`Heading 1`, `Title`, `Normal`, a table style) so the document stays
  consistent and themeable — don't hand-set fonts/sizes everywhere.
- Build structure explicitly: `add_heading`, `add_paragraph`,
  `add_table(rows, cols)` then fill cells, `add_picture(path, width=…)`,
  `add_page_break`.
- **Find-and-replace** must operate at the *run* level (text is split across
  runs); replacing `paragraph.text` wholesale destroys formatting. Handle runs
  carefully or rebuild the paragraph deliberately.
- For an existing template, open it and fill placeholders rather than rebuilding
  from scratch.

## Tracked changes / comments

`python-docx` has limited support for tracked changes/comments. If the task
needs real redlining, say what's feasible and what isn't rather than silently
producing a doc without tracked changes.

## Discipline

- Write to a new file unless the user explicitly wants in-place; never clobber
  the source without confirming.
- After writing, reopen the output and verify the key content/structure exists;
  report what was produced. `$ARGUMENTS` is the file and/or instruction.
