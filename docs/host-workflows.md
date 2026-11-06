# Browser host workflows

Both `/hosts/plain/` and `/hosts/react/` use one persistent controller with stable resource,
document, tab and view handles. `?editor=native` mounts the native control; `?editor=candidate`
mounts the bounded input candidate. The same host protocol tests run against both choices.
These remain synthetic evaluation hosts. All service responses come from deferred local ports.

The bounded mount adapts its input, view capture/restore and disposal APIs to the existing
host binding. Shared selections remain registered across view detach/reattach. Capture first
synchronizes the native selection, including its direction, so a queued selection event cannot
lose a selection during unmount. Restoring a view combines its saved scroll position with
the retained, revision-mapped selection. React uses stable refs and explicit root lifecycle
calls; no effect manages editor or application state.

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
point edit while all three working views and the remote reference are mounted. Handler CPU,
document-capture-beforeinput to exact model/selection/diff/view readiness across two frames,
and complete keyboard-action automation are separate measurements. Stage/workflow timings
include controls, typing during deferred responses and settlement. The fixture imposes no
network delay. Full text/reference checks run outside timing; real IME/clipboard/AT and physical
display latency remain unqualified.

The conflict benchmark includes repeated and distinct 100,000-line sources and a 2.4-million
unit single-line control, plus normal sources in both source-editor modes. Its provisional
budget assessment reports misses explicitly; semantic success is not a latency pass. It
measures point insertion after loading a differing remote reference. First edits after an
identical-reference acceptance, sustained input, navigation and broader host populations remain
separate pilot qualification work.

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
qualify native IME behavior. Native-device input, reconversion, screen readers and clipboard
policy remain explicit acceptance gates.

Full fixture disposal unmounts DOM, removes listeners/subscriptions, cancels deferred ports and
awaits the controller's tracked command settlement. A queued save reaching its port after
disposal settles locally instead of adding another unresolved request. Pending command leases
then release through their normal completion paths. Full fixture disposal also detaches the
agent and releases its proposal lease. Model/recovery data remains owned
by the host; disposing a view does not discard unsaved work or retire stored receipts. The
consuming application still owns durable recovery, navigation and unload policy.

## Measurements

`npm run bench:hosts` runs three warmups and ten measured workflows for each plain/React,
native/candidate and normal/10,000-line condition, plus 100,000 lines for the candidate.
Two source views, an integrated comparison after proposal delivery and 20 Hz host progress remain
active. Reports contain exact source/environment metadata and raw samples. Full text oracles
run outside timed intervals, and actual candidate mounts are required.

The full-workflow and disposal numbers include browser automation transport, controls,
deferred response settlement and readiness polling, including completed diff work and current
working/reference viewports. They are automation proxies. Synchronous
proposal acceptance/notification CPU and selected candidate input-handler observations are
separate fields; ordinary editing has its own benchmark. These desktop diagnostics establish
neither physical presentation latency nor production tails, retained-memory budgets or a
production renderer choice. Native input and accessibility qualification remain open.

The host benchmark validates typing-group boundaries against event timing and undo depth.
Continuous adjacent typing must coalesce; a documented one-second pause starts another group.
It undoes and redoes every group created after the save capture and verifies exact final text
and saved state. Group counts and event timing bounds remain in raw samples, so an automation
stall cannot silently weaken either continuous-typing or undo-to-saved assertions.
