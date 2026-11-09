# M3 editor and review pilot

M3 targets a usable editor/review workflow in the plain and React evaluation hosts. It does
not require a general font engine, IDE parity, deployment or application-service integration.
Further font/shaping expansion is deferred unless a reproducible pilot defect requires it.

Completion requires current evidence for each criterion below. Existing kernel and isolated
fixture results are supporting evidence; they do not replace an integrated host workflow.

| Criterion | Required behavior and evidence |
| --- | --- |
| Editing | Actual keyboard typing, single and multiple selections, word/line/grapheme/page navigation and deletion, multiline indentation, paired brackets, clipboard paths, read-only transitions and focus escape preserve exact text and selection. |
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

## Try the integrated pilot

After `npm ci` and `npm run dev`, open the
[plain host](http://127.0.0.1:4173/hosts/plain/?editor=candidate) or
[React host](http://127.0.0.1:4173/hosts/react/?editor=candidate).
Both expose the same workflow. Use `?editor=native` for the native source-input baseline;
the comparison working pane always uses the bounded candidate.

The native baseline renders whole values. Its optional weak projection cache may be rebuilt
after history navigation, causing another complete export. Native baseline export counts are
diagnostic; the pilot's zero ordinary-export gate applies to the bounded candidate. Text,
selection, history and save behavior remain checked for both adapters.

The services are local, deferred fixtures. **Finish save**, **Deliver proposal** and
**Finish remote review** explicitly complete a pending response so that you can keep typing
while it is in flight. **Finish save** trims trailing whitespace in its canonical reply.

1. In **Primary source**, type a correction, select text with Shift+Arrow and replace it.
   Check the shared text in **Secondary source**. Use Ctrl+Z and Ctrl+Shift+Z to undo and redo;
   the views share history and retain independent selections. Alt+click adds carets and Alt+drag
   adds selections. Move them with arrows or page keys, then type to replace every range together.
   Shift+click extends the primary range; Escape keeps only that range. Escape followed by Tab leaves
   the candidate editor for the surrounding host controls.
   Drag painted selected text to move the selected fragments. During the drag, hold Ctrl (Option on
   Apple platforms) to copy. Read-only sources copy. If the browser loses the internal transfer token,
   the drop is refused and source text stays intact; native token-preserving movement in the current
   WebKit evaluation environment remains unverified.
   Ctrl+F opens source find. **Match case** starts checked; clear it for Unicode caseless
   literals and combine it with **Whole word**. These choices follow the working view and
   survive remount. Replacement text is literal in this mode. Enable **Regular expression** for
   Unicode multiline patterns and numbered/named capture substitutions. Invalid patterns leave
   editing available. Search and replacement use a separate worker; limits and bulk latency remain
   explicit in [search](search.md#regular-expressions).
   Pause the pointer over a symbol, or press Ctrl+K then Ctrl+I in a candidate source view,
   to read local symbol information. The comparison working view supports the same command.
   Escape dismisses information before changing selections; typing also dismisses it.
   Pointer inspection keeps the current host focus. Results are plain text from a bounded local
   worker fixture, limited to 4,096 units of context and names up to 256 units. This does not
   qualify a general language service or screen-reader announcement behavior.
2. Choose **Open source review**. Edit the working pane, then use **Next change** and
   **Use baseline**. Undo the reversion to restore your correction. The reference stays
   immutable while the working pane shares the source document and history.
   Select several source lines and choose **Fold selected lines** (Ctrl/Cmd+Shift+[).
   The header stays visible; Arrow/Page skips the body. The other source view and comparison
   remain independent. Find, explicit selections and hunk navigation reveal hidden targets.
   **Expand all folds** (Ctrl/Cmd+Shift+]) opens the current view. Header buttons support
   Enter/Space and Escape; source Escape then Tab/Shift+Tab still exits to host controls.
   [Fold semantics and limits](folding.md) describe edits, history and remount behavior.
   Enable **Paste tables as CSV** to paste a spreadsheet/text table into the captured source
   selections. The host prefers a single HTML table, then tab-separated plain text. Conversion
   is one shared undo command; Escape or **Cancel table paste** stops pending work. Clear the
   option for literal paste. [Table paste](table-paste.md) lists formats, limits and native gaps.
   **Keep draft version** retains the current committed text. Choose a saved, server, draft or
   historical entry in **Review version**, then **Finish version load**; typing can continue while
   it loads. Selection changes the reference while Save and Run keep using the working source.
   **Discard reviewed changes** followed by **Confirm reviewed discard** restores the captured
   review as one undoable command. Later text, review or ownership changes expire that confirmation.
3. Focus a source editor and press Ctrl+S or Cmd+S. Type additional text before choosing
   **Finish save**. The captured revision is saved; later typing remains present and unsaved.
   Undo the later typing to return to the saved capture, then redo it. Use text without trailing
   whitespace for this step so the synthetic canonical reply does not alter the capture.
4. Choose **Simulate external source change**, save again and choose **Finish save**.
   The conflict notice must retain your local text. Choose **Review remote source**, then
   **Finish remote review** to compare the captured remote version. Correct the working text,
   choose **Save reviewed source**, continue typing and choose **Finish save**. The conflict
   clears after success; text typed after the capture remains unsaved. On that pending
   reviewed save, you can instead choose **Fail save**, then **Save reviewed source** and
   **Finish save** to try transport recovery without discarding local work.
5. Choose **Associate agent**, **Request proposal**, then **Deliver proposal**. The source
   is read-only while the request is pending; the configuration form remains independent.
   Correct the delivered proposal, save it and choose **Finish save**. Choose
   **Retry acknowledgement** twice: the fixture fails the first attempt and succeeds on retry.
   The next **Request proposal**
   captures your current source and configuration. **Interrupt agent** restores editing.
6. Use **Move primary view**, then **Toggle views** twice. Text, history and independent view
   state survive movement and remount. Configuration changes and background progress keep
   their own state. Reloading the page starts a new fixture; this is not durable storage.

The automated large-document workflows additionally exercise 100,000-line and long-line
sources with bounded input contexts, DOM and reads. See the
[host workflow contract](host-workflows.md) and [viewport limits](viewport.md).
The walkthrough does not qualify real IME, OS clipboard, screen readers or physical display
latency. Those checks remain unverified until a declared device/support record supplies evidence.


## Measurement boundaries

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
