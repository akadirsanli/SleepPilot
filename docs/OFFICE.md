# Office tools: Excel, CSV, Word, PowerPoint, PDF, PNG

SleepPilot can read, create, check and compare office files, and it can do this **while an
agent is building an app**. That matters when the app itself works with Excel or PDF: a coding
agent cannot see what is inside an `.xlsx` with its file tool (it is a ZIP of XML), so it
guesses — and "the report looks fine" is a claim, not evidence. With the office tools the agent
looks at the real input data, opens the file its code produced, and SleepPilot verifies the
output before a task counts as done.

| Where | What |
|---|---|
| **Office check** (project → Checks) | Every office file a task created or changed must open cleanly and show no sign of a bug; your expectations (sheets, columns, cell values, pages, headings, planted anomalies found …) must hold. |
| **Developer prompt** | When Scout finds an office library (openpyxl, pandas, exceljs, ClosedXML, EPPlus, POI, iText …) or office files, the developer is told the exact commands to inspect and verify files. |
| **Reviewer** | Changed office files have no diff; the reviewer gets SleepPilot's reading of them (sheets, first rows, column statistics, PDF text, problems). |
| **MCP server** (Settings → MCP → *SleepPilot office tools*) | The same tools as `office_*` MCP tools for Claude Code and Codex. Read-only roles get the reading tools only. |
| **CLI** | `sleeppilot office …` for you, scripts, CI and any agent's shell. |

## Install

`npm install` in the SleepPilot folder. The launchers (`SleepPilot.cmd`, `sleeppilot.sh`,
`npm start`) do this once by themselves. Check with:

```sh
sleeppilot office status
```

