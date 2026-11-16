# Browser host workflows

Both `/hosts/plain/` and `/hosts/react/` use one persistent controller with stable resource,
document, tab and view handles. `?editor=native` mounts the native control; `?editor=candidate`
mounts the bounded input candidate. The same host protocol tests run against both choices.
These remain synthetic evaluation hosts. All service responses come from deferred local ports.

`HostFixtureServices` owns the deferred proposal/Save/Run replies, simulated source server and
acknowledgement failures. The controller retains command capture, review approval, comparison
publication and stable UI observables. View removal leaves services running; final disposal
settles their replies before the controller finishes waiting for command leases. Queued saves
reaching a disposed service settle without writing. Configuration and transfer keep their own
independent form-save owners.

`HostSourceReview` owns source Save, saved/reference baselines and conflict review. Conflict
reads and selected-version reads share one latest-request sequence; both retain captured tab
and reference identity. A reviewed save uses the reviewed server version as its precondition.
`HostLayout` owns tab placement, presentation and close/modal state. `HostLoadedSource` owns
the temporary source slot, its generation, pending load and explicit discard revision. It
rechecks dirty state after detached-view cleanup and releases only after tabs and leases leave.
The controller composes these owners and exposes their stable observables to both hosts.

Both main modules explicitly start `HostLifecycle` before installing fixture controls. The
lifecycle owns recovery, page events and ordered teardown: mounted views and bindings release
before captured fixture resources, then draft storage and tracked commands settle. Cleanup
continues after individual failures; repeated or reentrant disposal returns the same completion.
React mounting still returns after its explicit `flushSync` and ref completion. Fixture resources
register their captured identities for cleanup instead of supplying application startup.

Hover and signature popups share their observable presentation and DOM presenters across
plain, React and the static demo. The presenters render structured documentation through
`mountDocumentation`, then fit its measured dimensions to the viewport. React gives each
presenter an empty subtree through a stable callback ref; the returned cleanup releases its
subscription, listeners and documentation on detach, including Strict Mode replay. Signature
commands derive their heading, status and availability from one observed snapshot in both hosts.
Their pointer focus policy and popup ownership are preserved. No effect synchronizes state.

Language/find, navigation, workspace-provider, rename, code-action, color and link panels derive
one presentation model from the snapshot observed by their renderer. Both hosts use its labels,
progress, paging and command targets;
React does not reread the store while deriving commands. Result rows retain their captured
request token or resource ID. Lazy list formatting lets the plain host retain unchanged rows
on status updates; React uses stable row keys. The models own no subscriptions or service state.
Rename/action input bindings keep their existing stable refs and keyboard lifecycle. Provider
choice activation checks the current token before selecting an item; rendering itself uses only
the supplied snapshot. Both action routes capture the displayed changed resource in their links.
Color confirmation retains its request token, preview token and presentation ID; changed-color
links retain the displayed resource and cannot redirect to a newer result for another resource.
Color/link publication reconstructs bounded result rows. The plain presenters compare row values
separately from button state, preserving equivalent rows across pending, selection and focus
updates; React retains its row keys. F4/F6 list bindings and the color value field keep stable refs.
Language/find shares its field bindings, options, read-only policy, status text and commands.
Completion and diagnostic callbacks require their captured presentation snapshot to remain
current, so an older result cannot act on a newer view or batch. Retained plain rows receive
updated callbacks without replacing their DOM nodes; detach clears those handlers explicitly.

A persisted `pagehide` retains the mounted host and its listener for a later final hide. A
non-persisted hide starts teardown. Browser regressions exercise this policy with synthetic
page-transition events and fixture installation disabled; they do not establish real
back/forward-cache eligibility or restoration across browser/device combinations.

Reported errors retain the original thrown value in `HostController.lastError`, including an
Error's cause and stack, without freezing it into UI state. The fixture debug snapshot includes
name/message/stack for Error values; opaque thrown values remain available through the controller
getter. Dismissing the recovery message retains the latest diagnostic, and late reports after
disposal cannot replace it. The user message stays separate from implementation details.

Candidate hosts also offer a [source-backed anchored transfer-instruction form](transfer-instruction.md).
It patches known JSON string spans, follows source edits/folds/history and keeps explicit copying
into separate transfer settings independent of Save and Run. The host owns its sibling DOM lane;
the editor exposes rendered-row bounds without exposing or transferring ownership of row nodes.

