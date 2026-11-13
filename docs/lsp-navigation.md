# LSP hover and navigation

The plain/React `?editor=candidate&language=lsp` route uses actual JSON-RPC 2.0 WebSocket
requests for hover, definition and references. Their existing tooltip and navigation controls
consume validated results; they do not fall back to worker-v1 requests. The development provider
reuses the project's lexical fixture scanner behind the standard wire protocol. This qualifies
protocol/host integration, not general semantic language analysis.

`decodeLspHover` accepts a standard Hover or null. Plain strings, legacy MarkedString arrays/code
blocks and MarkupContent retain their format in immutable `content`, alongside the literal
`text` fallback. The client advertises plaintext by default; hosts can opt into the focused
[documentation subset](documentation.md) and explicit host-controlled link opening. HTML,
images and embedded content never execute. An optional range is validated against the captured
source buffer. A useful hover without a range is still shown. Limits are 64 fragments, 8,192
units per value and 16,384 units of combined display text.

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
before publishing any result. All locations within the configured transport limits are retained;
the decoder imposes no additional result-count quota. The demo and evaluation hosts page results
in groups of 64, retaining access to later locations by keyboard and controls.

The public navigation, rename and action clients accept asynchronous host loading through
`LspWorkspace`'s optional `resolveTarget(uri, context)`. Wire structure is validated before
loading missing targets. The context identifies navigation or editing, the captured source
(null for server-proposed edits), source/provider currentness and cancellation notification.
Return a retained `LspEditTarget` and an idempotent `release`; return undefined for unavailable
URIs. Use an exact immutable buffer, resource/document identity, revision, UTF-16 `LspLineIndex`
and an independent currentness guard. A closed target has `version: null`; a local revision must
never stand in for an unknown wire version. The host owns URI policy, contents and access rights.
Loading does not require an editor view or `didOpen`, authorize an edit, or open an external URL.

Cancellation, supersession, disposal and provider changes settle pending loading and release
retention, including a host result arriving after cancellation. Successful targets remain
retained until the client is canceled, reused or disposed; server-edit targets live through the
host's decision. Resolved target guards expire with that lifetime. Hosts should check the context
before publishing loaded resources and connect `onCancel` to their own loading operation. The
complete batch is checked again after loading, including target ranges, versions and identities.

The main demo's **Unopened files & navigation** sample initially creates only `main.ts` as an
editor resource. F12 loads editable `labels.ts` or read-only `contracts.d.ts`; Alt+Left and
Code → Back to previous location restore the source selection and view. Renaming the exported
`LabelOptions` type loads the unopened module for one atomic multi-file edit. Saved and recovery
inventories include unopened editable contents and exclude declarations. Standard-library and
outside-sample URIs remain unavailable under this demo's host policy.

The host navigation backend binds the captured working project, synchronizes it and then sends
the actual source position. A local word heuristic may label the request, but does not suppress
LSP queries at other valid positions. Definition link support is negotiated; references send the
captured `includeDeclaration` flag. Standard reference locations contain no declaration flag, so
the client does not guess which returned references are declarations. Wire versions remain
separate from local document revisions. Session/project bounds remain the [declared limits](lsp.md).
The generic fixture fails explicitly when its result bound is exceeded instead of pretending its
response is complete. Semantic completeness belongs to the provider.

The backend owns a feature scope on the same `LspWorkspace` as hover and completion. Participating
documents synchronize once across all scopes, including ordinary typing. A navigation request
captures the current project; its count describes that request's participating documents and does
not acknowledge completed provider analysis. Cancelling navigation leaves other feature scopes
usable. Capabilities/session changes invalidate previously
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
