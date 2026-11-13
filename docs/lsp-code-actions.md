# LSP code-action previews

The plain and React `?editor=candidate&language=lsp` routes send actual `textDocument/codeAction`
requests. **Preview module action** or Ctrl+. captures the primary selection's UTF-16 range and
complete selection set. The module field configures this development fixture's import choice;
it is not an extra LSP request parameter. The response can offer several choices. Select one,
review its captured text edits, then choose **Apply captured action**. A command choice instead
shows **Execute captured action**, with its literal command title/name and argument count.
Discovery and selection
never apply edits automatically. A filled first choice may show its preview immediately.

`decodeLspCodeActions` validates the complete array or null before publishing any choice. It
handles CodeAction literals, Command literals, disabled reasons, preferred flags, open kind strings,
workspace edits and opaque resolve data. Titles/reasons are literal text; markup, links, arguments
and data never execute. Even disabled choices have their edit targets and metadata validated.
Malformed final entries and unsupported partial-list envelopes reject the entire result.

A lazy choice can request `codeAction/resolve` only when matching static or dynamic provider
options declare `resolveProvider`. `LspSession.featureOptions` uses the same document selectors and
readiness policy as document requests, returning immutable matching options. The client advertises
only the `edit` property for resolution and preserves the original opaque action. A resolved action
must retain all other attributes, including data, even when JSON object key order differs. Changed
titles, inserted commands, missing edits or stale generations refuse the response before application.

Command-only choices and actions containing both an edit and a command require explicit execution.
The command must be advertised by the captured session's static or dynamic global capabilities;
an unknown command disables the whole choice, including its edit. Confirmation transfers the
captured origin/resources/authority to the existing [workspace-provider review owner](lsp-server-edits.md).
That owner applies any initial edit atomically, synchronizes its new wire versions, then executes
the command with the original bounded opaque arguments. The shared provider advertises applyEdit
with its owner handler, routing only to the active command scope. Further server edits require Apply/Decline in the existing
Workspace provider panel; background requests without a confirmed intent remain refused.

The review lane admits one operation. Its observable state updates action availability; a busy
workspace review prevents execution before any initial edit. Later focus does not retarget the
origin. Action and workspace commands share one provider connection: a connection loss expires
every feature's old captures. Feature cancellation/disposal remains local. Cancelling, typing, selection/fold
changes, authority changes, remount, capability withdrawal or disconnect expire the owned command.

Each applied phase is an atomic shared undo transaction: one for the initial action edit, followed
by one per confirmed server batch. A command failure, declined later batch or lost acknowledgement
cannot undo an earlier committed phase automatically. Receipts explicitly retain applied edits as
undoable. Reconnect and fresh discovery never replay the edit or command. Code-action resolve still
advertises only the edit property; command resolution and automatic invocation are unsupported.

Requests carry trigger kind Invoked and known versioned diagnostic ranges/messages/severity/source
overlapping the captured primary range. Unversioned/stale/malformed pushes cannot supply anchors.
Diagnostic code, related information and opaque diagnostic data are not forwarded; diagnostic data
support is not advertised. The request range remains primary: these diagnostics do not acknowledge
completed provider analysis. No `only` filter, automatic invocation or partial-result token is sent.

The connection captures ready working resources, distinct local revisions/wire versions and exact
opaque host URIs. Source/target revision, authority, complete selection set, fold generation, module,
tab/view and session/capability changes expire the whole preview. Pending input/composition/table
conversion prevents capture. Typing, dismissal, disconnect and remount cancel pending discovery or
resolve without blocking local editing. A fresh reconnect never automatically replays an action.

Application uses the [workspace text-edit validator](lsp-rename.md) and one existing atomic
`Workspace.editDocuments` transaction after rechecking every edited target's human/host permissions
and locks. Complete-set undo/redo spans all participants, including unmounted working resources.
Independent views map normally. Comparison baselines remain immutable, and Save/Run keep their
primary captured resource even when an action reveals another target or later typing follows Save.

Complete lists and lazy actions use the existing transport message/JSON limits without separate
choice-count, metadata-string or aggregate edit quotas. Immutable JSON and full captured edit
validation still apply. Command execution retains its separately documented argument/authority
policy; decoding a command does not authorize its execution. The demo and evaluation hosts show
16 action choices per page. Edit previews show 64 edits per page, abbreviate inserted
text after 256 units with its full size, and keep deletion context bounded independently of range
length. Confirming applies every validated edit, not only the visible page.

The generic reference-peer fixture reuses StTropez's import cursor for one choice, supplies working-
project review markers and resolves TODO-to-DONE edits. It includes static/dynamic command choices,
ordered edit+command checks, opaque argument roundtrips and captured server-edit decisions.
Disabled and unadvertised choices,
malformed lists/resolves, changed authority, cancellation/reconnect, comparison, history and 100k-line
journeys qualify protocol/host behavior, not general module/type/scope resolution. No production
provider is required. Native IME/OS clipboard/display remain unverified. Browser checks stay headless;
large-document correctness/paging checks make no new latency-tail or heap claim. Handler, readiness,
complete automation/IPC/polling action and physical-display clocks remain separate.
