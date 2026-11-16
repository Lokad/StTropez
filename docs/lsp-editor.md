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

Caret occurrences use the independent public `createLspHighlightController(workspace, tab, editor,
{ provider, delayMs? })`. Enable `textDocument/documentHighlight` on the shared provider. The
controller requests after a quiet caret interval (150 ms by default), waits for queued input and
composition, and publishes immutable text/read/write ranges. Document, selection, focus and
provider-authority changes clear obsolete results; disposal releases its scope and listeners.
It neither edits text nor changes selection, and leaves initial connection/retry policy to the host.
Hosts subscribe to `state` to invalidate their viewport, then use `intersect(line.from, line.to)`
inside their line decorator. The result uses an interval index, including overlapping ranges,
so visible-row queries skip unrelated occurrences. Host CSS supplies the visual distinction.
`createLspHighlightClient` and `decodeLspDocumentHighlights` expose the same captured protocol
path independently of a browser view. Every response item is validated against raw UTF-16
source; an omitted kind means text, and no occurrence-count cap silently truncates results.
Static and dynamic capability selection, cancellation and reconnect use the shared client rules.

The optional `sttropez/protocol` entry supplies `LspDocumentCapture`, `lspRangeOffsets`,
`decodeLspDiagnostics` and `decodeLspCompletions`. A capture identifies the exact URI/resource/
document/revision, sent buffer/index, wire version, session and capability generation. It is never
an assertion that a provider has completed analysis. Its currentness guard must pass again before
publishing or applying delayed results. Server ranges use exact raw UTF-16 source. Character
positions past a line's end clamp to that end as specified by LSP 3.17; nonexistent lines,
negative/noninteger positions and reversed wire ranges are refused. CRLF is never split by
line-end clamping, and a raw position inside a surrogate pair retains its UTF-16 meaning.

Diagnostics share one decoded batch across views. Versioned pushes must match the current wire
version; a malformed final item preserves the previous valid batch. Unversioned pushes retain
validated wire ranges and may place navigable markers against an explicit current snapshot while
their provider version/origin revision remain unknown. The controls label that uncertainty separately.
An invalid-line range retains its wire range and message with an explicit unplaceable status and
no marker. A local edit, reconnect or URI reuse expires the prior associations rather than relocating
an uncertain analysis. These presentation anchors grant no edit authority. Messages are plain
text; markup, links and commands are never executed. Complete batches use the host's existing
transport limits, without an additional item/message-length quota. Related-information/data
presentation is not advertised. Hosts should page large lists, as the demo Problems panel does.

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

When advertised, the selected item resolves its literal detail/documentation, primary content and additional edits.
Opaque data and inherited defaults are captured immutably. A delayed response must match the
current list, selected item, exact synchronized snapshot and provider generation. It cannot change
the label, filtering/sorting fields, format or opaque identity. The advertised resolve properties are
`detail`, `documentation`, `additionalTextEdits`, `insertText` and `textEdit`. Primary content may
change within the captured insertion/replacement ranges; it cannot retarget another range.
Additional ranges are validated against the snapshot captured for that resolve request.
Malformed/failed resolution dismisses the offer. Enter/Tab and `accept(mode, completionId)` retain
the selected acceptance intent until resolution completes. Selection, typing, blur, cancellation
or stale authority clears that intent; a delayed response cannot apply to another view. `accept`
returns whether the intent was accepted; `apply` remains immediate and returns true only after
an actual edit. A commit character while unresolved follows ordinary input and dismisses the
offer. Ready advertised commit characters
are applied with the completion in one transaction, suppressing duplicate native insertion.
Each published list ID also changes after prefix filtering; retained controls can pass
`completionId` to `chooseCompletion`/`accept`/`apply` to reject an obsolete list or another view's choices.

Numbered snippet stops (`$1`, `${1}`), literal defaults (`${1:name}`), choices
(`${2|draft,ready|}`), escapes, repeated occurrences and final `$0` are supported. Missing `$0`
means the end of the expansion. Forward references use the same default; conflicting explicit
defaults are refused. Variables, nested placeholders and transforms are outside this subset.
Unsupported snippet choices are omitted individually with label/reason in `omittedCompletions`;
ordinary and supported choices remain usable. The pure decoder returns `omitted`, and lazy
decoding reports `UnsupportedLspSnippetError`. Every edit is validated before that disposition,
so malformed or overlapping edits cannot hide behind an unsupported snippet.

The protocol decoder also accepts explicit `insertTextMode: 2` in list defaults or items.
Its `indentation` option captures `tabSize` and `insertSpaces` (defaults: 4 and true).
The primary text and snippet positions remain in the expanded provider coordinates;
`insert`/`replace` plans add the insertion line's indentation to subsequent lines and
use that buffer's LF/CRLF convention. Additional edits remain as supplied. Lazy resolution,
prefix rebasing and commit characters rebuild from the raw text, so indentation is applied
once. Mode 1 preserves the supplied text. The browser advertises both modes and defaults
to mode 2 when neither an item nor its list supplies a mode. Completion captures the
editor's immutable `languageConfiguration()`; a later tab/space setting change expires
the result instead of changing a pending acceptance's formatting.

