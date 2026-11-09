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
Run the following journey in either host. The services are local, deferred fixtures:
**Finish save**, **Deliver proposal** and **Finish remote review** complete pending responses
explicitly, so you can edit while they are in flight. **Finish save** trims trailing whitespace
in its canonical reply. Reloading starts a new fixture; this is not durable storage.

1. In **Primary source**, type a correction. Select text with Shift+Arrow and replace it;
   move by word, line and page. Check the same text in **Secondary source**. Use Ctrl+Z and
   Ctrl+Shift+Z to undo and redo through either view. The views share history and keep independent
   selections. Escape followed by Tab or Shift+Tab leaves the candidate for host controls.
2. Choose **Open source review**. Edit **Comparison working source**, choose **Next change**,
   then **Use baseline**. Undo the reversion to restore your correction. The reference stays
   immutable while the working pane shares source text and history. Focus **Comparison baseline
   source** to navigate, select and copy reference ranges; Ctrl+A selects its complete source even
   when only a small window is painted. Typing/cut/paste cannot alter it. Ctrl+S there still captures
   the working source in these evaluation hosts. Ctrl+F searches the reference source, F3/Shift+F3
   navigates matches, and Escape returns to that input. Ctrl+H opens the same read-only Find field;
   replacement is unavailable there. Refresh cancels the old Find scope; a fresh query targets the
   current reference while Find remains there. After a compatible host remount, a fresh query in
   **Find source** keeps its working/reference context; remount starts no old search or provider
   request and moves no focus. A replaced target requires choosing its source again.
   Native clipboard and accessibility remain unverified.
   Enable **Link review scrolling** to follow corresponding vertical positions in either pane;
   clear it for independent scrolling. Selections, horizontal offsets and reference identity stay
   independent. Enable **Align review rows** to add empty padding beside unequal changed blocks;
   it also enables linking. Clear alignment to return to source-only rows. Padding never edits the
   source or expands a fold; arrows skip it and Page commands follow the shared visual grid.
   [Comparison policy](comparison.md) describes changed-block, fold and endpoint limits.
   **Keep draft version** captures the committed text. Choose a saved, server, draft or historical
   entry in **Review version**, then **Finish version load**. Typing may continue during the load;
   Save and Run keep targeting the working source. **Discard reviewed changes** followed by
   **Confirm reviewed discard** is one undoable command. Later text, review or ownership changes
   expire the confirmation.
3. Focus a source editor or a control in its owned language/Find tools (text fields, options or
   navigation buttons) and press Ctrl+S or Cmd+S. Reference Find saves the working source.
   Escape from any enabled owned tool control cancels Find and returns to its captured source,
   preserving complete selections and history. The focused Save control keeps focus; held-key repeats
   do not enqueue additional saves. Type additional source text before choosing
   **Finish save**. The captured revision is saved; later typing remains present and unsaved.
   Undo the later typing to return to the saved capture, then redo it. Use text without trailing
   whitespace for this step so the canonical reply does not alter the capture.
4. Choose **Simulate external source change**, save again and choose **Finish save**.
   The conflict notice retains local text. Choose **Review remote source**, then **Finish remote
   review**. Correct the working text, choose **Save reviewed source**, continue typing and choose
   **Finish save**. The conflict clears; text typed after the capture remains unsaved. To exercise
   transport recovery instead, choose **Fail save** while the reviewed save is pending, then
   **Save reviewed source** and **Finish save**. Local work stays intact.
5. Choose **Associate agent**, **Request proposal**, then **Deliver proposal**. While the request
   is pending, the source is read-only and the configuration form remains independent. Correct
   the proposal, save it and choose **Finish save**. Choose **Retry acknowledgement** twice: the
   first attempt fails and the retry succeeds. The next **Request proposal** captures the current
   source and configuration. Choose **Interrupt agent** to restore editing before continuing.
6. Edit the configuration form and choose **Run captured inputs**. Continue typing while the
   run is pending; Run retains the submitted source and configuration. Choose **Finish run**
   to settle it, or **Fail run** to exercise recovery. Saving does not run them.
   Use **Move primary view**, then **Toggle views** twice. Text, history and independent view state
   survive movement and remount while configuration and background progress keep their own state.

The automated [host workflows](host-workflows.md) also cover 100,000-line and long-line sources
with bounded input contexts, reads and DOM. [Viewport limits](viewport.md) identify unsupported
geometry. Use `?editor=native` for the whole-value native source-input baseline; the comparison
working pane always uses the bounded candidate. The baseline may rebuild its weak projection
cache after history navigation. Its export counts are diagnostic; the zero ordinary-export gate
applies to the candidate. Text, history, selection and save behavior are checked for both adapters.

Real IME/reconversion, OS/app/menu clipboard, NVDA/Narrator and physical display latency remain
unverified without recorded device evidence. Keyboard automation and synthetic composition do
not satisfy those checks. Native token-preserving drag movement in the current WebKit evaluation
environment is also unverified; tokenless internal drops are refused without changing source text.

## Additional editing and provider tools

These tools share the pilot's captured identities, history and review. Their detailed policy
documents define supported syntax, bounds and remaining semantic/native qualification gaps.