Configuration has its own captured Save, validation, dirty/saved/failed status and explicit
remote-conflict review. The host reuses the generic resource save ticket for immutable capture,
per-resource serialization, canonical replies and server preconditions. Form fields and their
Save panel route Ctrl+S/Cmd+S to configuration; source inputs keep targeting source. Repeated
or composing shortcuts do not submit another write. A blank path blocks configuration Save
and Run while retaining the raw input; source Save remains available. Run captures the current
valid inputs without saving them, including while another configuration capture is saving.

Later edits survive a captured configuration receipt. A reviewed retry uses the observed remote
version and conflicts again if that version changed. Failure preserves the value and review for
retry. Unknown snapshot fields survive path edits, save canonicalization and draft restore;
restoring a configuration never rebuilds it from only the visible form fields. A save receipt
changing the baseline expires a pending checkpoint restore. Pending saves keep the unload guard
active even when current values have a recovery checkpoint. View removal keeps the controller's
pending port; final controller disposal settles it and releases its command lease. These local
fixtures demonstrate host policy without adding storage, schema or network services to core.

The **Transfer workspace** owns a distinct structured transfer resource. Destination and batch
size have independent dirty/save/validation state and reuse the same deferred form-save policy.
Batch size is a text field with a numeric keyboard hint so invalid input such as `1e` survives
editing and recovery. Valid values are decimal integers from 1 to 100000. Save never starts Run.
Run uses current valid settings even while an earlier capture is saving, and retains later edits.

Each Run creates a read-only resource containing captured source, connection and transfer
resource IDs, revisions, server versions and values. Progress appends immutable log resources
linked to that Run; older progress/results keep their captured identity and never save or run
inputs again. **Inspect Run**, log inspection and links to current inputs use separate typed
panel tabs. Source previews show at most 512 UTF-16 units. Current-input inspection refreshes
only on an explicit inspection/refresh command; ordinary typing does not rebuild previews.
View unmount keeps pending work and inspector choice. Final host disposal interrupts pending
Runs and settles Save ports; command leases release without discarding owned input values.
Run/log history is local to the fixture session. Durable service results, retention and routing
policy remain the consuming host's responsibility. These fixtures do not execute a transfer.

Reference versions update the existing comparison through a captured refresh ticket. They
preserve its editable input, focus, selection, provider target and in-flight working commands.
An external reference expires older captured reference commands and releases their leases.
Tab identity and generation control host mounts; a reference version does not recreate the
working surface. The stable binding owns and disposes its reference subscription, so React
components keep their pure rendering and explicit ref lifecycle. A reference reply while the
user types neither drops characters nor splits an otherwise continuous typing transaction.

`bench:host-reference-focus` measures the complete reference callback, all-pane readiness and
automation action separately, followed by a distinct point-input handler/readiness/action and
full workflow. Both hosts use normal Unicode/CRLF and 100,000-line sources with comparison or
host-form focus. Exact text/history/reference versions, stable views/focus, bounded contexts,
background activity and disposal remain assertions. Screenshot smoke inspection is separate
from repeated timings. These browser proxies do not qualify native IME
or physical display latency.

The bounded mount adapts its input, view capture/restore and disposal APIs to the existing
host binding. Shared selections remain registered across view detach/reattach. Capture first
synchronizes the native selection, including its direction, so a queued selection event cannot
lose a selection during unmount. Restoring a view combines its saved scroll position with
the retained, revision-mapped selection. React uses stable refs and explicit root lifecycle
calls; no effect manages editor or application state.

When a bounded view's horizontal placement follows its caret, the host restores that placement
using the retained selection mapped through edits made during detach. Primary, secondary and
comparison-working views use the same rule. An anchor for a different viewport point keeps its
original revision; the host does not relabel arbitrary stale geometry as current.

Plain scene rendering compares structural layout plus tab ID/generation. Status, navigation,
modal and independent form/progress updates leave the editor DOM mounted. Changing a tab's
surface remounts the correct captured document even when the surface remains text. React's
corresponding keyed refs preserve that same distinction. Background completions do not move
focus away from an active editor.

## Exercised sequences

- Open and type; associate/request an agent with captured source/configuration; change the
  form; deliver a proposal; correct it through keyboard input; save the captured revision;
  continue typing; fail/retry acknowledgement; issue the next request with current inputs.
