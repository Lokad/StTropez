# Bounded editing candidate

`mountEditingCandidate(host, workspace, tabId, { view?, ariaLabel?, readOnly? })` is an experimental view
over the shared document/history contract. It owns its viewport, bounded native textarea and
caret beneath the supplied host. The existing whole-value `mountTextEditor` remains a control.
The candidate is exported explicitly; native-device IME qualification remains open.
No production input strategy has been selected.
The project had no bounded context/coordinate adapter to reuse. This small original adapter
uses platform text ranges and segmentation; embedding an external editing runtime would conflict
with the zero-dependency distribution requirement. No reference implementation is imported.

Hosts can intercept clipboard events on the public input in the capture phase and cancel them
with `preventDefault()`. The candidate then leaves clipboard data and source mutation to the
host, cancels queued navigation/grouping work, and stops a delegated cut/paste drag. Empty or
unsupported nontext literal paste is a no-op, including when source text is selected. The
[table-paste host](table-paste.md) exercises a captured conversion through this boundary.

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
`readOnly: true` is captured for that mount. It keeps navigation, selection, copying and Find
available while refusing input, paste/cut/drop, history and Find replacements through that view.
Dragging from it offers copying only. Resource permissions, host transactions and other editable
views remain independent; remount with the retained view to change this presentation policy.
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
Starting composition cancels queued command timers, including pending indentation. Cancelling
composition does not revive that command even when the revision and selection stay unchanged.
Staged input can then commit as one composition transaction. The automated race checks do not
qualify native IME behavior. The final transaction is still proportional to changed lines.

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

Keyboard movement/deletion and multiline indentation that yield retain subsequent text and
recognized editing/navigation keys in order. Cancellable `beforeinput` supplies the text without
mutating the native context; non-cancellable and input-only insertions reuse the captured native
replacement checks. The completed command supplies the destination selection set. Adjacent text
keeps its event-time history grouping, and queued undo/redo, brackets and indentation keep their
normal command boundaries. Short horizontal/end-point commands and at most two short-row vertical
carets can still finish synchronously; larger vertical/page sets cooperate between batches.

Pending input belongs to the captured document revision, immutable selection set, view and tab
generation. Escape, changed authority/selection/revision, composition, copy/cut, host-owned paste and
detachment cancel that continuation. Exact unapplied text is emitted through `sttropez-conflict`
with its captured revision and `contextFrom: 0`; this payload is text to recover, not a replacement
context or an instruction to apply it at offset zero. No automatic retargeting occurs. The queue
allows at most 256 actions and 65,536 UTF-16 units; overflow is recovered intact. The evaluation
hosts retain recovery content and require Save, Run and new proposal requests to be retried after
pending input settles, so those commands never capture a source before accepted typing lands.
Yielding double-click word selection uses the same ordered capture. Typing replaces its completed
word range, and undo restores that exact range; cancellation retains unapplied text. Native IME
and clipboard device qualification remain open.

Literal paste reads plain text during its clipboard event and joins pending ordered input.
It uses the completed destination set, preserves raw CRLF/Unicode and keeps each paste as a
separate undo command. Empty or unsupported literal payloads leave the pending command intact.
Capture-phase host cancellation, including table conversion, keeps ownership of that clipboard
event and cancels the candidate continuation with recovery of previously queued text. No native
clipboard object is retained after dispatch and no OS clipboard qualification follows.

Snapshots expose `pendingInput` and `queuedInputUnits` alongside command readiness. Measure
`lastBeforeInputMs`, `lastInputMs` and `lastKeydownMs` as separate handler spans. A cancelled
`beforeinput` has no subsequent native `input`; its stale `lastInputMs` is not a new sample.
`maxQueuedInputTurnMs` covers the complete continuation callback, including final model commit
and refresh. None of these clocks includes all-view readiness, a complete automation action or
physical presentation; those require separate observations.

