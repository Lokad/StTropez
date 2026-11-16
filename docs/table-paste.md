# Table conversion example

The plain and React development hosts expose **Paste tables as CSV**. The main demo's
**Host integrations · paste & notes** sample exposes the same converter through
**Code → Paste format** and **Insert example table**. Conversion is off by default;
ordinary paste uses literal plain text. The example uses the public
[captured insertion contract](host-integration.md#captured-insertion-and-structured-paste).

## Workflow

Enable conversion, then paste one HTML table or tab-separated text. When HTML contains no
table, the converter uses the plain-text format. It inserts the same quoted CSV at every
captured selection. Copy/cut and literal paste have independent routes. The example-table
button exercises conversion without reading the OS clipboard.

Conversion yields between token batches and displays progress. **Cancel table paste**, Escape
in the source, or a superseding paste cancels it. Editing is available; an expired capture
cannot apply a delayed result. Focus can move to host forms without changing the target.
Detach cancels view-owned work; the stable host controller retains the selected paste policy.

## Formats and limits

All CSV cells are quoted, internal quotes doubled, and record separators CRLF. TSV accepts
quoted multiline cells and escaped quotes while preserving raw cell text. Rows have equal widths.

HTML is parsed in a detached inert template. Text, character references, line breaks and basic
paragraph boundaries become cell values. Script/style/template and embedded-document content
are omitted. Merged cells put text at the upper-left anchor with empty covered slots; row spans
stay within their row group. Nested/multiple tables, overlapping spans and ragged rows fail
without partial insertion. Parsed nodes are never mounted into the host or editor.

| Fixture limit | Maximum |
| --- | --- |
| Plain clipboard text | 1,048,576 UTF-16 units |
| HTML clipboard text | 262,144 UTF-16 units |
| Rows / columns / cells | 10,000 / 1,024 / 100,000 |
| Inserted text across selections | 4,194,304 UTF-16 units |
| Resulting source | 33,554,432 UTF-16 units |

These limits and format choices belong to the example, not the editor package. The formatter
uses native HTML parsing and cooperative TypeScript conversion. Clearing the option restores
literal paste. See the [support matrix](README.md#support-matrix) for import and clipboard boundaries.
