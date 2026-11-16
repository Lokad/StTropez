# Captured signature help

This page describes the default local-worker fixture. The `language=lsp` host route
uses the shared public provider instead; its [signature contract](language-features.md#signature-help)
defines advertised triggers and protocol active-parameter defaults.

The plain and React candidate hosts show signature help beside the primary caret. Type `lookup(`,
`format(` or `café(` to try the local provider. Opening brackets still pair normally. Active help
updates after settled typing, argument commas, selection/navigation and shared undo/redo while
the same source view retains focus. It uses the primary caret and preserves the complete selection
set. **Ctrl/Cmd+Shift+Space** or **Show signature help** requests the captured context explicitly.
**Previous signature** / **Next signature** cycle overloads without editing text or moving focus.

The current parameter is highlighted by validated UTF-16 offsets within the label. Documentation
and parameter text are plain text in both hosts. An argument beyond an overload's declared list
has no highlighted parameter; it is not silently clamped. Escape dismisses active help before the
editor changes selections. A second Escape resumes the editor's selection command. Blur, view
removal and composition dismiss help. Passive pointer hover stays suppressed while signature help
is visible; explicit keyboard hover takes ownership when Ctrl/Cmd+K starts its chord, dismissing
signature help and cancelling automatic retriggers before Ctrl/Cmd+I. Clicking or scrolling the documentation
keeps source focus and the complete selections.

Automatic opening triggers use a bounded, 512-unit known-name filter, then debounce for 50 ms.
Commas retrigger active help. This filter does not establish lexical correctness: the actual worker
resolves the complete prefix. Explicit requests also support known calls separated from their
opening parenthesis by comments/whitespace and calls whose opening lies far from the caret.
No whole-document export, prefix scan or change planning runs in the input handler. A pending
semantic input command or table conversion must finish before capture; automatic waiting stops
after five seconds and leaves the explicit command available.

The host reuses the [versioned project client](project-sync.md) in its own single-document lane.
Snapshots/changes are acknowledged in chunks of at most 16,384 units. The worker scans at most
one 16,384-unit prefix chunk per continuation, retaining lexical state across boundaries instead
of guessing the start state of a caret window. This handles distant comments/strings in 100k rows.
Normal and large sources keep bounded rendered rows and input context. A cold request streams
the captured source; settled requests reuse resident buffers and incremental changes. Cancelling
an in-flight request destroys its uncertain lane; the next request opens fresh snapshots.

The lexical fixture recognizes three terminal call names and two `lookup` overloads. It counts
top-level argument commas, handles nested parentheses/brackets/braces, Unicode names, CRLF,
quoted strings, line/block comments and ordinary regular-expression literals. Template literals
are opaque, including their interpolations. This is not a full language parser, type resolver or
general protocol adapter: complex grammar and semantic overload selection remain required
provider policy. Unsupported callees produce no signature. Names and nesting are bounded to
256 UTF-16 units and 128 frames; depth overflow is reported explicitly. Resident project size is
limited to 16 Mi UTF-16 units. Responses permit at most eight signatures, 16 parameters/signature,
1,024-unit labels, 2,048-unit signature documentation and 1,024-unit parameter documentation,
within the shared transport's 524,288-unit response limit.

Each request captures document identity/revision, complete selections, folds, resource authority
and an explicit tab/view. The host validates the whole response, including all overloads and
parameter ranges, before publication. Stale revisions, selection/authority changes, pending input,
composition, removed views and malformed replies cannot publish old context or retarget later
focus. Pending leases/timers are released; descriptions, observers, animation frames, subscriptions
and workers are disposed. Disconnect/reconnect never changes local text, history or review.

Per-reply and whole-request deadlines remain 5/30 seconds. Signature work never applies source
edits; Save/Run retain the primary working identity even when help comes from comparison.
Measurements distinguish the candidate's own input handler, whole synchronous command dispatch,
background synchronization/scan and complete all-view/widget readiness. Single controls and
functional deadlines qualify neither latency tails nor native input, clipboard or
physical display. General language semantics and application-specific service policy remain
outside these fixtures; the [declared LSP subset](language-server.md) is qualified separately.