- Queue two saves around a newer proposal and preserve it through older acknowledgement
  retry. Interrupt, close, replace, reload and reopen without retargeting late results.
- Start a deferred Run with captured source, configuration, settings and versions; continue
  typing and updating the form; complete or fail the Run while preserving focus. Running
  does not save. Completion counts and captured metadata are distinct.
- Unmount/remount independent selections, retain shared history, recover a React root failure,
  and dispose during queued saves, pending Run and agent requests.

The browser matrix also exercises a 100,000-line CRLF/Unicode source through the full candidate
workflow with two bounded source views and an integrated comparison. Ordinary rendering and metadata polling do not export text.
Explicit agent/save/Run capture exports the exact requested snapshot for the host port. Range
readers verify complete text outside measurement without changing that export boundary.

## Integrated source review

A delivered proposal opens an immutable reference captured before the request alongside an
editable working comparison. Opening or closing review preserves the two source mounts and
their independent selections. All three working views share the document and undo history;
hunk navigation and **Use baseline** use the existing comparison implementation.

Reference commands deliberately separate capture from synthetic service completion. Acceptance
advances the reference to its captured working revision and retains later typing. Refresh reads
the latest successful save receipt; it does not replace working text. Reference versions are
distinct from resource server versions and agent proposal revisions. Advancing the reference
invalidates older tickets. Closing, hiding, replacing or unmounting review cancels its pending
tickets, while a completed reference survives reopening. These commands neither save nor
acknowledge an agent proposal. Comparison editing always uses the bounded candidate, including
when the two source panes use the native baseline.

The comparison's working selection is host-owned too. Closing/reopening review and a full
host unmount preserve its independent selection and scroll position. Edits made while detached
map the retained selection through the shared document. The reference pane restores selection
and scroll only for the same buffer and reference version; acceptance or refresh to a different
reference starts a new reference view. Pending tickets still expire on detach. Host disposal
releases all retained selections, and reopening does not focus an input automatically.

Viewport snapshots expose the immutable selection used by their last completed render,
alongside that render's revision. A model selection can change without a revision change;
readiness checks must wait for the rendered selection and pending work as well as the revision.
Candidate snapshots separately expose synchronous keydown-handler elapsed time, pending caret
work and cooperative word/grapheme steps. Keydown initiation can finish before those jobs,
comparison or painting; it is not complete interaction latency.

`bench:host-navigation` exercises actual word/grapheme, line selection, deletion, undo/redo and
page commands with review and 20 Hz host traffic active in both candidate hosts. It checks
beginning/middle/end positions in Unicode/CRLF, repeated/distinct 100,000-line sources and a
2.4-million-unit identifier. Explicit selection setup and full text/reference oracles are
outside timers. Readiness waits for pending scans/caret work, exact model and rendered
selections/revisions, completed comparison and two consecutive frames. Handler elapsed time,
readiness, automation and cooperative step times remain separate. Deleting or restoring more
than 4,096 units is labelled bulk and receives no point-action readiness target. Target misses
remain in the report. The comparison reference index is warm; this does not qualify cold first
edits after the identical-buffer fast path, physical display latency or native device input.

## Save conflicts and reviewed retries

Both hosts show save status and a conflict panel with the attempted local revision, expected
server version and observed conflict version. **Review remote source** starts a deferred read;
**Finish remote review** supplies its captured immutable snapshot. Local typing continues.
The read captures the source tab generation and conflict identity, so replacement, close or a
newer read prevents an old response from publishing. A further remote write after read capture
is deliberately possible and remains protected by the subsequent save precondition.

The remote snapshot becomes a comparison reference. Edit the working source, then explicitly
choose **Save reviewed source**. That command captures the current local revision and the
reviewed remote version. Changed references, expired source tabs, permissions and edit locks
prevent submission. Another remote change produces a new visible conflict; it never silently
retries against an unreviewed version. Only a successful save changes the saved baseline.
Canonical replies preserve later typing, and corrected agent proposals retain their independent
acknowledgement/retry flow. Reference acceptance and refresh do not authorize a conflict save
after replacing the reviewed reference. The fixture's external-writer control changes only its
synthetic service state, not the local document. No application service is integrated.

