# Versioned worker project synchronization

The candidate hosts keep their navigation worker connected between successful requests.
**Disconnect navigation provider** releases it; local editing remains available.
**Reconnect navigation provider** enables a fresh request, which opens current bounded
snapshots in a new worker. It never replays a cancelled navigation intent.

The [headless change-span planner](text-model.md#conservative-change-spans-and-diagnostics)
supplies the buffer replacement used by these host fixtures, including compiled-asset consumers.

Synchronization happens before each query. Ordinary typing performs no transport or change
planning. The host captures immutable working buffers/revisions and temporary resource leases.
Saved/comparison references are excluded. Unchanged documents are reused; removed documents
receive versioned close messages. New documents open through bounded snapshots. Changed
documents receive a raw UTF-16 replacement followed by its insertion chunks. Metadata-only
save activity sends no text.

`examples/shared/language/project-change.ts` reuses `TextBuffer.sharedEdge` to prove common edges by
immutable backing identity. Its cursor visits at most 64 proof checkpoints per call and yields
between calls, without a character scan or complete export. When unchanged edges retain backing
identity, a small edit sends only inserted text; undo can delete with no insertion payload.
Small-piece coalescing can change backing identity at an edit boundary, so synchronization may
also resend those bounded copied pieces. A new revision returning to the same
acknowledged buffer sends only version metadata. If identity cannot prove an edge, the change
includes that unproved text. Multiple distant edits can therefore include unchanged text between
them; each transfer stays bounded and exact.

The host owns `examples/shared/language/navigation-client.ts`; the worker owns
`fixtures/language/project.ts`. This is a narrow local protocol, independent of editor policy and
application services. Every packet and acknowledgement carries protocol version 1, a connection
epoch and a strictly increasing sequence number. Document operations carry explicit identity
and target revision; changes require the exact prior acknowledged revision. Target revisions may
skip intermediate states when local edits occurred between requests. Queries carry their own
captured request identity and the complete document/revision/length set.

The worker stages open/change separately from committed documents. Chunks must be bounded,
contiguous and acknowledged. Only a complete validated commit publishes the new buffer/version.
Malformed, duplicate, stale, out-of-order or incomplete operations cannot mutate committed
documents. Queries cannot observe incomplete transfers; document mutation is refused during a
query. Each continuation scans at most one 16,384-unit chunk from resident buffers. Existing
navigation validation checks the entire result before publishing any location.

Limits are 100 documents, 16 Mi UTF-16 units per committed project, one transfer in flight,
16,384 units per chunk, 1,024 retained locations and 64 buttons per page. A staged replacement
can temporarily retain prior and incoming versions. Both realms reuse the TypeScript text buffer;
no compiler, accelerator, third-party runtime or local provider fallback is added. Cancelling a
pending request destroys its worker/cache; the next request resynchronizes. Dismissing a ready
result can retain the bounded connection cache. Disconnect, last mounted-view removal and
disposal release it.

Transport errors, invalid acknowledgements and timeouts discard the uncertain connection. The
host never advances its buffer/version ledger from malformed responses. Per-reply/whole-query
deadlines remain 5/30 seconds. Resource authority, complete origins and input/composition/table
guards still apply. Navigation, comparison, history and primary Save/Run retain their identities.

Focused tests cover raw BOM/Unicode/CRLF and split surrogate units, generated batches and older
immutable versions, atomic publication, protocol/revision faults, limits and close. Actual browser
workers cover warm reuse, one-unit changes in 100k rows, shared undo/redo, canonical save,
version-only changes, reconnect, working-resource close and mount/disposal. Counters distinguish
snapshot and delta units. Command/input-handler timings and complete transport/query/reveal
readiness are separate clocks; functional deadlines and single observations establish no tail or
physical-display qualification.

The [workspace command fixture](server-edits.md) uses the same client in a separately owned lane
for acknowledged local registration, captured server edits and custom status messages. Full
external-protocol compatibility and broader language semantics remain required. The declared
[LSP 3.17 target and supported subset](lsp.md) are separate from this internal protocol. Native IME,
OS clipboard qualification remains unverified where applicable.
