---
name: xlsx
description: Create/edit/analyze Excel spreadsheets — formulas, charts, formatting, data cleaning. Input: .xlsx, .csv, .tsv.
license: original (see skills/ATTRIBUTIONS.md)
source: original clean-room; uses openpyxl (MIT); optional pandas (BSD-3), user-installed
user-invocable: true
---

# Spreadsheets (.xlsx / .csv / .tsv)

Pick the tool by task: **openpyxl** for cell-level control, formulas, styles,
charts; **pandas** for bulk analysis/cleaning of tabular data.

## Requirements (preflight)

```bash
python3 -c "import openpyxl" 2>/dev/null || python3 -m pip install openpyxl
# only if doing bulk analysis/cleaning:
python3 -c "import pandas"  2>/dev/null || python3 -m pip install pandas
```

Not bundled — install on demand, respect an active venv, and if install fails
say so rather than faking results.

## Core Principles

**Do NOT read user file contents.** When the input is an existing file (xlsx, csv, tsv), the agent must NOT read the file contents. File contents are private data. The agent only gathers requirements through interactive Q&A, then generates a Python script to process the file.

**Script storage:** All generated scripts are saved to `.swarmflow/<session_id>/xlsx/`.

**Output location:** Generated files are output to the project root `output/` directory. Create it if it doesn't exist.

## Interactive Requirements Gathering (branch by input type)

### Input existing file (xlsx/csv/tsv)

1. Confirm file path
2. Ask: "What do you need to do with this file?"
   - Add data/rows/columns
   - Modify formulas
   - Format (conditional formatting, number formats, styles)
   - Add charts
   - Data cleaning (dedup, type fixes, missing values)
   - Data analysis/summary
   - Convert format
3. Ask: output filename
4. Generate script to `.swarmflow/<session_id>/xlsx/`
5. Script outputs to `output/`

### Create from scratch

1. Ask: topic/purpose
2. Ask: data source (manual input / convert from other format / extract from project files)
3. Ask: structure (column definitions / sheet planning)
4. Ask: need charts/formulas/formatting?
5. Generate script to `.swarmflow/<session_id>/xlsx/`
6. Script outputs to `output/`

## Input Sources (3 types)

| Source | Processing method | Use case |
|--------|------------------|----------|
| Excel (.xlsx) | Don't read content. Ask user what to do, generate script | Edit/analyze existing spreadsheet |
| CSV | Don't read content. Ask user what to do, generate script | Data cleaning/conversion/analysis |
| TSV | Don't read content. Ask user what to do, generate script | Data cleaning/conversion/analysis |

## openpyxl API Guide

**Core operations:**
- `load_workbook(path)` (add `data_only=True` to read computed values instead of formula strings)
- `Workbook()` to create new workbook
- `ws.title`, `ws.max_row`, `ws.max_column`
- `ws["A1"]`, `ws.cell(row, col)`

**Formulas:**
- Write formula strings: `ws["C2"] = "=A2*B2"`
- openpyxl does not compute them — Excel/LibreOffice does on open
- If you need the computed value now, compute it in Python and write the value

**Charts:**
- `openpyxl.chart.BarChart/PieChart/LineChart`
- `chart.add_data(ws, min_col, min_row, max_row)`
- `ws.add_chart(chart, "E2")`

**Formatting:**
- `cell.number_format` (date/number formats)
- `Font`, `PatternFill`, `Border`, `Alignment`
- `ws.conditional_formatting.add(...)`

**Data validation:**
- `DataValidation` object to restrict input

## pandas API Guide

**Reading:**
- `pd.read_excel(path, sheet_name=...)`
- `pd.read_csv(path, sep='\t')` (TSV)

**Cleaning:**
- `df.drop_duplicates()`
- `df.fillna(value)` / `df.dropna()`
- `df.astype({...})` fix types
- `df.str.strip()` normalize text

**Analysis:**
- `df.groupby(...).agg({...})`
- `df.pivot_table(...)`
- `df.describe()`

**Writing back:**
- `df.to_excel(path, index=False)`
- `df.to_csv(path, sep='\t', index=False)`

## Batch Processing

- Multi-file merge: `pd.concat([pd.read_csv(f) for f in files])`
- Batch format conversion: iterate files → read → write target format
- Batch cleaning: apply unified cleaning function to multiple files

## Discipline

- Output to new file unless explicitly told to edit in place
- After writing, reopen and verify row/column counts and key data
- Report change summary (row count changes, columns added, cleaning stats)
- Never overwrite source data without confirmation
- **Script storage:** `.swarmflow/<session_id>/xlsx/`
- **Output location:** project root `output/` (create if missing)
