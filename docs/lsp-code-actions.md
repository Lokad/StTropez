# LSP code-action previews

The plain and React `?editor=candidate&language=lsp` routes send actual `textDocument/codeAction`
requests. **Preview module action** or Ctrl+. captures the primary selection's UTF-16 range and
complete selection set. The module field configures this development fixture's import choice;
it is not an extra LSP request parameter. The response can offer several choices. Select one,
review its captured text edits, then choose **Apply captured action**. Discovery and selection
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

The action menu does not execute provider commands. Command-only choices and actions containing both
an edit and a command remain visible with an unavailable reason. Their edits cannot be applied
alone: LSP requires the edit followed by the command. The separate [workspace-provider panel](lsp-server-edits.md)
now executes advertised commands and owns captured server-edit decisions. Connecting action-menu
commands to that flow remains required work. The action session does not advertise applyEdit.
This limitation is independent of the delivered literal-edit and resolve paths.

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

Bounds are 64 choices, a 65,536-unit metadata validation budget, 8,192 units per opaque data/argument
payload and 16,384 per diagnostic list/lazy action. Across immediate choices the limits are 1,024
edits and 65,536 inserted units; each edit also uses the workspace validator's limits. A selected
resolved batch has that validator's own bounds. Previews show 64 edits per page, abbreviate inserted
text after 256 units with its full size, and keep deletion context bounded independently of range
length. Confirming applies every validated edit, not only the visible page.

The generic reference-peer fixture reuses StTropez's import cursor for one choice, supplies working-
project review markers and resolves TODO-to-DONE edits. Disabled and command-dependent choices,
malformed lists/resolves, changed authority, cancellation/reconnect, comparison, history and 100k-line
journeys qualify protocol/host behavior, not general module/type/scope resolution. No production
provider is required. Native IME/OS clipboard/display remain unverified. Browser checks stay headless;
large-document correctness/paging checks make no new latency-tail or heap claim. Handler, readiness,
complete automation/IPC/polling action and physical-display clocks remain separate.
