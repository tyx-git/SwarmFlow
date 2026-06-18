---
name: pptx
description: Create or edit PowerPoint (.pptx) presentations — slides from an outline or data, titles, bullets, tables, charts, images, speaker notes. Use when the user wants to build or modify a slide deck.
license: original (see skills/ATTRIBUTIONS.md)
source: original clean-room; uses python-pptx (MIT), user-installed
---

# Presentations (.pptx)

Drive `.pptx` with `python-pptx`. Think in terms of slide *layouts*, not
absolute coordinates — content placeholders keep the deck consistent and
themeable.

## Requirements (preflight)

```bash
python3 -c "import pptx" 2>/dev/null || python3 -m pip install python-pptx
```

`python-pptx` (MIT) is not bundled — install on demand, respect an active venv;
if install isn't possible, say so.

## Build well

- Start from a template if the user has one (`Presentation("template.pptx")`) so
  branding/master slides are inherited; otherwise the default template.
- Use the slide **layouts** from `prs.slide_layouts` and fill their
  **placeholders** (title, body, content) rather than dropping free-floating
  text boxes at hardcoded positions — that's what survives a theme change and
  looks intentional.
- One idea per slide. Title = the takeaway, not a label. Bullets short and
  parallel; few per slide. Prefer a chart/table/image over a wall of text.
- Charts via `chart.add_chart` with `CategoryChartData`; tables via
  `add_table`; images sized to the placeholder. Add **speaker notes**
  (`slide.notes_slide.notes_text_frame`) for narration when useful.
- Derive content from the real source (the data/outline/doc the user gave) —
  do not invent figures or claims to fill a slide.

## From data / outline

Given a dataset or an outline in `$ARGUMENTS`, map: section → title slide,
point → content slide, table/series → a chart slide. Keep the structure flat and
skimmable.

## Discipline

- Write to a new file unless told to edit in place; don't clobber a source deck
  without confirmation.
- Reopen the output, verify slide count and that key text/charts are present,
  and report the structure produced.