The libraries are listed in [THIRD_PARTY.md](../THIRD_PARTY.md) (MIT / BSD / Apache-2.0 /
MPL-2.0). Without them SleepPilot still runs; only the office features say what is missing.
[LibreOffice](https://www.libreoffice.org) is optional: `office convert` uses it for legacy
`.xls/.doc/.ppt` files and for converting any office file to PDF.

## CLI

```sh
sleeppilot office inspect data/sales.xlsx             # sheets, column types/stats, preview, problems
sleeppilot office inspect report.pdf --json
sleeppilot office table data/sales.xlsx --sheet Sales --offset 0 --limit 50
sleeppilot office text report.docx
sleeppilot office create out/report.xlsx --spec spec.json
sleeppilot office create out/report.pdf --markdown report.md
sleeppilot office create out/grafik.png --spec '{"type":"bar","labels":["A","B"],"series":[{"values":[3,5]}]}'
sleeppilot office verify expectations.json            # exit code 1 when something fails
sleeppilot office diff out/report.xlsx expected/report.xlsx
sleeppilot office sample sales --out data/sales.xlsx --rows 5000 --seed 7
sleeppilot office merge out/all.pdf a.pdf b.pdf
sleeppilot office pages report.pdf 1-3 summary.pdf
sleeppilot office convert old.xls                     # → old.xlsx (LibreOffice)
sleeppilot office mcp [--read-only]                   # MCP server on stdio
```

Paths are relative to the current folder, and files are **only written inside it** (or inside
`--root`). Without `npm link`, use `node src/main.mjs office …` or `npm run office -- …`.

### What `inspect` reports

- **Excel / CSV:** every sheet with its size, hidden state, formula count and merged cells; the
  first rows as a table; per column: type (number, date, text, mixed), empty cells, unique
  values, min/max/sum/mean, date range, most frequent values; duplicate rows. CSV encoding
  (UTF-8, UTF-8 with BOM, UTF-16, legacy code pages such as **Windows-1254**) and delimiter (`;` `,` TAB `|`) are detected.
  English and European number formats (`1,234.56`, `1.234,56`, `12.5%`, `250 EUR`) and `dd.mm.yyyy` dates are understood.
- **Word:** outline of headings, paragraph/table/image counts, the first table, the text.
- **PDF:** pages, text per page (lines rebuilt from glyph positions), metadata, whether it is
  password protected or **scanned** (images without a text layer — those need OCR).
- **PowerPoint:** slide titles and texts, notes, tables and images per slide.
- **Images:** type and size; for PNG also colours and whether it is blank.

**Problems** are the usual signs of a bug in generated output: Excel formula errors (`#REF!`,
`#DIV/0!`, `#VALUE!` …), cells reading `NaN`, `undefined`, `[object Object]`, `Invalid Date`,
`Infinity`, an empty workbook or document, a scanned PDF where text was expected.

## Creating files

The extension picks the format.

**Excel / CSV** — a workbook spec:

```json
{
  "properties": { "title": "Store Summary" },
  "sheets": [
    {
      "name": "Summary",
      "columns": [
        { "header": "Store" },
        { "header": "Date", "format": "date" },
        { "header": "Amount", "format": "money", "width": 16 }
      ],
      "rows": [["Downtown", "2025-03-01", 1250.5], ["Harbor", "01.04.2025", "2.500,75"]],
      "totals": { "label": "Total", "columns": ["Amount"] },
      "images": [{ "chart": { "type": "bar", "labels": ["Downtown", "Harbor"], "series": [{ "values": [1250.5, 2500.75] }] }, "range": "E2:L18" }]
    }
  ]
}
```

Formats: `text`, `integer`, `number`, `money`, `try` (Turkish lira), `percent`, `date`, `datetime`, or any
Excel format code. Header row is bold, frozen and filterable; widths fit the content. A cell can
be a value, `"=SUM(C2:C9)"`, `{ "formula": … }`, `{ "date": "2025-01-31" }`,
`{ "link": "https://…", "text": "…" }` or `{ "value": …, "format": …, "bold": true, "fill": "FFEEEE" }`.
Rows may also be objects keyed by header. `.csv` writes the first sheet with `,` and a UTF-8 BOM
(so Excel reads UTF-8 correctly); `"delimiter": ";"` suits locales whose Excel expects it, and
`"encoding": "windows-1252"` (or another code page) writes a legacy file.

**Word / PDF / PowerPoint** — Markdown, or a document spec:

```json
{
  "title": "Sales Report",
  "subtitle": "Store sales — 2025",
  "classification": "INTERNAL",
  "footer": "Sales Analysis",
  "landscape": false,
  "blocks": [
    { "type": "kv", "items": [["Store", "Downtown"], ["Period", "2025"]] },
    { "type": "heading", "text": "Findings", "level": 1 },
    { "type": "callout", "tone": "risk", "title": "Warning", "text": "Refunds split below the approval threshold." },
    { "type": "table", "header": ["Receipt No", "Amount"], "rows": [["RCP0000012", 4950]] },
    { "type": "chart", "chart": { "type": "pie", "labels": ["A", "B"], "series": [{ "values": [3, 5] }] } },
    { "type": "bullets", "items": ["One", "Two"] },
    { "type": "pagebreak" }
  ]
}
```

Markdown supports `#`–`###`, paragraphs with `**bold**`/`*italic*`, `-` and `1.` lists, tables,
`> [!WARNING]` callouts (NOTE, TIP, WARNING, CAUTION, RISK), `![caption](image.png)`,
`\pagebreak`, and a fenced `chart` block with a chart spec. PDFs get page numbers, the
classification label in the header and Roboto (accented and non-English Latin letters included); tables repeat their
header on every page. In PowerPoint every `#`/`##` heading starts a slide.

**Charts** (`.png`, `.svg`, or inside Excel/Word/PDF/PowerPoint):
`{ "type": "bar | line | area | pie | doughnut | scatter", "title", "labels": [...],
"series": [{ "name", "values": [...] }], "horizontal", "stacked", "showValues", "width", "height" }`,
or `{ "echarts": { … } }` with any Apache ECharts option.

## Expectations (the office check and `office verify`)

```json
[
  { "file": "out/report.xlsx",
    "sheets": ["Summary", "Findings"],
    "sheet": "Findings", "columns": ["Receipt No", "Reason"], "minRows": 1,
    "cells": { "Summary!B2": { "approx": 19839428.53, "tolerance": 0.01 }, "Summary!A1": { "contains": "Total" } },
    "noErrors": true,
    "notContains": ["undefined", "NaN"] },
  { "file": "out/report.pdf", "pages": { "min": 2 }, "headings": ["Findings", "Conclusion"], "contains": ["Downtown"] },
  { "file": "out/report.docx", "headings": ["Findings"], "minTables": 1 },
  { "file": "out/grafik.png", "minWidth": 800, "notBlank": true },
  { "file": "out/summary.xlsx", "sameAs": "expected/summary.xlsx", "tolerance": 0.005 },
  { "file": "out/findings.xlsx", "findsAll": { "key": "data/sales.key.json", "minRecall": 1, "maxFalsePositives": 0 } }
]
```

| Key | Meaning |
|---|---|
| `file` | Required, relative to the project |
| `minBytes` | Minimum size |
| `sheets` | Sheets that must exist (case-insensitive) |
| `sheet` | Sheet for `minRows`, `maxRows`, `columns` and unqualified `cells` (default: first) |
| `minRows` / `maxRows` | Data rows, header excluded |
| `columns` | Header names that must exist |
| `cells` | `"A1"` or `"Sheet!A1"` → value, or `{ equals, approx, tolerance, contains, min, max, nonEmpty, formula }` |
| `noErrors` | No `#REF!`, `#DIV/0!`, `#VALUE!` … cells |
| `contains` / `notContains` | Text that must / must not occur (any kind of file) |
| `pages` | PDF page count: a number or `{ min, max }` |
| `headings` | Word headings (PDF: searched in the text) |
| `minTables` | Word tables |
| `slides` | PowerPoint slide count |
| `width`, `height`, `minWidth`, `minHeight`, `notBlank` | Images |
| `sameAs`, `tolerance` | Same content as a reference file (cells within tolerance, or text lines, or pixels) |
| `findsAll` | The planted anomalies of a sample data set appear in the output (see below) |

Every file the task changed is also opened and checked for the problems listed above, even with
no expectation. The check is added automatically the first time a task produces an Excel, CSV,
Word, PowerPoint or PDF file, and at the start of a run when Scout sees an office project. A
one-colour PNG is only a failure when `notBlank` is asked for (tiles and backgrounds are often
one colour).

Note: formulas written by a library have no stored result until Excel recalculates them, so a
formula error can only be detected when the file was saved by Excel or LibreOffice, or when the
writer stored the result.

## Synthetic test data with an answer key

Real personal or company data should not go into a development loop. `office sample` writes fully fictitious
but realistic data with **planted anomalies** and an **answer key**:

| Template | Data | Planted anomalies |
|---|---|---|
| `sales` | Store and online sales + a staff sheet | duplicate receipt, store sale outside opening hours (10:00–22:00), several refunds to one customer on one day just below a 5.000 TL approval threshold, round refunds, staff selling to their own loyalty card, card sale far above the customer's usual amount, missing customer/card number, negative amount |
| `expenses` | Expense claims + per-type limits | duplicate invoice, self-approval, weekend expense, over the limit, split invoice (each part below the limit, together above), round hospitality amounts |
| `invoices` | Customer invoices + product-group terms | discount over the group maximum, payment term over the maximum, amount over the limit, wrong collection status (>90 days not "At Risk", 30–90 days "Current"), required approval missing, weekend invoice |

```sh
sleeppilot office sample sales --out data/sales.xlsx --rows 5000 --seed 7
#   data/sales.xlsx        the data
#   data/sales.rules.md    the rules in plain English (give these to the app / the objective)
#   data/sales.key.json    the answer key: which records are anomalies, and why
```

The same seed always gives the same file. `--rate` sets the share of anomalies (default 3%),
`--encoding windows-1252` (or another code page) writes a CSV in a legacy code page (to test the app's encoding
handling). Ordinary records never match a rule by accident: an app that implements the rules
exactly finds every planted record and nothing else (this is tested for every template over many
seeds).

Then the check measures the app:

```json
{ "file": "out/findings.xlsx", "findsAll": { "key": "data/sales.key.json", "column": "Receipt No", "minRecall": 1, "maxFalsePositives": 0, "types": ["split_refund", "duplicate_receipt"] } }
```

It reports the recall, the missed anomalies by type and their ids, and records flagged that are
not anomalies. The first copy of a duplicate counts as related, not as a false positive.

**Keep the key away from the app.** The app under test must not read `*.key.json`; the developer
prompt says so. For an overnight run, put the key outside the project folder (`--key
C:\keys\sales.key.json`, referenced in the expectation with an absolute path) or add it to the
project's protected paths.

## MCP tools

| Tool | Writes | Purpose |
|---|---|---|
| `office_inspect` | | Describe a file (see above) |
| `office_read_table` | | Rows of a sheet/CSV as JSON, paged |
| `office_text` | | Plain text of docx/pdf/pptx/xlsx/csv |
| `office_verify` | | Check expectations |
| `office_diff` | | Compare two files |
| `office_create` | ✓ | Create xlsx/csv/docx/pdf/pptx/png/svg |
| `office_sample` | ✓ | Synthetic data + answer key |
| `office_pdf_merge`, `office_pdf_pages` | ✓ | Merge PDFs, copy pages |

Settings → MCP → **+ SleepPilot office tools** adds the server for Claude Code and Codex (they
start it in the project folder, which is where it may write). With "All roles", the manager and
the reviewer get the five reading tools only. OpenCode runs one shared server for every project,
so there the developer uses the `sleeppilot office` command (the developer prompt gives the exact
command line).

## Privacy

Everything runs locally; no file is uploaded anywhere by these tools. What reaches a cloud model
is what the agent reads — for real data, prefer the synthetic samples, or a local model
(Settings → Local AI) for runs on sensitive files.
