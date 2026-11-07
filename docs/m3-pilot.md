# M3 editor and review pilot

M3 targets a usable editor/review workflow in the plain and React evaluation hosts. It does
not require a general font engine, IDE parity, deployment or application-service integration.
Further font/shaping expansion is deferred unless a reproducible pilot defect requires it.

Completion requires current evidence for each criterion below. Existing kernel and isolated
fixture results are supporting evidence; they do not replace an integrated host workflow.

| Criterion | Required behavior and evidence |
| --- | --- |
| Editing | Actual keyboard typing, single selection, word/line/grapheme navigation and deletion, multiline indentation, paired brackets, clipboard paths, read-only transitions and focus escape preserve exact text and selection. |
| History | Undo/redo is shared across views, reverses each command as one intended transaction, returns to the saved baseline, and preserves later human corrections around programmatic edits. |
| Saving | Captured saves, server-version conflicts, retry/canonical replies and dirty state are visible and correct while typing continues. Stale responses never overwrite newer work or retarget another tab. |
| Review | The same host exposes an immutable reference and editable working comparison, hunk navigation/reversion, captured refresh/acceptance and shared history. Reference, saved and proposal versions stay distinct. |
| Host integration | Plain and pure-function React hosts exercise edit, proposal/correction, comparison, save/acknowledgement and the next request. Background progress, configuration edits, move/remount and failures preserve focus and independent selections. |
| Large documents | Normal Unicode/CRLF sources, 100,000 lines of about 2.4 million UTF-16 units, and long-line controls exercise beginning/middle/end edits and navigation. Input contexts, rendered rows, reads and DOM stay bounded; ordinary edits do not export the complete document. Unsupported contextual geometry stays explicitly identified. |
| Responsiveness | Repeated source- and hardware-labelled samples include semantic assertions, raw timings, background traffic and both views. Report input-handler duration separately from interaction readiness and complete action/workflow proxies. Bulk operations show progress, yield, reject stale targets and cancel without partial commits. |
| Lifecycle and package | Close/replace/dispose during work releases views, listeners, subscriptions and leases without losing owned unsaved work. The restored assets-only package exercises the pilot surface without checkout fallback. |
| Native input and accessibility | Real IME/reconversion, OS clipboard, keyboard-only and screen-reader checks have a declared support record. Unavailable checks remain unverified, and the native baseline stays available. Automation does not satisfy this device gate. |

Useful automated host evaluation may proceed while device checks are unavailable. Keep that
status separate from complete M3/native qualification, and continue independent implementation
and measurement. Do not claim production replacement readiness from synthetic composition.

For local point typing and navigation, initial targets on the recorded development runner are
p95 input-handler duration at most 16ms, interaction-ready proxy at most 100ms for normal sources
and 250ms for large sources, and complete action proxy at most 200ms/500ms respectively.
These are targets to test, not established results or physical display-latency claims. Report
bulk command totals and longest uninterrupted calls separately. Controlled service delays belong
in full workflow results and must not be hidden in handler measurements.

The timing boundaries are explicit:

1. Handler duration is elapsed time inside the adapter event handler, including the model commit
   and synchronous context refresh. It excludes `beforeinput`, native work before the handler
   and probe listeners that run after the adapter. Synchronous subscribers called by the handler
   remain inside this elapsed span. This measurement does not report process CPU time.
2. Interaction readiness starts at browser input/command dispatch and ends only after the
   expected model, selection and both rendered view revisions are current, plus scheduled
   animation frames. The editor/review proxy also waits for current working and reference panes,
   the visible reference version, caret work, scans and comparison completion. This is a readiness
   proxy, not proof of pixels reaching a display.
3. Complete action/workflow proxies include automation transport, command controls, asynchronous
   settlement and the same semantic/view readiness checks. Keep these separate from handler duration
   and record imposed service delays.

Execution order:

1. Integrate the existing comparison controller/view into both host fixtures. The controller
   already enters a review navigation state; that state must expose a usable review surface.
2. Add repeatable complete-interaction measurements and an integrated edit/review/save/conflict
   scenario, including the large document and concurrent host activity.
3. Fix reproducible pilot failures in typing, selection/navigation, history, clipboard, saving,
   review and lifecycle, using focused checks for each change.
4. At coherent pilot milestones run the broad model/browser/package/inspection checks and
   relevant editing, host, comparison and viewport measurements; archive evidence and commit
   qualified changes. Full shaping experiments are not the default implementation loop.

All runtime code remains dependency-free, core logic stays headless, and host services and
reactive libraries remain outside the editor. Keep the native baseline and bounded candidate
distinguished in every result. The ignored local roadmap retains historical research evidence;
its earlier shaping-first next steps are superseded by this pilot queue.
