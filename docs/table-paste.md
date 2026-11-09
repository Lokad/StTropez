# Captured table paste

The candidate evaluation hosts offer **Paste tables as CSV**. It starts off; ordinary paste
keeps its literal `text/plain` behavior. When enabled, the host converts one HTML table, or
tab-separated plain text when HTML contains no table, and replaces every captured selection
with the same quoted CSV. Copy/cut and the default literal route remain separate commands.
The library supplies the captured document transaction and shared history; table interpretation
and controls belong to the host. No service, runtime dependency or language-specific parser is
added to the editor package.

Clipboard event capture copies strings before returning. It captures the resource, tab generation,
mounted view, document revision, complete selection set and fold generation. Conversion yields
between bounded token batches, shows an indeterminate progress indicator, and keeps text editable.
Escape in the captured source or **Cancel table paste** cancels. A new paste supersedes the old
intent. Text/selection/fold changes, composition, detach, replaced tabs and loss of edit authority
expire that capture; temporary permission/lease loss cannot revive it after authority returns.
Moving focus to the host form alone does not retarget the command or take focus back.

Only a complete validated result reaches `planSelectionEdits` and one human `paste` transaction.
Shared undo/redo restores the complete selection set. No-op/empty clipboard input creates no
history unit; unsupported empty/nontext literal payloads cannot delete selected source text.
Save and Run still capture the working resource, while the review reference remains immutable.
Ordinary conversion uses indexed ranges and never exports the entire source value. Detached
views dispose pending work and subscriptions. The host policy survives remount on its stable
controller; no React effect synchronizes editor state.

All CSV cells are quoted, internal quotes are doubled, and record separators are CRLF. TSV
accepts quoted multiline cells and escaped quotes; raw cell contents, including Unicode, tabs,
CRLF and spaces, are preserved. Rows must have equal widths. HTML uses the browser's detached
inert template parser; nodes are never inserted into the editor or host document. Text, character
references, `<br>` and basic paragraph boundaries become cell values. Script/style/template and
embedded-document content is omitted. Merged cells keep text at the upper-left anchor and use
empty covered slots; row spans remain within captured row groups. Nested/multiple tables,
overlapping spans and ragged rows fail visibly without partial edits. This is text-table conversion,
not a rendering/CSS or arbitrary rich-document import contract.

The host reuses the native HTML parser rather than introducing an HTML dependency, and uses a
small cooperative TypeScript TSV/CSV formatter because runtime dependencies are excluded.
Clipboard strings are limited to 1 Mi UTF-16 units of plain text and 256 Ki of HTML, with at most
10,000 rows, 1,024 columns and 100,000 cells. Aggregate inserted text across all selections is
limited to 4 Mi units and the resulting source to 32 Mi units. Format/limit failures leave the
operation unapplied; literal paste remains available by clearing the option. Native clipboard
string retrieval, the size-limited native HTML parse, final string assembly and atomic model
commit remain synchronous. Cooperative token batches do not imply a bounded native parser
or model-commit time.

Instrumentation keeps the host's clipboard capture-handler span separate from complete event
dispatch, whole scheduled conversion callbacks, atomic commit, conversion-to-commit wall time,
all-view review readiness and complete automation actions/workflows. Capture-handler time excludes
later candidate cleanup, parsing and rendering; conversion-to-commit is not interaction readiness.
No CPU-time or physical-display latency follows from these clocks.

Automated ClipboardEvent scenarios and guarded process-local Chromium keyboard clipboard checks
are distinct evidence. Native OS/application/browser-menu clipboard, IME and assistive technology
remain unverified. Domain annotations/import commands and the rest of H01 remain required.