`lspCompletionPlan(item, mode, commitCharacter?, capturedSelections?)` returns the complete
edit batch and resulting `selectionSet`. With several carets, the primary must match the
item's captured `offset`; all ranges must be collapsed and ordered. Translated replacement
ranges must stay on each caret's line and contain the same text as the primary range.
Overlaps with other carets or additional edits reject the whole plan. Each insertion uses
its own captured line context, shared additional edits apply once, and the complete result
must fit the captured document limit. Applying that batch and selection set through one
Workspace edit makes acceptance one undo unit. Explicit browser requests support several
collapsed carets; automatic requests and prefix-list rebasing still require one caret.
An incompatible secondary range rejects the whole acceptance and consumes the completion
keypress without falling through to ordinary indentation or Enter.

The core snippet planner retains per-occurrence insertion context. `planSnippetEdit` maps
corresponding field bodies across different indentation and LF/CRLF lengths, while ordinary
paste/composition text remains literal. Its optional final `adjustNewlines` argument is for
editor-generated newline indentation; it uses the current local line context. An incompatible
selection/edit batch returns no snippet plan so the editor can apply that user edit normally.
`planSnippetChoice` formats each occurrence, preserves the requested primary occurrence and
checks the aggregate document limit. `snippetChoiceText` supplies the corresponding display
value, including the captured first-line placement when indentation crosses a tab boundary.
The browser passes configured newline intent to the transform, retains the primary caret
group during snippet traversal and choices, and applies the complete selection plan.

Acceptance selects every occurrence of the first numbered field. Typing, deletion, paste and
composition commit mirror through the existing input, Workspace validation and history paths.
Tab/Shift+Tab traverse fields; Alt+Up/Down cycles choices. Hosts render `snapshot.snippet` and use
`moveSnippet`/`chooseSnippet` with its ID to reject retained controls. Escape keeps text and the
primary selection, ending mode. Reaching `$0` ends mode at the final carets. Focus loss, selection
outside the active field, authority changes and external/undo/redo edits end mode. Undo/redo
restore text/selections without recreating a session. Composition remains on the existing adapter;
its native device behavior is unverified. Ready commit-character acceptance inserts the expanded
text plus character without entering a snippet session.

Completion lists have no fixed candidate count or aggregate text/edit quota. Transport size is
controlled by the host's `rpc.maxMessageUnits` (4,194,304 UTF-16 units by default); presentation
limits belong to the host. `completionIncomplete` preserves the provider's partial-list status,
independently of client filtering. The demo keeps at most 16 candidate rows while every matching
candidate remains reachable. Additional edits, insertion text, detail, documentation and opaque
resolve data have no separate count/string-length quota. Overlaps, conflicting insertions,
nonexistent lines and malformed final items refuse the entire result. Snippet support is
advertised for the subset above; expanded insertion length is checked before allocating repeated
defaults against the session's configured `maxDocumentUnits`. Captures from `LspSession` carry
that limit. Callers constructing their own capture for the pure decoder should supply it when
they need an expansion bound; these decoders do not constitute a transport or allocation policy.
Opaque data still passes immutable JSON validation. Commit characters follow LSP's single-unit
rule without silently truncating a provider list. Items requiring a follow-up command are
omitted individually with a label/reason, preserving supported siblings. Their command data
and edits are still validated; malformed commands or overlapping edits reject the batch.
A zero-width additional insertion may sit at a replacement boundary, including an import at
the start of the first completed word. Inserts precede a replacement at that same boundary;
caret and snippet positions follow that batch order for every captured caret. Two insertions
at the same position and intersecting replacement ranges still reject the completion.
Completion acceptance never executes a command, and lazy resolution cannot add one.
Diagnostic locations remain visible through mapped local edits while the provider analyzes
the new source. `diagnosticsPending` distinguishes that presentation from a newly received
batch; `diagnosticRevision` identifies the offsets used by `selectDiagnostic`. The host examples
show a separate pending-analysis status so completion messages cannot hide that distinction.
Deleted diagnostic ranges disappear, and reconnect/close invalidates all retained locations.
Pending diagnostics never supply code-action context; see [diagnostic ownership](lsp.md).

Completion documentation remains literal text;
hover and signature help separately support the focused [documentation subset](documentation.md).

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
stays in host hooks. Hover, signature, link discovery and color fault/delay policy is copied
inside the captured preparation hook
and attached to that request's `_fixture` parameters by `FixtureLspWorkspace`. Cancelling
the scope discards unsent policy; independent view scopes cannot overwrite it. This is a
development-peer extension, not a production LSP requirement. Link resolution accepts policy
on its own request, independently of discovery. Shared language backends contain no fixture
configuration messages; hosts inject preparation when needed. A fixture's fixed module URI
catalogue can be supplied as `initializationOptions.fixtureModuleUris`; discovery requests
may supply their own captured `aliases` in `_fixture`. The packaged consumer uses the fixed
catalogue and the unchanged public clients. Other fixture feature lanes still use
connection-wide configuration and await the same migration.
The [workspace-provider adapter](lsp-server-edits.md) uses that same connection
and a shared exclusive command lane for confirmed action/workspace commands and edit decisions. The
[remaining LSP matrix](lsp.md) describes the selected remaining feature gaps.

Diagnostic injection in this development peer uses `fixture/diagnostics` with `{ uri, mode }`.
Capture the intended document URI explicitly; an absent, unknown or closed URI and an invalid
mode are rejected without publishing diagnostics. Each mode affects only that document,
independently of opening order or focused view. The host fixture's URI policy is shared by
its provider adapter and browser test helpers; production hosts retain their own URI mapping.

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
