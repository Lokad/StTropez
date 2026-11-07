# Bounded editing candidate

`mountEditingCandidate(host, workspace, tabId, { view?, ariaLabel? })` is an experimental view
over the shared document/history contract. It owns its viewport, bounded native textarea and
caret beneath the supplied host. The existing whole-value `mountTextEditor` remains a control.
The candidate is exported explicitly; native-device IME and assistive-technology feasibility
have not selected a production input strategy.
The project had no bounded context/coordinate adapter to reuse. This small original adapter
uses platform text ranges and segmentation; embedding an external editing runtime would conflict
with the zero-dependency distribution requirement. No reference implementation is imported.

The native context contains up to 256 UTF-16 units around either side of a selection and up to
2,048 selected units. Larger selections become one selected placeholder, with reversible maps
to the real range. The adapter normalizes only that context to native LF coordinates and maps
edits back to raw model offsets. It diffs bounded context values and submits one revision-checked
transaction with the resulting model selection. Inserted text can exceed the context limit
during a native event; context is rebuilt after the commit. Ordinary typing, navigation,
scrolling and metadata changes never export the full buffer. Explicit copying may read a large
selected range; paste and indentation still have costs proportional to their changed content.

`focus`, `captureView`, `restoreView`, `view`, `viewport` and `destroy` support explicit host
lifecycle. Supplied views stay host-owned; otherwise destruction releases the retained view.
Two candidates share document history while keeping their selection, scroll and focus separate.
Each mount captures tab generation and document identity. Composition retains its original
context/revision until completion. Stale edits, capability changes and expired targets reject
the attempt and emit `sttropez-conflict` with the attempted text/context range for host recovery.
Hosts must treat this content-bearing event as recovery data, rather than default telemetry.
Destroying either text adapter during changed, uncommitted composition also emits
`composition-detached` before removing its DOM. Hosts keep their conflict listener installed
through editor destruction, then remove it. This preserves the attempted context without
committing unconfirmed preedit to the document.
The ordinary development snapshot reports conflict reasons and lengths only.

Implemented commands include single-selection typing/replacement, grapheme left/right and
deletion, code-word movement/deletion, measured line/page movement, line/document start/end, line indentation/outdent, basic
bracket pairing/skipping, clipboard events and shared undo/redo. Typing and adjacent deletion
group per mount/view; clipboard, composition and structural commands have separate history
boundaries. Large indentation plans yield every 256 lines against a captured immutable buffer
and reject changes to the revision, selection or tab target before applying one transaction.
The final transaction is still proportional to the number of changed lines.

Ordinary text and line-break input capture the native replacement range, document revision
and model selection in `beforeinput`. The following `input` uses that range only when the
actual value and collapsed caret agree with it. Repeated neighboring text therefore cannot
shift an insertion past the caret, split a continuous undo group or mis-map another view.
Typing the same text over a selection still collapses that selection without changing the
document revision. Intervening revision/selection changes reject the captured input and emit
recovery data. Composition and unrecognized browser rewrites retain their existing value-diff
path. The native baseline shares these target checks; its whole-value projection remains
unbounded. These automated scenarios do not qualify real native devices.
Projection-driven native selection events also preserve the model's existing affinities when
the endpoints already match. Such an event does not seal another view's continuous typing
group; a real selection change still establishes a history boundary.

Control+Left/Right moves to code-word starts; Shift retains the anchor. Control+Backspace/Delete
deletes the selected range, or one code word when collapsed, as one undoable transaction.
On Apple platforms Option supplies the word modifier. Non-shift movement starts at the active
head, including backward selections. `WordCursor` scans the immutable buffer in either direction,
classifying Unicode letters/numbers/connectors as words, other symbols as symbol runs, and
whitespace separately. Marks and join controls stay with the preceding base. Forward movement
consumes the current run and following whitespace; backward movement skips preceding whitespace
and consumes the preceding run. This is a code-oriented policy, not dictionary segmentation or
a claim of Unicode word-boundary conformance. The browser still snaps destinations to graphemes.

The headless cursor retains bounded 256-unit slices, handles surrogate seams and exposes
`next(maxWork)` plus explicit disposal. Equal-class ASCII runs share one unit within each
slice; Unicode marks/joiners and other code points retain their existing classification.
This reduces per-character allocation without changing code-word endpoints or work bounds.
Browser commands advance at most 32 4,096-unit scans
per timer turn, stopping sooner after four milliseconds of elapsed scan time. A single advance, GC and
the final model transaction can exceed that scheduling threshold. Revision, selection identity
and tab generation are checked before every turn. Typing, another navigation command,
composition or disposal cancels pending scans. The final edit also rechecks current capability.
Non-cancellable native word deletion requires a matching captured `beforeinput` target; stale,
unmatched or capability-blocked attempts emit recovery rather than applying a bounded-context deletion to the model.

