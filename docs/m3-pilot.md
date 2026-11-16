# Host workflow walkthrough

The plain and React development hosts exercise deferred services and editor/review workflows.
See [testing](testing.md) for behavioral coverage, measurement policy and device checks.

## Try the integrated hosts

The root [demo workflow](demo-language.md) supplies the smaller user-facing acceptance
surface: TypeScript editing, language actions, Problems, Changes and local save/recovery.
Extended samples load on demand. **Host integrations · paste & notes** demonstrates public
configuration, token decoration, captured insertion and mapped host metadata; see the
[consumer recipe](host-integration.md). The fuller plain/React workflow below also exercises
deferred host services and their ownership rules.

After `npm ci` and `npm run dev`, open the
[plain host](http://127.0.0.1:4173/hosts/plain/?editor=candidate) or
[React host](http://127.0.0.1:4173/hosts/react/?editor=candidate).
Run the following journey in either host. The services are local, deferred fixtures:
**Finish save**, **Deliver proposal** and **Finish remote review** complete pending responses
explicitly, so you can edit while they are in flight. **Finish save** trims trailing whitespace
in its canonical reply. Reloading resets the simulated services. Explicit
[draft checkpoints](host-drafts.md) separately offer independent restore choices for unsaved inputs.

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
   Native clipboard remains unverified.
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
   Ctrl/Cmd+F/H and F3/Shift+F3 also work from any enabled control in that owned region.
   Enter/Shift+Enter in the query navigates matches. During scanning, F3/query Enter retain the
   latest requested direction and navigate once when that captured index is ready. Query/options,
   text, complete selection, focus, composition or view changes expire the request; it cannot
   move a different view or steal later focus. Replacement Enter also waits for a captured index,
   retaining its replacement text and edit authority; subsequent field input or authority changes
   expire it. A selected current match is replaced as one undoable command; otherwise it selects
   the next match. Enter on buttons retains their normal action. Reference replacement stays disabled.
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

7. Edit **Configuration path**, then press Ctrl+S/Cmd+S in that field or choose **Save
   configuration**. Continue editing either resource and running captured inputs while the
   request is pending. **Finish configuration save** acknowledges the captured value; newer
   form edits remain unsaved. **Fail configuration save** retains values for retry. A successful
   unchanged capture trims its path without discarding unknown configuration fields.
   A blank path remains visible and blocks configuration Save and Run; source Save stays independent.
   **Simulate external configuration change** followed by Save/Finish produces a conflict.
   Choose **Review remote configuration**, correct local fields, then **Save reviewed
   configuration** and finish it. A newer remote write conflicts again instead of being overwritten.
   Source text, history, complete selection sets and comparison reference remain independent.

The automated [host workflows](host-workflows.md) also cover 100,000-line and long-line sources
with bounded input contexts, reads and DOM. [Viewport limits](viewport.md) identify unsupported
geometry. Use `?editor=native` for the whole-value native source-input baseline; the comparison
working pane always uses the bounded candidate. The baseline may rebuild its weak projection
cache after history navigation. Its export counts are diagnostic; the zero ordinary-export gate
applies to the candidate. Text, history, selection and save behavior are checked for both adapters.

Real IME/reconversion, OS/app/menu clipboard and physical display latency remain
unverified without recorded device evidence. Keyboard automation and synthetic composition do
not satisfy those checks. Native token-preserving drag movement in the current WebKit evaluation
environment is also unverified; tokenless internal drops are refused without changing source text.

## Additional editing and provider tools

The hosts also offer explicit [draft checkpoints and reload recovery](host-drafts.md).
Keep a recovery draft before leaving unsaved inputs. Reload offers independent source and
configuration restore choices; neither applies automatically or restores an old undo stack.
Later edits, failed storage and unsettled input/requests keep the navigation guard active.
Actual headless browser-close checks cover dismissing confirmation without losing live work,
accepting it with explicit checkpoint recovery, and closing covered, settled inputs without a
prompt in all three engines. Native application shutdown remains unverified.

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


## Try the LSP provider route

After the same `npm ci` and `npm run dev`, open the
[plain LSP host](http://127.0.0.1:4173/hosts/plain/?editor=candidate&language=lsp) or
[React LSP host](http://127.0.0.1:4173/hosts/react/?editor=candidate&language=lsp).
This route uses actual LSP 3.17 over JSON-RPC 2.0 and WebSocket, with UTF-16 positions. The pinned
3.17.5 reference peer is a development dependency; the distributed runtime keeps zero package
dependencies. A production language provider is not required for this evaluation.

Focus a working source. Prefix typing requests completion automatically; Ctrl+Space retains
explicit invocation. Hover, F12/Shift+F12 and F2 use captured
provider hover, navigation and rename flows. Ctrl/Cmd+. opens provider action choices. Select a
choice, inspect its edits, then choose **Apply captured action**. A command choice instead shows
**Execute captured action** and its captured command name and argument count. Merely selecting a
choice never executes it. An unadvertised command disables the whole choice, including its edit.

Execution applies any initial edit as one atomic shared undo transaction and synchronizes it
before sending the command. Further provider edits appear in the existing **Workspace provider**
panel; use **Apply captured provider edits** or **Decline captured provider edits** for that batch.
Each applied phase remains separately undoable. Failure or lost acknowledgement after a commit
retains those edits; reconnect never replays either phase. A busy review lane prevents execution
before the initial edit. Later focus changes cannot retarget the captured origin or resources.

The panel also offers **Register provider review command**, **Request provider review edits** and
**Request provider workspace status** independently. Comparison baselines stay immutable, while
Save/Run keep their captured primary resource even after another changed resource is revealed.
See [action commands](language-features.md#code-actions-and-commands), [server-edit decisions](language-features.md#code-actions-and-commands) and the
[supported subset](language-server.md) for limits, cancellation and remaining protocol gaps.
[Signature help, links/resolve and color presentations](language-features.md) also use the shared
LSP provider and existing host controls. Local tokenization and domain tools remain separate fixtures.