`bench:save-conflicts` records full conflict/read/retry workflows with 20 Hz host traffic and a
point edit while all three working views and the remote reference are mounted. Adapter-handler elapsed time,
document-capture-beforeinput to exact model/selection/diff/view readiness across two frames,
and complete keyboard-action automation are separate measurements. Stage/workflow timings
include controls, typing during deferred responses and settlement. The fixture imposes no
network delay. Full text/reference checks run outside timing; real IME/clipboard and physical
display latency remain unqualified.

The conflict benchmark includes repeated and distinct 100,000-line sources and a 2.4-million
unit single-line control, plus normal sources in both source-editor modes. Its provisional
budget assessment reports misses explicitly; semantic success is not a latency pass. It
measures point insertion after loading a differing remote reference. First edits after an
identical-reference acceptance, sustained input, navigation and broader host populations remain
separate pilot qualification work.

## Temporary loaded sources

The deferred-load fixture owns one temporary source resource independently of the primary
source. Clean loaded text is released after its last tab, view and operation detach. Detached
selection and viewport state for that released document is removed; source view state remains.
A response arriving after source switchback completes only its captured resource, then releases
that unused clean resource. Repeated loads reuse the live clean fixture resource when appropriate.

Dirty loaded text stays reachable through **Reopen loaded source**, retains shared history and
view selections, and keeps the navigation guard active. Starting another load requires resolving
that draft first. **Discard loaded source** explicitly releases that captured revision once its
owners detach; later edits expire the discard request and remain available. This temporary draft
is not included in the source/configuration/transfer checkpoint or those resources' Save/Run
captures. A consuming host must declare its durable policy for additional documents.

## Input recovery and disposal

The binding consumes the editor's existing `sttropez-conflict` event and validates its captured
document/revision and fields. The host retains attempted text, context origin and any attempted
edit in a separate immutable recovery store. This store survives editor unmount/remount. It
never reapplies stale text to the source. Explicit inspection displays at most 4,096 characters;
discarding recovery data is a separate host action. Routine diagnostics expose only document,
revision, reason, context origin and attempted length. Full attempted text is a content-bearing
recovery API and is excluded from default snapshots.

Synthetic composition checks demonstrate an independent form/progress update and Run failure
without losing preedit, plus rejected preedit recovery during an agent takeover or forced
view removal. Removal emits recovery before owned listeners are disconnected. These checks do not
qualify native IME behavior. Native-device input, reconversion and clipboard
policy remain explicit acceptance gates.

A captured save can also settle while composition is staged. An unchanged reply leaves the
draft available to commit as one shared undo transaction. A canonical reply that changes the
document rejects the stale composition and retains its attempted native text and captured
document/revision in recovery. Recovery survives remount without overwriting the canonical
source or changing the immutable comparison reference. Native draft text uses textarea newline
normalization; the document retains its original CRLF source.

Full fixture disposal unmounts DOM, removes listeners/subscriptions, cancels deferred ports and
awaits the controller's tracked command settlement. A queued save reaching its port after
disposal settles locally instead of adding another unresolved request. Pending command leases
then release through their normal completion paths. Full fixture disposal also detaches the
agent and releases its proposal lease. Model/recovery data remains owned
by the host; disposing a view does not discard unsaved work or retire stored receipts. The
consuming application still owns durable recovery, navigation and unload policy. The example
[draft recovery controller and browser store](host-drafts.md) demonstrate explicit durable
checkpoints, independent guarded restore, storage failure handling and an unload choice;
they keep persistence and browser policy outside the editor package.

## Commands, permission changes and clipboard

Ctrl+S or Cmd+S in a source editor invokes the host's existing captured-save command without
moving focus or changing selection. Primary, secondary and comparison-working views share
this route; configuration fields keep their own keyboard behavior. Active composition,
expired view targets and detached inputs do not dispatch a save. Repeated keydown events do
not enqueue repeated saves. The view binding removes the listener during unmount/disposal.

Multiline indentation checks editability before it schedules any planning work. A Tab or
Shift+Tab pressed while the view is read-only cannot become a deferred edit after the host
restores permission. Commands that begin editable still capture their document revision and
view selection, and the model checks current permissions before committing. Existing history
and mapping code own each accepted indentation or clipboard transaction.

