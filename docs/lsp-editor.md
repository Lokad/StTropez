# LSP editing pilot

The plain and React development hosts accept `?editor=candidate&language=lsp` to select the generic
WebSocket provider. Their default local worker remains a separate fixture. The LSP route opens a
real session using the pinned 3.17.5 reference peer; it never falls back to that worker. Both hosts
reuse the same provider controls, captured view ownership, Workspace transactions and history.
Their generic controller is the exported `createLspEditor`; the
[public integration guide](lsp-integration.md) covers its lifetime and independent consumers.
Hover, definition/reference navigation, [rename/edit previews](lsp-rename.md) and
[code-action discovery/resolve](lsp-code-actions.md), [signature help, links and colors](lsp-language.md)
also use LSP in this route. Local tokenization and domain tools retain their independent fixtures.
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

Completion follows ordinary prefix typing and advertised trigger characters after input settles.
Ctrl/Cmd+Space and the existing button retain explicit invocation. A single captured caret is
required; composition suppresses requests until commit. Hosts can set `automatic: false`.
Lists, arrays, empty results and the declared 3.17 edit-range/data/commit-character defaults are handled.
All choices are validated before display; arrows select, Enter replaces, Tab inserts and Escape
dismisses. Insert/Replace buttons and Alt+Enter remain available.
Plain text edits, insert/replace ranges and additional same-document edits become one Workspace
transaction and one shared undo command. The resulting caret includes additional edits before the
primary edit. Other views retain their mapped selections and can undo/redo the command. When the
server omits an edit range, the host uses a bounded Unicode word window; explicit server ranges do
not depend on that heuristic. Choices sort by `sortText` (stable server order for equal keys),
filter by a case-insensitive `filterText` prefix and honor `preselect` when the previous selection
is unavailable. Explicit invocation initially shows all choices, including spelling corrections.
Hosts can opt into `filterManualCompletions: true` to apply the same bounded, item-edit-range
prefix filter to explicit requests. The TypeScript demo uses this policy so requesting at an
existing member prefix immediately shows matching choices; spelling fixes use its quick-fix UI.

A list follows only an exact single human typing insertion inside its primary insert range.
Core's change metadata must prove that insertion; document/buffer identity, selections, fold
generation, authority, URI and provider binding must still match. Primary/additional ranges are
mapped and validated again; undo, host edits, replacements, unknown/composed mappings, navigation
or capability changes expire the list. Incomplete lists retrigger with context kind 3. The latest
compatible choices remain visible during refresh. One animation-frame scheduler and existing
request generations/cancellation bound work; there is no completion cache or background queue.

When advertised, the selected item resolves its literal detail/documentation and additional edits.
Opaque data and inherited defaults are captured immutably. A delayed response must match the
current list, selected item, exact synchronized snapshot and provider generation. It cannot change
the label, primary edit or opaque identity. Additional ranges are validated against the snapshot
captured for that resolve request. Malformed/failed resolution dismisses the offer. Unresolved
choices cannot apply; Enter/Tab or a commit character pressed before resolution completes dismiss
the offer and follow ordinary input, preserving the keystroke. Ready advertised commit characters
are applied with the completion in one transaction, suppressing duplicate native insertion.
Each published list ID also changes after prefix filtering; retained controls can pass
`completionId` to `chooseCompletion`/`apply` to reject an obsolete list or another view's choices.

Completion lists have no fixed candidate count or aggregate text/edit quota. Transport size is
controlled by the host's `rpc.maxMessageUnits` (4,194,304 UTF-16 units by default); presentation
limits belong to the host. `completionIncomplete` preserves the provider's partial-list status,
independently of client filtering. The demo keeps at most 16 candidate rows while every matching
candidate remains reachable. Per-item bounds remain 32 additional edits and 16,384 units per
insertion. Overlaps, conflicting insertions,
out-of-document positions and malformed final items refuse the entire result. Snippets, indentation
adjustment and follow-up commands are not advertised and are explicitly refused if supplied.
Resolve payloads are bounded to 32,768 units/item and 8,192 opaque data units/item;
commit-character lists allow at most 64 entries. Snippet expansion and rich
Markdown rendering remain unsupported; documentation is literal text.

Pending typing/navigation/table conversion, composition, multiple carets, source revision, selection
set, fold generation, tab/view ownership and resource authority are checked before capture and
again before application. A queued caret paint is presentation work and does not invalidate an
otherwise current capture. Incompatible source edits, selection/authority changes, cancellation, disconnect and
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
[remaining LSP matrix](lsp.md) describes the selected remaining feature gaps.
Native IME/clipboard and physical-display checks
remain unverified; all browser qualification stays headless on the shared desktop.

Large-document correctness journeys type and complete at the beginning, middle and end of a
100,000-line source, with bounded native input and no ordinary text export. Their three recorded
handler/action samples are diagnostics, not latency-tail measurements. Candidate beforeinput
duration excludes the separately measured completion capture listener; its input-handler duration
includes synchronous Core observers. Completion keydown duration is also reported separately.
The complete automation action includes IPC/assertion polling and rendering; these clocks neither
establishes physical display or native-device latency. Existing source-labelled latency baselines
remain the performance qualification; no historical outlier is replayed by this work.
