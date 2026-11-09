# Captured definition and reference navigation

Both candidate hosts expose **Find definition**, **Find references**, a declaration
inclusion choice, paged results and **Return to navigation origin**. F12 requests a
definition and opens a single result if the requesting input still has focus;
Shift+F12 requests references. Button requests present results without moving focus.
Choosing a result explicitly selects and reveals its captured raw range, expanding
the destination's folds. Returning restores the complete original selection set.
Navigation itself changes neither text nor shared history.

**Add navigation companion** registers a local source containing a `catalogue`
definition. Type `catalogue` in the primary source and find its definition to try
navigation to an initially unmounted resource. The host opens it through an explicit
secondary-pane lifecycle operation, retaining the previous view and unsaved work.
Primary-source Save/Run and immutable comparison references retain their identities.
The destination remains mounted through ordinary host remount. The native input
baseline can inspect results from its candidate comparison; opening a new destination
requires the candidate host adapter.

`examples/hosts/navigation.ts` owns stable observable state, captured mounted sessions,
project documents, resource authority and pending lifetimes. React renders this state
with pure components and stable refs. The provider is in a dedicated real worker lane
using the existing host worker entry. There is no local fallback or application service.
All ready working-variant resources are captured, including unmounted resources; saved
or comparison reference resources are excluded. A new resource added later belongs to
a subsequent request.

This local provider is a streaming lexical fixture, not a general language service:

- It reuses the hover fixture's bounded Unicode symbol policy (letters, numbers,
  connector punctuation, marks, ZWNJ/ZWJ; at most 256 UTF-16 units). Definitions are
  matching tokens immediately following `const`, `let`, `var`, `function` or `class`,
  separated by whitespace/comments. References are exact matching code tokens.
- Line/block comments and single/double/backtick quoted text are skipped, including
  quoted escapes. Template interpolation, regular-expression literals, lexical scope,
  imports/aliases, destructuring and multiple declarators need a language-aware host
  provider; this fixture makes no semantic-resolution claim.
- At most 100 documents/16 Mi UTF-16 units are searched. Only one ≤16,384-unit source
  chunk is in flight at a time; it is acknowledged before the next chunk is read.
  The worker retains bounded token state and at most 1,024 locations, with explicit
  truncation. Every retained location is accessible through pages of 64 buttons.
- A complete reply is validated before publication: request and resource/revision
  identity, document/result bounds, ordering, exact symbol text and raw boundaries.
  Invalid final locations reject the whole reply. Labels use host text rendering.

Pending queries capture the origin's complete selection set and fold generation.
Revision, selection, fold, authority, composition, input, replacement and unmount
invalidation reject pending results. Ready results expire when captured resources
change. Old result buttons carry a request token and cannot navigate a replacement
request/session. Worker failure is visible; an explicit new request creates a fresh
lane. Per-reply and whole-request deadlines are 5/30 seconds. Cancellation/disposal
terminates workers and releases temporary leases, listeners and subscriptions.

`EditingCandidate.snapshot().pendingCommand` describes unfinished cooperative
navigation/selection commands. `pendingCaret` separately describes a scheduled caret
render, including ordinary focus/blur work. Hosts must distinguish these when guarding
semantic capture. Navigation also guards queued input and composition in every mounted
view of the affected document. Host-owned table conversion is pending input too:
navigation, domain commands and primary-source Save/Run wait until that captured
paste commits or is explicitly cancelled. Functional deadlines do not qualify latency: input
handlers, command dispatch, complete worker/result readiness and physical display
latency remain separate clocks.

Focused coverage is in `tests/provider-navigation.test.ts` and
`tests/browser/host-provider-navigation.spec.ts`, including actual worker transfer,
100k rows, raw Unicode/CRLF, cross-resource reveal, complete-set return, review,
Save/Run, faults, stale results, paging and disposal. Full L02 language semantics,
remaining provider operations/protocol, native IME/clipboard and accessibility
qualification remain required and unverified where applicable.
