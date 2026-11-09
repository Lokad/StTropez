# Bounded provider fixture and text presentation

The editing fixture combines local incremental highlighting, a real worker completion request
and scoped diagnostics over the bounded view. The host owns the worker, UI, protocol and service
lifecycle. The runtime has no networking, language client, framework or worker dependency.
The narrow fixture reuses the existing tokenizer/worker rather than importing an editor/client
runtime. It is not an implementation of a full language protocol.

`mountTextViewport` and `mountEditingCandidate` accept an optional `decorate` function. It
receives the captured document ID/revision and one already bounded line fragment, its global
range and logical line start. It returns global ranges plus CSS class names; the view clips
valid integer ranges to the fragment and renders only text nodes/spans. Selection backgrounds
combine with overlapping decorations. Invalid ranges/classes are ignored. No provider string
becomes HTML. `viewport.invalidate()` schedules presentation changes independently of model
edits. Hosts must keep this synchronous callback pure and bounded, validate external data and
index/query large annotation collections before returning visible ranges.

The development line lexer recognizes a few deterministic keyword/number/comment patterns.
Each view keeps at most 128 fragments keyed by line and exact text, reusing local token offsets
when the text is unchanged. Editing one visible line re-tokenizes that line in each active view;
search/diagnostic changes reuse lexical results. This demonstrates incremental visible work,
not a complete grammar: multiline states and contextual long-line tokenization remain open.
Presentation classes are styled by the host fixture; the package retains no design-system or
language-specific dependency. Native range geometry continues to work across the token spans.

A request captures tab generation, document revision, view selection and a resource lease. It
serializes at most 4,096 raw UTF-16 units around the caret through the dedicated worker. The
worker returns separate insertion and replacement end positions and scoped diagnostics.
The host validates the entire unknown response, IDs/revision, ranges, text/message bounds and
diagnostic limit before publication. A word crossing the context boundary rejects completion
instead of replacing a partial identifier. Diagnostic output is capped at 256 entries, with
visible truncation; these are diagnostics near the caret, not whole-document analysis.

An offer remains tied to its original revision/selection. New text, moved selection, cancellation,
expired tab generation or disconnected worker prevents a late reply from applying. Read-only
and edit-lease rules are checked by the core transaction again at acceptance. Accepting insertion
or replacement creates one separate shared history unit and maps surviving diagnostic ranges
through that exact edit; a no-op preserves the revision and diagnostics. Later human edits clear
stale presentation. Diagnostic navigation uses explicit ranges and revisions, never later focus.
Diagnostic selection refuses active composition before changing model selection, revealing a range
or moving focus. It retains the diagnostic result: cancellation allows the same command afterward,
while a committed text edit expires the result and requires a fresh request. This reuses the host's
existing composition boundary for completion and comparison commands; it adds no runtime service.

Worker startup/error, malformed results, timeout and disconnect leave local editing/highlighting
available. Reconnect requires a new real worker result; no local fallback satisfies that path.
Cancellation deliberately leaves a possible late worker reply for the rejection tests. Pending
leases/timers and worker/listeners are released on disposal. The fixture's default snapshot
reports counts, revisions and input sizes, with no document/provider text.

Browser tests use actual keyboard input to create a request during `beforeinput`, ensuring the
document commit precedes the worker response in the same browser task. Other scenarios cover
Unicode insertion/replacement, diagnostic mapping/navigation, selection-only staleness, cancel,
tab replacement, malformed payloads, worker failure, reconnect, permissions, bounded huge-file
requests and truncation. `inspect` records completion and decorated search/diagnostic screenshots.
The restored package proof verifies the generic presentation callback and find API; the worker
remains host-owned. Full language transport/synchronization, richer operations, large lexical
invalidation and native accessibility announcements remain separate qualification work.

The review hosts also offer captured symbol information through a separate lazy worker lane.
Pointer inspection uses the existing viewport hit test without moving focus; Ctrl+K then Ctrl+I
inspects the captured caret, including in the comparison working view. Requests carry the exact
revision, complete selection set, tab generation and view identity. A bounded 4,096-unit window
aligns supplementary characters; a word crossing that window or exceeding 256 units has no offer.
The local fixture supplies short identifier summaries, without a parser or application service.
This deliberately reuses platform workers, the existing transport and editor geometry instead of
adding a language client dependency. The hosts also expose [captured definition/reference
navigation](provider-navigation.md) through a streaming worker lane, including unmounted
working resources, safe paged locations and complete-set return. Its local lexical policy is
explicit; [captured signature help](signature-help.md) now runs in the versioned worker lane.
[Captured lexical rename](rename.md) reuses that worker transport and atomic workspace edits with an explicit paged preview.
[Captured module-import actions](code-actions.md) reuse the existing domain planner and batch validator in that worker with explicit preview/confirmation.
[Captured module links](document-links.md) reuse that bounded import-line scan and captured host aliases for explicit internal resource reveal.
General semantic resolution and rename/actions/links and other language workflows remain
separate required work.

The complete response is validated before publication, then rendered only as text. Escape,
typing, composition, changed selection/revision and unmount cancel the captured presentation;
late replies cannot replace a newer view's offer. Pending work holds a lease and timeout.
Observation exists only while a request or offer is active. The popup follows host layout changes
and retains pointer access without taking focus. `EditingCandidate.describe(id)` registers a
host description ID alongside editor-owned help; its idempotent release preserves other owners.
The browser owns the attribute. DOM description wiring and keyboard tests do not qualify native
screen-reader announcements or complete accessibility support.
