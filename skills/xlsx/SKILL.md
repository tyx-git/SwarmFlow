---
name: xlsx
description: Create, edit, analyze, or clean Excel/.xlsx (and .csv) spreadsheets — formulas, multiple sheets, charts, formatting, data cleaning. Use when the user wants to read, build, or transform a spreadsheet.
license: original (see skills/ATTRIBUTIONS.md)
source: original clean-room; uses openpyxl (MIT); optional pandas (BSD-3), user-installed
---

# Spreadsheets (.xlsx / .csv)

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

## Inspect before you touch

Always characterize the workbook first: sheet names, dimensions, header row,
column types, NaN/blank counts. Print this. Editing a spreadsheet blind is how
data gets silently corrupted.

## Editing with openpyxl

- `load_workbook(path)` (add `data_only=True` to read computed values instead of
  formula strings — know which you need).
- Address cells explicitly; preserve existing formatting/sheets you aren't
  changing.
- Write **formulas** as strings (`ws["C2"] = "=A2*B2"`); openpyxl does not
  compute them — Excel/LibreOffice does on open. If the user needs the computed
  value now, compute it in Python and write the value (and say which you did).
- Charts via `openpyxl.chart`; number/date formats via cell `number_format`.

## Analysis / cleaning with pandas

`read_excel`/`read_csv` → operate → write back. For cleaning: dedupe, fix dtypes
(esp. dates/IDs read as floats), normalize text/encoding, handle missing values
deliberately (don't silently drop rows — report counts). Round-trip column order
and types intentionally.

## Discipline

- Output to a new file unless told otherwise; never overwrite source data
  without confirmation — spreadsheet edits are easy to get subtly wrong and hard
  to undo.
- After writing, reopen and verify row counts / a few known cells; report what
  changed (rows in/out, columns added). `$ARGUMENTS` is the file and/or task.