- Alt+click adds carets and Alt+drag adds selections. Shift+click extends the primary range;
  Escape keeps that range. Arrow/page movement and typing apply to the complete selection set.
  Drag selected text to move it; hold Ctrl (Option on Apple platforms) to copy. Read-only sources
  copy. [Editing and transfer policy](editing-candidate.md) describes capture and refusal behavior.
- Ctrl+F opens find. **Match case**, **Whole word** and **Regular expression** select the
  [search policy](search.md); regex replacement supports numbered/named captures. Invalid patterns
  leave editing available. The worker's limits and bulk latency remain explicit.
- **Fold selected lines** (Ctrl/Cmd+Shift+[) and **Expand all folds** (Ctrl/Cmd+Shift+]) affect the
  current view. Arrow/page movement skips the body; explicit selections/find/hunks reveal targets.
  [Folding](folding.md) records history and remount behavior.
- **Paste tables as CSV** enables one undoable captured conversion, preferring one HTML table and
  then tab-separated plain text. Escape or **Cancel table paste** cancels pending work. Clear the
  option for literal paste. See [table formats and native gaps](table-paste.md).
- Pause over a symbol or press Ctrl+K then Ctrl+I for [hover information](providers.md). Type `lookup(`,
  `format(` or `café(`, or press Ctrl/Cmd+Shift+Space, for [signature help](signature-help.md).
  **Previous signature** / **Next signature** select overloads. Escape dismisses information.
- F12 / Shift+F12 or **Find definition** / **Find references** use the actual local worker.
  **Add navigation companion** supplies an unmounted resource; **Return to navigation origin**
  restores complete selections. [Navigation policy](provider-navigation.md) describes the bounded
  lexical fixture, captured reveal and disconnect/reconnect behavior.
- F2 opens the [rename preview](rename.md). Enter **New identifier**, inspect captured targets and
  choose **Apply captured rename**. Ctrl/Cmd+. opens a [module-import action](code-actions.md):
  edit **Action module**, press Enter to refresh and choose **Apply captured action** explicitly.
  One undo in a participating resource reverses a batch; later corrections remain separate.
- **Add module companion**, then discover an exact `import "sample-utils";` line with F4 or
  **Discover module links**. Tab/Enter activates a resolved result; Shift+F4 returns to its captured
  origin. [Module links](document-links.md) use explicit host routes and reject URI execution.
- F6 or **Discover document colors** finds supported literal colors. Inspect a result, type a
  **Proposed color**, choose **Preview color presentations**, then **Apply captured color**.
  Enter in the field previews; application requires separate confirmation. [Color policy](document-colors.md)
  records exact alpha, validated edits and supported literal syntax.
- **Discover domain regions**, **Collapse domain regions** and **Insert catalogue import** exercise
  [host domain tools](domain.md). Under **Workspace provider**, register the local review command
  and request its captured edits. [Server-edit policy](server-edits.md) covers whole-batch validation,
  participating undo, explicit affected-resource reveal and acknowledgement/reconnect behavior.


## Measurement boundaries

For local point typing and navigation, initial targets on the recorded development runner are
p95 input-handler duration at most 16ms, interaction-ready proxy at most 100ms for normal sources
and 250ms for large sources, and complete action proxy at most 200ms/500ms respectively.
These are targets to test, not established results or physical display-latency claims. Report
bulk command totals and longest uninterrupted calls separately. Controlled service delays belong
in full workflow results and must not be hidden in handler measurements.

The timing boundaries are explicit:

1. Handler duration is elapsed time inside a named adapter listener, such as `beforeinput`,
   `input` or `keydown`. Include its model commit, context refresh and synchronous subscribers.
   Exclude other listeners, preceding native work and queued callbacks; report those clocks
   separately. A cancelled `beforeinput` has no new `input` sample. Handler elapsed time is
   neither complete interaction latency nor process CPU time.
2. Interaction readiness starts at browser input/command dispatch and ends only after the
   expected model, selection and both rendered view revisions are current, plus scheduled
   animation frames. The editor/review proxy also waits for current working and reference panes,
   the visible reference version, caret work, scans and comparison completion. This is a readiness
   proxy, not proof of pixels reaching a display.
3. Complete action/workflow proxies include automation transport, command controls, asynchronous
   settlement and the same semantic/view readiness checks. Keep these separate from handler duration
   and record imposed service delays.

Delivery order:

1. Fix reproduced pilot defects in typing, selection/navigation, history, saving, review and
   lifecycle with focused regressions. Comparison and the integrated workflows above are already
   implemented; use their existing scenarios before adding coverage.
2. At coherent milestones, batch the relevant model/browser/package/inspection checks and bounded
   measurements. Reuse passing source-labelled evidence for unchanged paths and commit qualified
   work. Benchmark tooling supports delivery; it is not an independent expansion queue.
3. Keep historical timing failures and unresolved attribution explicit. Rerun or trace them only
   for a new hypothesis with a bounded experiment. Separate own-listener, complete readiness and
   workflow clocks; a larger correctness timeout does not qualify latency.
4. Obtain native-device/accessibility evidence when available and continue independent work
   meanwhile. Further font/shaping expansion requires a reproduced pilot defect.

All runtime code remains dependency-free, core logic stays headless, and host services and
reactive libraries remain outside the editor. Keep the native baseline and bounded candidate
distinguished in every result. The ignored local roadmap retains historical research evidence;
its earlier shaping-first next steps are superseded by this pilot queue.
