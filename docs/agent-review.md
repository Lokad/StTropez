# Agent review protocol

An agent association, an executing request, a proposal version and a document revision are
separate identities. `workspace.agentState(resourceId)` supplies a stable readonly observable
with association, pending request, current proposal, acknowledgement queue and last result.
No service, credential, model client or agent framework is included.

## Request ownership and takeover

`associateAgent` attaches an opaque host-supplied ID with a workspace generation. Changing
that ID requires explicit detach. `beginAgentRequest(textResource, context)` copies immutable
source/configuration context and acquires an exclusive agent edit lease. Every edit origin
still needs its capability, matching lease identity and expected revision. Revoking permissions
cannot be undone by releasing the lease. Both native views reflect the lock; disabling a widget
is not the enforcement.

The request captures source resource/key/variant, revision, text and server version. The host
passes this immutable input to its service before awaiting. Deliver through the request's
`accept` method and always `finish` after settlement. Replies after interruption, detach or a
newer request are rejected even if the service ignored cancellation. Interrupted work retains
its operation lease until settlement while releasing the edit lock immediately for human
corrections. Closing/replacing a view cannot redirect resource work. Lock, request, proposal
and document publications share the workspace notification boundary.

```ts
const request = workspace.beginAgentRequest(source, capturedConfiguration);
try {
    const proposal = await service.propose(request.input, request.isCancelled);
    const result = request.accept(proposal);
    if (!result.applied) host.reportStaleProposal(result.reason);
} catch (error) {
    request.fail();
    host.reportError(error);
} finally {
    request.finish();
}
```

The exclusive lease ends on delivery, failure or interruption. It does not promise concurrent
human/agent merging. The host owns interrupt/detach UX and authorization. A versioned unsolicited
review update captures `captureProposal` before awaiting and passes that guard to
`offerAgentProposal`. The guard checks resource, association, document revision and proposal
generation. Retirement advances the generation even when text stays identical, preventing a
delayed offer from reviving retired review state. Request callbacks must keep using their
request ticket; switching APIs would discard request cancellation semantics.

## Proposal, correction, save and acknowledgement

A proposal records association generation, its own workspace generation, opaque proposal ID/revision, base document revision
and resulting document revision. Human corrections use normal transactions without rewriting
proposal identity. Older/equal versions of the same proposal are rejected. Invalid edit batches
publish no text changes.

A save captures that proposal target with exact corrected content and local revision. Its
successful receipt adds an independently owned acknowledgement entry retaining the exact
submission, canonical saved content and server version. Later proposals and human typing cannot
mutate this receipt. Canonical application also checks the captured proposal target, preventing
an older response from replacing newer review state.

`WorkspaceCommands.acknowledge(resourceId, acknowledgementId, port)` sends the earliest pending
entry. Failure leaves the successful save, proposal and receipt intact. Retry sends the same ID
and immutable payload without invoking save again. The host service must make retries idempotent;
this client does not promise exactly-once remote delivery. Acknowledgement retires a proposal
only when association generation, proposal ID and revision match. An older save can be
acknowledged without retiring the current newer proposal.

Pending proposals and acknowledgements retain ownership after views close. Detach releases the
proposal association/lease without discarding document content. Already saved acknowledgements
keep their original recipient and remain retryable after takeover. They cannot retire a new
association's proposal. Acknowledgement completion never edits text.

A subsequent request requires settled saves, no pending proposal and an empty acknowledgement
queue. It captures current text, including retained human corrections, and the acknowledged
saved server version. Changes after that save remain local/dirty and enter the next request;
the host may require an additional save if its policy needs one.

`tests/agent.test.ts` supplies headless scenarios. Both controller hosts exercise correction,
two saves, a newer proposal, service failure, acknowledgement-only retry, subsequent requests,
view replacement and interruption. Native-device composition and shared undo remain later gates.