The integrated host scenarios exercise keyboard row selection across CRLF, indentation and
outdent, paired brackets, copy/cut/paste, shared undo/redo and Escape/Tab focus into the adjacent
configuration form and back. Find, provider diagnostics, review and deferred saves remain
present. Read-only checks permit copying and navigation while rejecting text/history edits.
Both input adapters project the retained model selection on Tab keyup: a browser's default
focus range must not replace the view's collapsed or backward selection. Other selection
events keep their existing native-to-model path, including pointer placement.
Large backward clipboard ranges keep native contexts and rendered rows bounded through
remount, without changing the immutable review reference. Clipboard payload work is explicit
user-requested range work; it is separate from ordinary typing and routine telemetry.

The fixture save service trims trailing whitespace in its canonical reply. Later human edits
remain intact. Undoing later typing may still leave raw CRLF different from the canonical saved
baseline; dirty state stays true until an explicit user edit adopts that exact saved text.

These clipboard scenarios dispatch synthetic ClipboardEvent/DataTransfer payloads and prove
the editor's event path. They do not qualify the OS clipboard, browser menus or native input.
Windows IME and dead keys remain separate unverified device gates.

## Language and find in the review host

The bounded source views and editable comparison use the same small fixture lexer and real
worker provider as the editing playground. Each view has an independent bounded presentation
cache. Comparison decorations compose host tokens/search/diagnostics with change highlighting;
the immutable reference receives only its own local tokens. Services remain host-owned.

Focus a source view, then use Ctrl+Space to request completion and Alt+Enter to replace its
captured word. The host also exposes insertion/replacement buttons and scoped diagnostic
navigation. Ctrl+F opens find, Ctrl+H opens replacement, F3 moves between matches, and Escape
from the find fields cancels and returns focus. Search and replacement reuse the existing
cooperative controller and shared history. These keyboard routes are automated pilot evidence;
native IME qualification remains separate.

Pause over a source symbol, or use Ctrl+K then Ctrl+I, for captured plain-text information.
This read-only command has its own worker lane and explicit view target, including comparison
working views; it does not retarget completion or steal host form focus. Escape dismisses the
popup before changing multiple selections. Typing cancels it and retains normal shared history.
See [provider bounds and lifecycle](providers.md) for the local fixture's limits.

**Whole word** restricts literal matches using the code-word boundary policy in
[search](search.md). The option survives source/comparison command routing and remount. Current
replacement requires an indexed whole-word match; selecting a substring cannot bypass the
option. Changing the option cancels queued replacement planning before rescanning.

The host language controller exposes one stable observable handle with immutable snapshots.
Plain and pure React views render those snapshots and call commands. Stable editor refs own
mounting; React effects do not synchronize editor or application state. Each provider request
captures a document, tab generation, revision, view and selection before posting at most 4,096
UTF-16 units. Validation, partial-word refusal, diagnostic limits and shared undo transactions
reuse the playground implementation. A view change cancels the previous offer/request and
search; a late reply cannot apply to the newly focused view. Worker failure/disconnection leaves
local typing and highlighting available. Reconnect requires a fresh request.

Unmount cancels searches and pending requests, terminates workers and releases subscriptions
and temporary leases. Independent selection/scroll and owned unsaved source survive remount.
The host diagnostics include the language panel's observable subscriptions. No provider engine,
reactive dependency or application-service connection is added to the runtime package. The
example controller is host code; the package supplies editor and comparison primitives.

`bench:host-language` records six repeated normal/distinct-100k-line/long-line workflows across
both candidate hosts, with background traffic and all review views mounted. A real worker
hover is ready before typing; its popup/layout observation is released in `beforeinput`. A completion
request is posted in that same task so the subsequent text change must
make the reply stale. Fresh completion, keyboard search, save with later correction,
acknowledgement failure/retry and the next request follow. Each stage and whole workflow is an
automation proxy including controls and asynchronous settlement; the report keeps the typing
adapter's input-event handler duration separate. These stage clocks are not point-input
readiness timings. The existing host-input benchmark retains its input-to-ready clocks and
targets. Full text/reference checks and setup run outside the workflow clock; no service delay
is imposed. Physical display latency and native devices are unmeasured.

## Measurements

`npm run bench:hosts` runs three warmups and ten measured workflows for each plain/React,
native/candidate and normal/10,000-line condition, plus 100,000 lines for the candidate.
Two source views, an integrated comparison after proposal delivery and 20 Hz host progress remain
active. Reports contain exact source/environment metadata and raw samples. Full text oracles
run outside timed intervals, and actual candidate mounts are required.

