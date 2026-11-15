# Signature help, links and colors over LSP

The plain and React hosts select these routes with `?editor=candidate&language=lsp`.
They use the shared provider and public clients below; they do not start a worker
for signature help, document links or colors. The default local-worker route remains
an independent fixture. The reference peer reuses the project's small lexical
fixtures; it establishes protocol behavior rather than general language semantics.

`sttropez/protocol` exports `createLspSignatureClient`, `createLspLinkClient` and
`createLspColorClient`. Each takes the existing `LspWorkspace`, exposes provider
state and `cancel`/`dispose`, and owns one independent feature scope. Captures retain
the exact resource, document, revision, sent UTF-16 index and provider generation.
Cancelling one client leaves the other features and shared connection available.
Missing or withdrawn capabilities produce an explicit unavailable/expired result.
Reconnect invalidates old results; no presentation edit or opening action replays.

Signature `run(document, offset, context?, prepare?)` returns a cancellable call.
Its result contains literal labels, documentation strings plus format-preserving `content`
on signatures and parameters, validated parameter offsets,
active indices, immutable wire context and an `isCurrent` guard. String parameter
labels must occur within their signature; tuple offsets address UTF-16 units.
Per-signature active parameters override the batch value. Missing or out-of-range
indices default to the first available entry, as specified by LSP; no parameters
means no highlighted parameter. This differs from the local fixture's explicit
out-of-arity presentation. The bounds are 32 signatures, 64 parameters/signature,
4,096 label units and 65,536 aggregate display units. Raw advisory context is
bounded separately to 131,072 units and grants no edit authority.

For a retrigger without explicit `activeSignatureHelp`, the client reuses its last accepted
wire context after checking the newly synchronized document/resource/URI/language, connection
epoch and registration generation. Starting or superseding a request does not discard that
context. An empty result, explicit new invocation, client cancellation/disposal or changed
provider authority clears it. Explicit host context takes precedence (including a selected
overload); inherited context is omitted if it would exceed the advisory size bound. No old
document buffer is retained for this purpose, and late cancelled replies cannot replace it.

Hosts can opt into Markdown negotiation and use the public [documentation view](documentation.md)
for paragraphs, emphasis, flat lists, code and explicitly authorized links. The main demo uses
that subset; the default negotiation and React fixture remain plaintext. Request lifetime and
parameter selection are independent of documentation formatting.

The host uses advertised trigger/retrigger characters after input settles, including
the editor's ordered key path and native beforeinput path. Requests carry the
appropriate trigger kind and previous advisory help on retrigger. Ctrl/Cmd+Shift+Space
retains explicit invocation. The existing 50 ms debounce and five-second input-wait
bound apply. Composition suppresses premature requests. Overload buttons change only
presentation. Completion receives Escape first when both offers are open; another
Escape dismisses signature help. Blur, cancellation and view removal end its intent.

Link `run(document, prepare?)` returns `{ items, isCurrent, resolve }`. A missing target
retains its validated source range and bounded opaque data until explicit resolution,
when advertised. Resolution may update only target and tooltip, preserving range and
opaque identity. The bounds are 1,024 links, 4,096 units per URI/tooltip, 8,192 opaque
data units/item and 65,536 aggregate display/opaque units per category. Resolution
payloads allow at most 16,384 units/item. URIs remain exact opaque strings.

The host maps a resolved URI to its captured registered resources before opening.
Unknown destinations remain visible and cannot execute a URL or fetch a resource.
Explicit opening uses the existing pane policy and captured source/target revisions;
return restores the complete source selections. A delayed resolution leaves a newly
focused form alone. Navigation or resource/capability changes expire pending intent.

Color `run(document, prepare?)` returns `{ items, isCurrent, presentations }`.
`presentations(item, rgba, prepare?)` requires a color from that captured list and
finite channels in `[0, 1]`. Discovery validates up to 1,024 ranges/colors.
Presentation validation accepts up to 64 choices, 32 additional edits/choice,
1,024 total edits, 16,384 units/insertion and 65,536 aggregate text units. A missing
primary edit uses the presentation label at the captured color range. Malformed final
entries, overlaps or out-of-document edits reject the whole batch. Empty choices
remain explicitly unavailable for application.

The host's proposed-color field is UI policy; protocol ranges are not forced through
the local literal parser. Provider presentation labels are plain text and may be
arbitrary. The existing preview shows every edit before an explicit authorized
Workspace transaction; additional edits and mapped complete selections share one
undo command. Changing a value while a presentation is pending cancels that capture;
the LSP route requires fresh discovery before previewing again. Local text is retained.

The protocol/model suites own malformed-result and lifetime permutations. The host
suite owns visible typing, navigation/focus and exact edit/history behavior, including
a selected 100,000-line control. The minimal restored consumer exercises these same
public exports without example controllers. These are supported-subset checks, not
native IME/OS clipboard, physical-display or production-provider qualification.