Double-click selects the code-word, symbol or whitespace run under the measured source point.
The range stays inside the clicked logical line, excludes its CRLF terminator and uses exact
grapheme boundaries. The existing cooperative word cursor supplies run edges with
`skipWhitespace:false`; its default keyboard-navigation policy still skips trailing whitespace.
Selection captures the buffer, revision, immutable selection and view target. A later edit,
selection, remount, replacement, composition or disposal expires pending work. Large selections
use the bounded native input placeholder; typing replaces the source range as one shared undo
transaction without exporting it. This is a code-oriented selection policy, with no claim of
language-specific word segmentation or native device qualification.

`wordSelectionEvents` and `lastWordSelectionMs` count double-click commands and measure the
complete synchronous handler elapsed span, including its first scan turns and subscribers.
Later cooperative turns, all-pane readiness, automation actions and physical display latency
are separate. `wordScanSteps` and `maxWordScanStepMs` also describe word-selection scans.
`maxWordSelectionTurnMs` is the longest complete synchronous selection handler or word/grapheme
continuation callback per mount, including guards, transitions, projection/subscribers and
scheduling. Scan-loop maxima omit that surrounding work; neither metric reports process CPU.

`bench:host-word-selection` records both hosts on normal Unicode/CRLF, 100,000-line and
2.4-million-unit ASCII words at beginning, middle and end. Three warmups and ten samples
retain command-handler, all-pane selection readiness and complete double-click action clocks,
then distinct typing-handler/readiness/action and full workflow clocks. Exact replacement,
shared undo-to-saved/redo, saved references, independent selections, context/DOM/read bounds,
background activity and disposal remain asserted. Per-workflow complete-callback maxima and
scan-loop maxima are separate from per-callback distributions. Optional screenshot smoke
inspection is excluded from full timings. Typing keeps the browser's native UTF-16 replacement
caret; trusted native-textarea controls record engine differences when a replacement forms a
new grapheme. Selection endpoints before typing still use the captured grapheme boundaries.

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
Home/End resolves the indexed logical line endpoint synchronously for at most 32 ranges;
Ctrl/Cmd uses the document endpoint. Both preserve Shift extension and read-only movement.
End excludes CRLF separators and includes a final literal CR. Immediate subsequent typing uses the new
normalized selections. Larger sets retain the cooperative command/cancellation path. This
bounded shortcut does not qualify general unpaced sequences of asynchronous navigation.
Horizontal arrows also finish at most 32 ranges before subsequent input when their endpoint,
adjacent logical and visible rows fit the existing 514-unit short-row bound. Native preparation
still uses batches of 16 ranges; complete short contexts use the existing grapheme fallback.
The bounded path includes preparation in the key handler. It has no elapsed-time guarantee.
Long contextual rows and larger sets retain cooperative cancellation; their command/input
ordering remains a pilot gap. Inner preparation counters are not complete handler or interaction latency.
Up/Down and PageUp/PageDown likewise finish at most 32 ranges before subsequent input when
their current and destination rows meet that short-row bound. Page destinations use current
viewport dimensions; native row preparation uses batches of 16 ranges. Preferred columns,
folded visible rows and Shift anchors keep their existing semantics. Longer contexts and larger
sets still yield; the bounded paths do not settle general ordering of input after pending commands.
Non-cancellable native word deletion requires a matching captured `beforeinput` target; stale,
unmatched or capability-blocked attempts emit recovery rather than applying a bounded-context deletion to the model.

Up/Down and PageUp/PageDown retain the measured horizontal column across shorter rows. A page
advances `max(1, floor(viewportHeight / lineHeight) - 1)` logical lines; Shift extends from the
existing anchor. The preferred column resets after edits, other navigation, external selection
changes or measured column-width changes. Nearest reveal keeps an already visible caret in
place. Raw CRLF offsets and independently scrolled views remain separate from native LF context.