Host and save/conflict drivers write separate `full` and `smoke` directories under their benchmark
directory. Each run is retained; `latest.json` refers only to a passed run of that variant.
Set `STTROPEZ_HOST_SMOKE=1` or `STTROPEZ_CONFLICT_SMOKE=1` for a one-observation wiring check.
Its output cannot replace full-run evidence. Ten-observation budgets use the observed maximum
and report the sample count; they do not estimate a production p95.

The full-workflow and disposal numbers include browser automation transport, controls,
deferred response settlement and readiness polling, including completed diff work and current
working/reference viewports. They are automation proxies. Synchronous
proposal acceptance/notification elapsed time and selected candidate input-handler observations are
separate fields; ordinary editing has its own benchmark. These desktop diagnostics establish
neither physical presentation latency nor production tails, retained-memory budgets or a
production renderer choice. Native input qualification remains open.

The host benchmark validates typing-group boundaries against event timing and undo depth.
Continuous adjacent typing must coalesce; a documented one-second pause starts another group.
It undoes and redoes every group created after the save capture and verifies exact final text
and saved state. Group counts and event timing bounds remain in raw samples, so an automation
stall cannot silently weaken either continuous-typing or undo-to-saved assertions.

`bench:host-input` measures the first character, Enter and a 32-character typing burst after
accepting an identical reference. Before each clock the reference is the exact working buffer
and the completed diff reports zero work/reads. Caret setup/reveal and acceptance are outside
timers. Both candidate hosts run beginning/middle/end positions in Unicode/CRLF, repeated and
distinct 100,000-line sources and a 2.4-million-unit single-line control, with 20 Hz traffic.
Full text/reference assertions and shared undo/redo run outside clocks.

The long-line control also types the source's existing `x`, as one character and a 32-character
burst, at all three positions in both hosts. These repeated-text cases expose equal-prefix
scanning and ambiguous native ranges. The report identifies the text pattern explicitly:
72 mixed-text conditions retain their original data, with 12 repeated-text conditions added.
Enter remains covered once per position. The input/readiness oracle and timing targets are
the same for both patterns.

During bursts, render-event timestamps record when all three working panes have the expected
model/rendered selection and revision. These observations can precede caret and comparison
settlement; they are not complete interaction readiness. Superseded revisions with no ready
observation remain counted, rather than being labelled displayed. Full final readiness waits
for caret/scans, all working views, completed comparison/reference and two consecutive frames.
Input-event handler duration excludes the separate `beforeinput` capture; the full clock
starts at `beforeinput` and includes that work. Handler duration, whole-burst readiness,
settlement after the last input and complete action
automation have separate fields. Requested keyboard delay and actual input gaps are retained;
burst totals include cadence and instrumentation. No metric proves physical presentation or
native IME/clipboard support. Target misses remain in raw assessments.

Plain host controls project changed text, field values and enabled states into their existing
DOM. Identical offers and diagnostic labels retain their rows; diagnostic buttons resolve the
current controller entry when invoked. Comparison progress also retains unchanged headings,
messages and control attributes. This reuses the viewport and configuration field's existing
DOM equality-guard pattern, without a second application-state store or reactive dependency.
Actual provider results, permissions and reference versions still update their visible controls.

## Equal references and input timing

`bench:host-reference` pairs acceptance of the exact working buffer with refresh from an
independently stored, equal saved reference. Both arms explicitly save the same source first.
The fixture's canonical trimming leaves that source unchanged because it ends in a nonwhite
character. Save automation and its intentional text capture are recorded outside the reference
and input clocks. Exact text and reference checks run outside those clocks too.

The existing 84 input conditions remain intact, including first character, Enter, sustained
typing and repeated-x long-line controls. Two reference types and two history modes produce
336 conditions with three warmups and ten measured samples. A fresh condition recreates its
host; accumulated conditions retain the pattern/position/mode sequence within each arm and
iteration. Arm order alternates. Both hosts, beginning/middle/end positions, Unicode/CRLF,
repeated and distinct 100,000-line sources and a long-line control remain explicit.

Reference timing starts at the captured finish command's click. Document bubbling observes
both plain and delegated React handlers; this dispatch observation includes instrumentation.
Reference replacement is a separate whole-document operation, with no point-action budget.
Input timing starts at `beforeinput`. Adapter input-handler duration, working render, scans,
caret, comparison computation, current reference readiness and complete automation clocks are
separate. Full readiness requires current model/selections, every working/reference viewport,
the displayed reference version, completed comparison and two frames. Requested and actual
key cadence, raw samples and p50/p95/max values stay in the report.

