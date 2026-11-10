# LSP hover and navigation

The plain/React `?editor=candidate&language=lsp` route uses actual JSON-RPC 2.0 WebSocket
requests for hover, definition and references. Their existing tooltip and navigation controls
consume validated results; they do not fall back to worker-v1 requests. The development provider
reuses the project's lexical fixture scanner behind the standard wire protocol. This qualifies
protocol/host integration, not general semantic language analysis.

`decodeLspHover` accepts a standard Hover or null. Plain strings, legacy MarkedString arrays/code
blocks and MarkupContent are bounded and displayed literally. No HTML, Markdown links, images
or commands execute. The client advertises plain text; Markdown received from a peer remains
literal text. An optional range is validated against the captured source buffer. A useful hover
without a range is still shown. Limits are 64 fragments, 8,192 units per value and 16,384 units of
combined display text. Rich Markdown rendering remains outside this subset.

Hover keeps its existing independent service lifetime. Requests retain the source revision,
complete selection set, fold generation and captured view. Pending input/composition prevents
capture; editing, navigation, blur, dismissal, view removal and stale service generations expire
results. Keyboard inspection keeps focus in its source; pointer inspection changes neither focus
nor selections. A service cancellation never applies an edit. Request leases, observers and
connections are released at their explicit host boundaries.

`decodeLspLocations` handles definition Location, Location[], LocationLink[] and null, and references
Location[]/null. Every opaque URI resolves through a host callback returning an immutable buffer/
resource/document/revision/index capture with a currentness guard. Targets need not have an open
editor view. No server URI is fetched, normalized, launched as a URL or silently discarded. Unknown
targets refuse the entire batch. LocationLink selection ranges must lie inside their target ranges;
optional origin ranges use the captured source. All ranges use strict raw UTF-16 positions, with no
silent source-range clamping. Mixed location/link arrays and malformed final entries are refused
before publishing any result. The bound is 1,024 locations; exceeding it fails explicitly.

The host navigation backend binds the captured working project, synchronizes it and then sends
the actual source position. A local word heuristic may label the request, but does not suppress
LSP queries at other valid positions. Definition link support is negotiated; references send the
captured `includeDeclaration` flag. Standard reference locations contain no declaration flag, so
the client does not guess which returned references are declarations. Wire versions remain
separate from local document revisions. Session/project bounds remain the [declared limits](lsp.md).
The generic fixture fails explicitly when its result bound is exceeded instead of pretending its
response is complete. Semantic completeness belongs to the provider.

The backend owns a project connection independent of hover and completion. Its synchronized-cache
count describes the last captured project, not a continuously synchronized live workspace or an
acknowledgement of completed provider analysis. Ordinary typing does no navigation transport work;
the next query captures current buffers. Capabilities/session changes invalidate previously
published results. Source or target revision/authority changes also expire the host result batch.
Unopened/removed resources cannot be retargeted by tab position or by whichever editor gains focus.

An explicit result action reveals the captured resource and range; a single F12 definition result
may open automatically only while the original input still has focus. Return restores the complete
captured origin selection set. Existing result pages retain their 64-entry bound. Known unmounted
working resources can open in an available pane. Comparison working views participate; immutable
baseline views have no provider binding or navigation keyboard handler. Read-only queries preserve
history, the baseline, and primary working Save/Run identities. Later typing remains independent
of an earlier Save receipt.

Native IME/dead keys, OS/application clipboard and physical-display qualification remain unverified;
all browser checks stay headless. The large-document journeys check bounded native input, exact
locations, no ordinary text exports and unchanged source/history. They establish correctness, not
latency-tail or heap qualification. Existing source-labelled performance evidence remains separate.
