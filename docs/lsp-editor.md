# LSP editing pilot

The plain and React development hosts accept `?editor=candidate&language=lsp` to select the generic
WebSocket provider. Their default local worker remains a separate fixture. The LSP route opens a
real session using the pinned 3.17.5 reference peer; it never falls back to that worker. Both hosts
reuse the same provider controls, captured view ownership, Workspace transactions and history.
Hover, definition/reference navigation, [rename/edit previews](lsp-rename.md) and
[code-action discovery/resolve](lsp-code-actions.md) also use LSP in this route. Other language
tools retain their separately declared worker fixtures until their LSP adapters are delivered.
The fixture recognizes simple words and TODO markers; it establishes protocol/host behavior, not
general language semantics. There is no production service or provider prerequisite.

The optional `sttropez/protocol` entry supplies `LspDocumentCapture`, `lspRangeOffsets`,
`decodeLspDiagnostics` and `decodeLspCompletions`. A capture identifies the exact URI/resource/
document/revision, sent buffer/index, wire version, session and capability generation. It is never
an assertion that a provider has completed analysis. Its currentness guard must pass again before
publishing or applying delayed results. Server ranges are checked against exact raw UTF-16 source;
invalid lines/characters are refused instead of silently clamped.

Diagnostics share one decoded batch across views. Versioned pushes must match the current wire
version; a malformed final item preserves the previous valid batch. Unversioned pushes retain
validated wire ranges and may place navigable markers against an explicit current snapshot while
their provider version/origin revision remain unknown. The controls label that uncertainty separately.
An out-of-bounds range retains its wire range and message with an explicit unplaceable status and
no marker. A local edit, reconnect or URI reuse expires the prior associations rather than relocating
an uncertain analysis. These presentation anchors grant no edit authority. Messages are plain
text; markup, links and commands are never executed. The bound is 256 items/65,536 text units per
batch, with 4,096 units per message. Related-information/data presentation is not advertised.

Completion is explicitly requested with Ctrl/Cmd+Space or the existing button. A single captured
caret is required. Lists, arrays, empty results and the declared 3.17 edit-range defaults are handled.
All choices are validated before display; choose an item and use Insert or Replace (Alt+Enter).
Plain text edits, insert/replace ranges and additional same-document edits become one Workspace
transaction and one shared undo command. The resulting caret includes additional edits before the
primary edit. Other views retain their mapped selections and can undo/redo the command. When the
server omits an edit range, the host uses a bounded Unicode word window; explicit server ranges do
not depend on that heuristic. Lists are shown in server order; further typing expires them, including
incomplete lists, and requires a fresh request.

The completion bounds are 256 choices, 1,024 total edits, 32 additional edits per item, 16,384 units
per insertion and 65,536 aggregate label/detail/insertion units. Overlaps, conflicting insertions,
out-of-document positions and malformed final items refuse the entire result. Snippets, indentation
adjustment and follow-up commands are not advertised and are explicitly refused if supplied.
Automatic trigger/commit characters, local list filtering, resolve, snippets and rich documentation
remain unimplemented. They are not implied by basic manual completion interoperability.

Pending typing/navigation/table conversion, composition, multiple carets, source revision, selection
set, fold generation, tab/view ownership and resource authority are checked before capture and
again before application. A queued caret paint is presentation work and does not invalidate an
otherwise current capture. Source edits, selection/authority changes, cancellation, disconnect and
unmount expire pending offers. Cleanup releases listeners, session work and retained request leases;
lease release follows Workspace notification delivery. Initial/incremental planning stops at the next
cooperative boundary when its captured local snapshot changes. Reusing a URI during planning restarts
close/open ownership cleanup. Delayed replies neither retarget focus nor edit an unavailable view.
The comparison reference exposes no completion provider. Working edits
keep Save/Run on their captured resource; later typing survives an earlier Save receipt.

Both hosts own one exported `LspWorkspace` per workspace/provider configuration, connecting on
explicit view activation. Feature/view scopes share bindings, synchronization and diagnostics;
disposing one view cannot close another's document or transport. Custom fixture configuration
stays in host hooks. The [workspace-provider adapter](lsp-server-edits.md) uses that same connection
and a shared exclusive command lane for confirmed action/workspace commands and edit decisions. The
[remaining LSP matrix](lsp.md) includes advanced completion and other declared subset gaps.
Native IME/clipboard and physical-display checks
remain unverified; all browser qualification stays headless on the shared desktop.

Large-document correctness journeys type and complete at the beginning, middle and end of a
100,000-line source, with bounded native input and no ordinary text export. Their three recorded
handler/action samples are diagnostics, not latency-tail measurements. Own beforeinput duration
and the complete automation action (including IPC/assertion polling) are different clocks; neither
establishes physical display or native-device latency. Existing source-labelled latency baselines
remain the performance qualification; no historical outlier is replayed by this work.
