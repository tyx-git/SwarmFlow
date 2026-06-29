---
name: pptx
description: Create/edit PowerPoint slides — titles, bullets, tables, charts, images. Input: Markdown, Word, project files, or existing .pptx.
license: original (see skills/ATTRIBUTIONS.md)
source: original clean-room; uses python-pptx (MIT), user-installed
user-invocable: true
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

## Core Principles

**Do NOT read user file contents.** When the input is an existing file (pptx, md, docx, etc.), the agent must NOT read the file contents. File contents are private data. The agent only gathers requirements through interactive Q&A, then generates a Python script to process the file.

**Script storage:** All generated scripts are saved to `.swarmflow/<session_id>/pptx/`.

**Output location:** Generated files are output to the project root `output/` directory. Create it if it doesn't exist.

## Interactive Requirements Gathering

Before generating a PPT, confirm these details with the user (skip any already
provided):

| Question | Example options |
|----------|----------------|
| Topic/purpose | Free text |
| Target audience | Internal team / Clients / Investors / Academic |
| Slide count range | 5-8 / 10-15 / 15-20 / Custom |
| Style preference | Business clean / Academic rigorous / Creative visual / Product showcase |
| Input source | See Input Sources below |
| Template available? | Provide path / Use default |
| Need a speech script? | Yes → invoke /speaker skill / No |

## Input Sources (4 types)

| Source | Processing method | Use case |
|--------|------------------|----------|
| Markdown doc | Don't read content. Ask user about structure, then generate script | Generate from outline/doc |
| Word doc | Don't read content. Ask user about structure, then generate script | Generate from report/doc |
| Project files | Don't read content. Ask user about needed info, then generate script | Generate from project context |
| Existing .pptx | Don't read content. Ask user what to add/modify, then generate script | Edit/restructure existing deck |

**Processing strategy:**
- Do NOT read user file contents (file contents are private data)
- Gather requirements through interactive Q&A
- Generate python-pptx script to `.swarmflow/<session_id>/pptx/`
- Script outputs to project root `output/`

## python-pptx API Guide

**Core operations:**
- `Presentation()` / `Presentation("template.pptx")`
- `prs.slide_layouts` → choose layout (Title, Content, Two Content, Blank, etc.)
- `prs.slides.add_slide(layout)` → add slide
- `slide.placeholders[idx]` → fill placeholder

**Content types:**
- Text: `placeholder.text = "..."` or `text_frame.add_paragraph()`
- Tables: `shapes.add_table(rows, cols)` → fill `cell.text`
- Charts: `slide.shapes.add_chart(chart_type, CategoryChartData(...))`
- Images: `slide.shapes.add_picture(path, left, top, width, height)`
- Shapes: `slide.shapes.add_shape(...)`
- Speaker notes: `slide.notes_slide.notes_text_frame.text = "..."`

**Master slides & themes:**
- `prs.slide_master` → access master slide
- Theme colors/fonts inherited from template — don't set manually
- Always use layout placeholders, not free text boxes
- Start from template if user has one (`Presentation("template.pptx")`)

## From Data / Outline

Given a dataset or outline, map: section → title slide, point → content slide,
table/series → chart slide. Keep structure flat and skimmable.

## Discipline

- Write to a new file unless told to edit in place; don't clobber a source deck
  without confirmation.
- After writing, reopen the output, verify slide count and that key text/charts
  are present, and report the structure produced.
- If the user needs a speech script, pass the PPT path to /speaker.
- **Script storage:** `.swarmflow/<session_id>/pptx/`
- **Output location:** project root `output/` (create if missing)
