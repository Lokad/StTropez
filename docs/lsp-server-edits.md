# LSP workspace commands and server edits

The plain and React `?editor=candidate&language=lsp` routes use actual
`workspace/executeCommand` and `workspace/applyEdit` messages in the workspace-provider panel.
**Register provider review command** requests the fixture's dynamic registration;
**Request provider workspace status** uses its statically advertised read-only command.
**Request provider review edits** explicitly executes the
registered review command against captured working resources. The resulting server request opens
a preview. **Apply captured provider edits** or **Decline captured provider edits** settles that
particular decision. Receiving a request never grants edit authority by itself.

`LspSession.commandNames()` returns the union of advertised static and dynamic commands.
Command registration is global, with no document selector. `requestCommand` refuses unadvertised
names, snapshots bounded opaque arguments, and captures session/registration generations. It does
not impose a user interface policy or replay commands after reconnect. Each provider accepts at
most 128 names of 256 units; the combined union is limited to 256 names and each argument array to
8,192 JSON units. Invalid registration batches leave the previous registry unchanged.

`applyEdit` is an explicit session option. A `workspace/applyEdit` handler must be registered before
connecting when that capability is advertised. `decodeLspApplyEdit` validates the optional literal
label (256 units) and the entire [captured workspace text-edit batch](lsp-rename.md). URI identity,
raw UTF-16 ranges and separate local/wire versions retain the same rules. Resource operations and
change annotations remain unsupported. The reference peer is a development dependency; the
runtime session and validation code use no third-party packages.

The host adapter accepts an incoming edit only within the currently confirmed review command.
Unsolicited edits, overlapping requests and requests attached to a status command are refused.
The preview retains captured document/buffer/revision, origin tab/view, complete selections, fold
generation, authority, pending-input, session and registration ownership. A later focus change
does not retarget it. Typing, selection/fold changes, lost authority, remount or disposal expire
the decision. Every edited target must allow human and host edits without a lock. Confirmation
rechecks every target before one `Workspace.editDocuments` transaction; a malformed or unavailable
last target cannot leave an earlier one applied.

Each live incoming request has one reply. Decline and review timeout return `applied: false`;
protocol cancellation follows the RPC cancellation response. The review deadline is 90 seconds
inside a 120-second command deadline. An empty edit batch can acknowledge success without a
decision or history entry. Closed transports cannot guarantee delivery of a reply. If the
connection or command acknowledgement is lost after application, the host explicitly reports that
the edits remain applied and undoable. Reconnect never retries the command or transaction.

The whole batch is one shared undo command, including unmounted resources and complete origin
selections. Comparison baselines remain immutable. Changed-resource links, primary Save/Run and
later dirty typing retain their existing captured identities. Previews page every 64 edits, show
at most 256 inserted units with the full size, and bound deletion context independently of range
length. Confirmation applies every validated edit, including those on other pages. The text-edit
limits remain 100 resources, 1,024 edits, 16,384 units per insertion and 65,536 total inserted units.

The generic fixture qualifies registration/withdrawal, explicit decisions, stale tokens,
cancellation, real disconnect, lost acknowledgement, shared history, comparison and 100k-line
reviews. It is not a production language provider. Code-action menu commands and edit-followed-by-
command actions are still unavailable; they require connection to this owned decision flow before
they can be offered. Arbitrary background server edits remain a host-policy extension point.
Native IME/OS clipboard/display checks remain unverified. Headless correctness and bounded-preview
checks make no new latency distribution or heap claim; handler, readiness, automation/IPC/workflow
and physical-display clocks remain distinct.