The report retains raw warmups in `warmupCases`, separately from the measured `cases`.
Warmups never enter measured distributions or target assessments. The `retention` counts
cover workflows and input events in both phases. Failure reports include completed samples
from both phases and available active save/reference/input results captured after their
clocks close, before assertions. Partial results remain identified by the active case and phase.
Failure JSON and its screenshot share one identifier.

`npm run bench:host-reference -- --retention-check` exercises eighteen existing normal-source,
accumulated-history controls with two warmups and one observation. It writes
`retention-check.json` and marks the result diagnostic-only. This checks report retention;
the full campaign keeps its original 336 conditions, three warmups and ten observations.

Comparison scheduler counters describe an old generation until a new job first advances.
The observer checks that identity before attributing counters. It samples every input capture
and bubble, render events and frames, retaining observed work for superseded generations
alongside final-generation counters. These observations add overhead and are not process CPU
attribution. They do not replace the original input reports or establish a runtime speedup.
The comparison counters' `totalStepMs` sums inner-loop elapsed time across one generation;
`maxStepMs` is the longest inner loop. Both exclude outer rendering and rescheduling and
neither measures a complete callback. Fresh host documents share a browser process, whose
caches may persist across document navigation.
All exact-source/history, independent-selection, bounded-context/DOM/read, ordinary-export
and disposal assertions remain active. Native devices and physical display latency remain
unverified.

## Save transport recovery

The deferred local save port exposes **Fail save** alongside **Finish save**. Failure rejects
the existing captured submission; it does not write the synthetic server, advance a saved
reference or create an acknowledgement receipt. The existing command layer reports the error,
marks the save failed and releases its ownership. Human edits and shared history remain owned
by the document. This control exercises a service failure without introducing a service client.

A retry captures the current source explicitly. Content already queued keeps its captured
revision while server preconditions are resolved when that queued submission starts. Successful
retry receipts preserve edits made after capture, including across host remount and tab movement.
Reference refresh and acknowledgement remain independent commands. Disposing the host settles
pending rejections and queued operations before reporting completion; late controls are inert.

The recovery scenarios use real keyboard corrections in plain and React hosts, independent
selections, both source adapters and a 100,000-line bounded candidate. They check the exact
source, saved/reference/server versions, undo-to-saved behavior, acknowledgement retry and
released ownership. These local fixtures do not establish native-device support or real-service
availability. Handler duration and complete recovery workflow measurements remain distinct.

`bench:save-recovery` repeats eight candidate-host conditions with three warmups and ten
measured samples: both hosts and Unicode/CRLF, repeated/distinct 100,000-line and long-line
sources. Initial successful save/reference setup is outside recovery clocks. A rejected save
is followed by a real point input while corrections remain owned, then an explicit retry,
later typing, remount, successful receipt and saved-reference refresh. History and full source
checks remain exact. The native baseline has semantic browser coverage; candidate handler
measurements do not certify its input path.

The report separates the adapter input-event duration, point-input review readiness, visible
failure-plus-review readiness, complete point/failure automation, capture, retry/remount,
reference refresh and complete recovery workflow. The point probe uses the existing current
model/selection/scans/caret/all-pane/two-frame contract. The failure clock additionally waits
for the visible host message and two further frames. Full workflow time includes intermediate
automation/assertions and typing; no service delay is imposed. Whole recovery and reference
replacement have no point-action budget. Raw samples, background counts and p50/p95/max remain
available, including target misses. These proxies do not measure physical presentation.

Raw warmups are retained in `warmupCases`, separately from measured `cases`; they never enter
measured distributions or target assessments. The `retention` counts distinguish workflows
from the single measured point input within each workflow. A full run retains 24 warmup and
80 observed workflows and point inputs. It does not count every other key in the workflow.
Failure reports retain completed conditions in both phases, current-condition raw samples and
available stage results captured after their clocks close. Active phase and stage identify
partial results. Failure JSON and its screenshot share one identifier.

`npm run bench:save-recovery -- --retention-check` runs both existing normal-source controls
with two warmups and one observation each. It writes `retention-check.json` and marks the
result diagnostic-only. This validates reporting; it is not a reduced qualification campaign.
The full run retains its original eight conditions, workflow order, clocks and semantic checks.
