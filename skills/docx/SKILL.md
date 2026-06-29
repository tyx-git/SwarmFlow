---
name: docx
description: Create/edit Word documents — headings, tables, styles, images, TOC, headers/footers. Input: Word, Markdown, text, project files.
license: original (see skills/ATTRIBUTIONS.md)
source: original clean-room; uses python-docx (MIT), user-installed
user-invocable: true
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

## Core Principles

**Do NOT read user file contents.** When the input is an existing file (docx, md, txt), the agent must NOT read the file contents. File contents are private data. The agent only gathers requirements through interactive Q&A, then generates a Python script to process the file.

**Script storage:** All generated scripts are saved to `.swarmflow/<session_id>/docx/`.

**Output location:** Generated files are output to the project root `output/` directory. Create it if it doesn't exist.

## Interactive Requirements Gathering (branch by input type)

### Input existing file (docx/md/txt)

1. Confirm file path
2. Ask: "What do you need to do with this file?"
   - Modify content (text replacement, paragraph rewriting)
   - Adjust formatting (style unification, font/size)
   - Add table of contents
   - Insert images/tables
   - Add comments/tracked changes
   - Headers/footers/page numbers
3. Ask: output filename
4. Generate script to `.swarmflow/<session_id>/docx/`
5. Script outputs to `output/`

### Create from scratch

1. Ask: document type (report/thesis/proposal/manual)
2. Ask: structure needs (TOC/sections/headers/footers/page numbers)
3. Ask: style preference (formal/academic/business)
4. Ask: content source (outline/project files/free writing)
5. Generate script to `.swarmflow/<session_id>/docx/`
6. Script outputs to `output/`

## Input Sources (4 types)

| Source | Processing method | Use case |
|--------|------------------|----------|
| Word (.docx) | Don't read content. Ask user what to do, generate script | Edit/restructure existing document |
| Markdown | Don't read content. Ask user about conversion needs, generate script | Generate from outline/doc |
| Plain text | Don't read content. Ask user about formatting needs, generate script | Generate formatted doc from text |
| Project files | Don't read content. Ask user about needed info, generate script | Generate from project context |

## python-docx API Guide

**Core operations:**
- `Document()` / `Document("template.docx")`
- `document.paragraphs`, `document.tables`
- `add_heading`, `add_paragraph`, `add_table`, `add_picture`, `add_page_break`

**Styles:**
- Apply named styles: `paragraph.style = "Heading 1"`
- Don't hand-set fonts/sizes — use styles for consistency

**Find and replace:**
- Must operate at the *run* level (text is split across runs)
- Replacing `paragraph.text` wholesale destroys formatting

**Document structure:**
- TOC: via OOXML injection (python-docx doesn't directly support)
- Headers/footers: `section.header`, `section.footer`
- Sections: `document.add_section()`
- Page numbers: via OOXML field codes

**Rich media:**
- Images: `add_picture(path, width=Inches(5))`
- Tables: `add_table(rows, cols)` → fill `cell.text`

**Comments / tracked changes:**
- python-docx has limited support for tracked changes
- If the task needs real redlining, say what's feasible and what isn't

## Discipline

- Write to a new file unless told to edit in place; never clobber the source
  without confirming.
- After writing, reopen and verify key content/structure exists; report what was
  produced.
- **Script storage:** `.swarmflow/<session_id>/docx/`
- **Output location:** project root `output/` (create if missing)
