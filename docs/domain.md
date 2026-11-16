# Captured domain commands in the host pilot

Both candidate hosts expose **Discover domain regions**, **Collapse domain regions**
and **Insert catalogue import**. Focus a source or comparison working view first.
Annotations are text-only buttons that select and reveal their captured source range.
Discovery changes view metadata; it does not change source text or history. Imports
are one shared undoable command, with complete selection sets mapped in every view.
Later typing remains a separate human correction. Saved comparison references remain
immutable, and Save/Run keep their existing captured resource/revision behavior.

`examples/hosts/domain.ts` owns the controller, its stable observable and mounted
sessions. The plain host subscribes explicitly; React reads the observable through
its existing subscription hook and uses pure rendering and stable view refs. The
runtime has no domain parser or service dependency. `createFoldRegions` is public
so hosts can validate a complete reply against the same topology rules as per-view
fold handles before publishing annotations and fold ranges together.

The local cooperative provider in `fixtures/language/domain.ts` is a fixture policy:

- A header is `// #region stable-id Label`; its matching closer is
  `// #endregion stable-id`. Identities are unique, nested pairs must match, and
  labels are rendered as literal text. Raw UTF-16 anchors retain BOM and CRLF.
- Imports insert `import "catalogue";` after a leading BOM, using the first LF or
  CRLF ending (LF for a document without one). An exact existing import is a no-op.
  Incomplete regions do not prevent imports. A real host supplies its own policy.
- Each scan turn visits at most 16,384 UTF-16 units from immutable buffer chunks,
  retaining at most 512 units of any line. Limits are 4,096 regions/annotations,
  128 nesting levels, 256 units per label and 65,536 units of reply text. All
  identities, ranges, edits and fold topology are validated before publication.
- Annotation rendering queries a host-owned interval index and caps output at 64
  intersecting annotations. The panel shows at most 64 notes; its snapshot reports
  the complete count. Ordinary discovery/rendering does not export full text.

Integrated normal and 100k-line scenarios exercise 1,000 discovered annotations with two
live views, 100 inactive documents and 20 Hz background progress. First/middle/last region
navigation renders indexed marks while the inspector keeps its 64-note bound. Typing clears
stale marks; discovery, captured Save/Run, shared undo/redo, remount and disposal preserve
source identity and release the inactive workload. These are correctness and bounded-work
checks, without a new latency-distribution or heap-retention claim.

Commands capture a unique mounted session, tab target, document/revision, immutable
buffer and resource authority. Analysis retains the exact fold generation because it replaces
fold metadata, while allowing selection movement. Its existing mounted presentation listeners
also invalidate pending analysis; it adds no duplicate per-request subscriptions. Imports use
`captureViewRequest` to retain the complete selection set and visible fold projection, and consume
that capture once on application. Revision, permission/lease, fold, selection (for imports), unmount,
replacement, input or composition invalidation rejects the reply. A later focused
view never becomes the destination. Same-document pending input/composition in any
mounted view prevents capture. Cancellation and a 30-second failure deadline release
the resource lease and subscriptions; late replies cannot resurrect results.

Provider-owned folds retain collapse choices on refresh. Independent manual regions
are preserved. Changing a provider fold's bounds manually relinquishes ownership;
an incompatible refresh fails atomically. Per-view metadata survives host remount.
Text edits map fold anchors and clear stale annotations. Detached annotation buttons
cannot navigate a replacement session.

`tests/domain.test.ts` covers the scanner, limits, complete reply validation,
import policy, interval queries and actual cooperative cancellation.
`tests/browser/host-domain.spec.ts` covers both hosts, normal and 100k-row sources,
independent manual folds, review, shared undo, Save/Run, capture invalidation,
malformed/failed/late replies, remount and cleanup. This uses the actual local
provider callback, without an application service or a worker fallback.

These functional deadlines do not qualify point latency. Input-handler time,
provider callback work, complete result readiness and physical display latency are
different clocks. Native IME and OS clipboard checks remain
separate and unverified; the fixture is not full native or language-service
qualification. Further domain/language policy belongs in the host.