Tab indents and Shift+Tab outdents. Press Escape, then Tab or Shift+Tab to move focus to the
next or previous host control. Shift alone preserves the pending exit. The next Tab consumes
that exit, so ordinary indentation resumes after returning to the editor. Host controls retain
their normal tab order.

Pointer selection uses rendered native rectangles; drag anchors expire across document changes.
Only the captured pointer can end its drag. Losing capture, cancellation, releasing the primary
button or disposing the mount stops selection updates and releases any remaining capture.
Returning to the editor after a release outside it leaves the retained caret unchanged; subsequent
typing inserts there. Unrelated pointer cancellation does not terminate the owned gesture.
Holding a captured mouse drag beyond a viewport edge continues selection through logical
scrolling on animation frames. It reuses the viewport's scroll, flush and native hit-test APIs;
compressed physical scroll ranges do not change the logical velocity. Speed grows with distance
outside the edge, capped at three viewport lengths per second on each axis. Each callback uses
at most 32ms of elapsed movement, so a delayed frame does not jump through the document.
The pointer is clamped to the visible content edge for hit testing after each scroll step.
Returning inside stops queued scrolling; hitting a document boundary stops it until another
pointer movement. Source revision, immutable selection identity, captured tab/view, composition,
input readiness, pointer capture and mount lifetime are rechecked before delayed work. Another
selection or revision expires the gesture instead of overwriting newer navigation.

This original selection policy is needed because bounded rendered rows cannot supply native
selection scrolling through unmounted content. It adds no external editing runtime or second
document state. `pendingDragScroll`, `dragScrollFrames` and `maxDragScrollStepMs` expose queued
work, projected frame count and the longest complete synchronous callback elapsed span per
mount. That maximum includes guards, layout, projection, selection/subscribers and scheduling;
it is separate from typing-handler duration, per-frame distributions and process CPU time.
The native textarea and preedit overlay sit near the measured caret. This is an input-positioning
experiment, with no native-device qualification claim.

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

`bench:host-drag-scroll` exercises both directions in both hosts on normal Unicode/CRLF,
100,000-line sources and simple ASCII long lines with compressed physical extents. Three
warmups and ten samples per condition retain actual pointer events and frame observations,
native-range selection checks, typing over the selected range, shared undo-to-saved/redo,
immutable saved references, ordinary-export/context/DOM bounds, background updates and disposal.
It reports the requested stationary hold separately from release readiness, the distribution
of per-workflow longest callback spans, typing-handler/readiness and complete gesture/point/
workflow automation clocks. The callback and handler targets are 16ms; release and point-ready
targets are 100ms normal/250ms large. Whole gestures include the imposed hold and have no point
action budget. These are measurements and targets, not native-device or display qualification.

Complete rows support [visual bidi navigation and dual affinities](bidi.md). Current limits include
long contextual-line geometry/navigation, wrapping,
touch/mobile selection, native undo/menu behavior, OS clipboard,
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

The guarded Chromium headless clipboard regression uses actual copy, cut and paste keys in
both hosts, including large backward selections, independent views, captured saves, shared
history and read-only transitions. It verifies the isolated headless shell before any clipboard
action and uses only known fixture text. The native baseline commits the textarea API value
with LF line endings; the candidate custom paste preserves the clipboard event payload.
Other browser backends, OS/application/browser-menu clipboard and native IME remain unverified. These functional scenarios collect no latency samples.

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
Snapshots expose `pendingCommand` for unfinished cooperative navigation/selection work,
separately from `pendingCaret` for a scheduled caret render (also used by focus/blur).
Hosts can guard semantic capture without rejecting ordinary focus transitions.
Snapshots also expose `pendingWord`, `wordScanSteps` and `maxWordScanStepMs` for the last word scan;
scan-loop elapsed time excludes final boundary normalization, model commit and rendering. The separate
key-to-frame-ready value includes scheduling/polling and both views, and measures no physical
input or presentation. Raw samples and provenance stay in ignored `artifacts/bench/navigation/`.
