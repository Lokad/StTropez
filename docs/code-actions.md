# Captured module-import actions

Both candidate hosts expose **Action module**, **Preview module action** and
**Apply captured action**. Ctrl/Cmd+. from primary, secondary or comparison working
source captures the document, revision, primary range, complete selections, fold
generation, tab/view and edit authority. It requests a preview and focuses/selects
the host module field. Editing that field changes no source text and invalidates
the old preview. Enter requests a fresh preview; Escape returns focus to the
captured source. Only the Apply button confirms the proposed source edit.

The actual resident worker uses the existing `DomainCursor` import planner. It
reads at most 16,384 UTF-16 units per acknowledged continuation, reuses synchronized
buffers/deltas and never exports the whole document. Its policy inserts
`import "module";` after a leading BOM, preserving the first LF/CRLF ending or
using LF when no LF exists. An existing exact import line disables the action.
The module is a bounded ASCII identifier of at most 64 characters, using letters,
digits, underscore, dot, slash and hyphen with an initial letter. This fixture
does not resolve modules, symbols, types or arbitrary semantic fixes. General
actions and consuming-host/protocol qualification remain required.

The preview shows the action title, every target's resource/document identity and
captured revision, original UTF-16 range, exact JSON-escaped inserted text and
bounded context. A shared validator checks the entire batch before publication:
only the captured document, exact revision, ordered non-overlapping valid ranges,
at most 256 edits and 16,384 inserted units. The response must declare completion,
match the action/module/range identity and finish the complete bounded scan. A
malformed later edit, incomplete result or unknown action cannot publish a partial
preview or source mutation. Titles/context are plain text; no returned command,
markup or script executes. Capture supports a document up to 16 Mi UTF-16 units.

The host retains a resource lease and subscriptions through preview/confirmation.
Typing, composition, revision, origin selection/fold, tab/view, module or authority
changes expire it. Pending semantic input/navigation and table conversion prevent
capture. Permission for both human and host edits without a lock is checked before
application. The existing `Workspace.editDocuments` path validates the batch and
publishes one shared undo command with the origin's complete selections. Other
views retain their own mapped selections. Later human corrections remain separate
history commands. Immutable review references and primary Save/Run identity stay
independent even when the captured source is a secondary resource. **Open action
changes in …** reveals the explicit participating resource for keyboard history.

Each worker reply has a 5-second deadline; the whole request has a 30-second
deadline. Cancellation of pending work drops uncertain transport state. Idle
worker failure invalidates the preview; reconnect synchronizes fresh snapshots.
Disposal releases field listeners, views, subscriptions, leases and workers.

Focused model/browser regressions and milestone qualification cover raw Unicode,
BOM/CRLF, normal/100k sources, complete sets, actual keyboard form entry, explicit
confirmation, idempotence, stale tokens, malformed/incomplete/unsafe responses,
authority, history, review, secondary identity, reconnect and disposal. Synthetic
composition/table guards do not qualify native IME/reconversion/dead keys, OS and
application clipboard, assistive technology or physical display latency. Those
device checks remain unverified. Command dispatch, complete readiness and actual
typing-handler durations are separate clocks; a bulk correctness deadline is not
a responsiveness pass.