Up/Down and PageUp/PageDown retain the measured horizontal column across shorter rows. A page
advances `max(1, floor(viewportHeight / lineHeight) - 1)` logical lines; Shift extends from the
existing anchor. The preferred column resets after edits, other navigation, external selection
changes or measured column-width changes. Nearest reveal keeps an already visible caret in
place. Raw CRLF offsets and independently scrolled views remain separate from native LF context.

Tab inserts indentation. Escape followed by Tab returns to the host's normal focus order.
Pointer selection uses rendered native rectangles; drag anchors expire across document changes.
Only the captured pointer can end its drag. Losing capture, cancellation, releasing the primary
button or disposing the mount stops selection updates and releases any remaining capture.
Returning to the editor after a release outside it leaves the retained caret unchanged; subsequent
typing inserts there. Unrelated pointer cancellation does not terminate the owned gesture.
The native textarea and preedit overlay sit near the measured caret. This is an input-positioning
experiment, with no qualified screen-reader document representation or native-device claim.

`bench:host-pointer` checks the pointer-to-typing handoff in both hosts on Unicode/CRLF and
100,000-line sources, with three warmups and ten samples per capture-loss or synthetic-cancel
condition. Actual capture activation, release outside, inert hover, independent selections,
point typing, saved-reference versions, shared undo/redo and disposal remain asserted. The
report separates elapsed typing-handler duration, full point-input review readiness, complete
point automation and whole gesture/workflow clocks. Initial save/reference setup is excluded;
its explicit save export is counted separately. The gesture adds no exports and the edited
buffer retains zero ordinary exports.
Whole gestures have no point-action budget; synthetic cancellation does not qualify native
devices. Raw samples and font-family/size/line-height fields remain separate from physical
display latency and installed-font identity.

Complete rows support [visual bidi navigation and dual affinities](bidi.md). Current limits include
long contextual-line geometry/navigation, wrapping,
drag autoscroll, touch/mobile selection, native undo/menu behavior, OS clipboard, accessibility,
and additional platform modifier bindings. [Literal search/replace](search.md) and the host-owned
[provider/highlighting fixture](providers.md) now exercise the view. [Grapheme navigation](graphemes.md) first attempts an exact local ASCII boundary query; uncertain context cooperatively indexes the full captured logical line using Unicode 18 facts. A one-line cache uses immutable buffer identity and range; long clusters and RI parity retain full context. Delayed commands check captured revision, selection, tab generation, composition, permission and disposal. Complete-row visual movement still requires measured geometry.
The textarea's value is an internal context, so setting it is not a full-document edit API.
Hosts use revision-checked model edits for that operation.

`/editing/` mounts two candidates. Browser scenarios exercise actual typing in 100,000 lines,
whole-document replacement without export, Unicode pointer/deletion, independent view selection,
focus escape, yielding indentation and stale commands, bracket commands, synthetic clipboard and
composition races, and disposal. A Chromium-only protocol test exercises browser composition;
it does not replace native-device checks on any engine. The restored NuGet consumer also types
and undoes through the compiled candidate and packaged CSS without checkout inputs.

`npm run bench:editing` records actual keyboard insertions at start/middle/end of six pinned
corpora, with three warmups and twenty measured inputs per condition. Guards require one native
input and one model commit per sample, exact text/range/length, zero whole-text exports, bounded
input/DOM work and no whole-value fallback. Input-handler timing includes the model transaction
and context refresh, excluding native work before the event and later rendering. The separate
beforeinput-to-frame-ready value is a scheduling proxy, not physical presentation latency.
Raw samples, source identity and display/environment data stay in ignored `artifacts/bench/editing/`.
This development diagnostic is not an alternating production comparison or adoption budget.

`npm run bench:navigation` records stepped word/whitespace scans in both directions, plus actual
word movement/deletion and page keys in large and Unicode/CRLF documents. It retains three
warmups, twenty measured kernel scans and ten measured browser commands per condition.
Assertions cover exact model destinations/text/revisions, bounded native context and zero exports.
Snapshots expose `pendingWord`, `wordScanSteps` and `maxWordScanStepMs` for the last word scan;
scan CPU excludes final boundary normalization, model commit and rendering. The separate
key-to-frame-ready value includes scheduling/polling and both views, and measures no physical
input or presentation. Raw samples and provenance stay in ignored `artifacts/bench/navigation/`.
