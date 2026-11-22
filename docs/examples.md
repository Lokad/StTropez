# Examples

Use the TypeScript demo to edit a project, inspect the emitted JavaScript and review what changed. To
try a save conflict or finish a delayed request by hand, open one of the development hosts. The
examples provide their own compiler, React components and storage.

## Use

With Node 24 or later, run:

```sh
npm ci
npm run demo
```

Open `http://127.0.0.1:4173/`. `npm run dev` starts the same loopback server and source watcher;
neither command opens a browser. `STTROPEZ_PORT` selects another port. The
[published demo](https://lokad.github.io/StTropez/) needs no local server.

Use `?sample=host` to open the paste example directly, or choose another ID from the
[sample catalogue](../examples/demo/samples.ts). An unknown ID opens Shopping cart. The
[browser IDE walkthrough](getting-started.md#add-features-to-a-browser-ide) pairs each example
with the public APIs it uses.

### Development routes

For a single feature or host workflow, open its route on the
[development server](../scripts/serve.mjs).

| Route | Purpose | Entry source |
| --- | --- | --- |
| `/` | TypeScript editing, language tools, JavaScript output, Problems, Changes and local save/recovery | [Demo](../examples/demo/main.ts) |
| `/workspace/` | Native textarea baseline with workspace resources, transactions and deferred services | [Workspace fixture](../tests/fixtures/workspace/main.ts) |
| `/editing/` | Bounded input, selections, commands and local highlighting | [Editing fixture](../examples/editing/main.ts) |
| `/viewport/` | Read-only virtualized text and geometry | [Viewport fixture](../examples/viewport/main.ts) |
| `/comparison/` | Working/reference comparison and hunk commands | [Comparison fixture](../examples/comparison/main.ts) |
| `/comparison/?mode=revisions` | Read-only comparison of two saved revisions | [Comparison fixture](../examples/comparison/main.ts) |
| `/protocol/` | JSON-RPC/WebSocket transport interoperability | [Protocol fixture](../examples/protocol/main.ts) |
| `/fonts/` | Registered-font rendering and geometry | [Font fixture](../tests/fixtures/fonts/main.ts) |
| `/hosts/plain/` | Two source views, forms, review and deferred services | [Plain host](../examples/hosts/plain-main.ts) |
| `/hosts/react/` | The same controller and workflows with React rendering | [React host](../examples/hosts/react-main.tsx) |

Append `?editor=candidate` to either host URL to try `mountTextEditor`. The bare URL and
`?editor=native` use the [textarea fixture](../fixtures/textarea-editor.ts) for the source. Comparison
always uses the bounded editor. Installed examples use `mountTextEditor`. Both development hosts use
`/lsp-fixture` for language services.

## TypeScript demo

Open **Shopping cart** or **Fix a type error**. Edit the source, inspect JavaScript or Problems,
then open Changes to compare against the saved file. Save writes to this browser. The demo compiles
TypeScript without executing it. The Code menu contains language, indentation and folding commands.
Enter and Tab follow the sample’s indentation. Choose spaces or tabs under Code → Indentation to
override it across samples, or select Sample default to switch back.

Click in **JavaScript** to select and copy the emitted code. Ctrl+A (Cmd+A on macOS) selects the
entire output, including lines outside the viewport. Edit the TypeScript pane to change the output.

The demo serves Fira Code 6.2 under the SIL Open Font License. In Shopping cart, toggle
**View → Font ligatures** to compare the arrow and comparisons in `readyToShip`. The glyphs
change while the underlying characters stay editable. The font ships with the demo.
[Font and attribution](../examples/demo/fonts/FiraCode-LICENSE.txt)

In **Shipping quotes**, enable **View → Minimap**. Locate the rate table or calculation, hover to
preview a line, then click to jump. Dragging the marker preserves the selection. The minimap also
works in generated JavaScript and both Changes panes.

In Shopping cart, open **Find** and enter `quantity:\s*(\d+)`. Choose **Use regular expression**
(`.*`) to highlight both quantities in `main.ts`. Enter and Shift+Enter navigate the matches.
Under **Replace…**, use `quantity: $1 + 1` and choose **Replace all**. Open Changes to see both
edits. One undo restores both quantities. **Match case** and **Match whole word** work with
literal text and regular expressions. The query and search options follow the active file while Find is open.
Paste multiple lines into either field, or press Ctrl/Cmd+Enter to insert a line break.
In regex replacements, `\n` starts a new line and `\\` inserts one backslash.
Opening Find picks up a selection of up to 4,096 UTF-16 units and escapes it in regex mode.
An empty or oversized selection keeps the previous query. For a selection containing carriage
returns, use regex mode to preserve the exact line endings.
Typing a query previews a match while focus stays in Find. Enter selects it. The counter shows
the active match and total, and reports when navigation wraps.
Choose **Find** after focusing generated JavaScript or the saved copy to search that pane.
The bar names the read-only target. Escape returns focus to it. Focusing the working source
while the bar is open searches the same query there and enables replacement for matches.
Ctrl/Cmd+F and Ctrl/Cmd+H open Find and Replace from the panes, Find fields and toolbar.
The bar opens below the workspace. In short windows it uses the top of the window to keep code visible.
Escape returns to the search pane. F3 and Shift+F3 continue the last query with the bar closed.

### Language tools and samples

| Action | Workflow |
| --- | --- |
| Completion | Type an identifier/member prefix, press Ctrl+Space or choose **Complete**. Arrows select; Enter, Tab or a click accepts an applicable item; Escape dismisses. |
| Type inspection | Hover over a symbol, or use **Inspect type** / Ctrl+K, Ctrl+I at the caret. A plain click keeps typing focus. Select tooltip text to copy it or follow a help link. Escape closes the tooltip and preserves the source caret. |
| Signature help | Type a provider trigger or use **Signature help** / Ctrl+Shift+Space. Argument movement updates the active parameter; overload controls choose another signature. |
| Definition and references | F12 / Shift+F12 request locations. Each result shows its file, line, column and an excerpt with the symbol highlighted. **Back to previous location** / Alt+Left restores the captured source selection and view. |
| Rename | F2 / **Rename symbol** captures the source and previews the proposed name. Changing the name requires another preview; Apply creates one shared undo command for the validated files. |
| Quick fix | Press Ctrl+. in the source or choose **Check quick fixes** on a problem. Both request actions for that range. Clicking an edit-only quick fix applies it directly if it touches only the current file, uses at most four edits and totals at most 256 replaced or inserted UTF-16 units. Broader changes require confirmation of the displayed preview. Changing choices retires its Apply action. Enter applies a ready fix. With no applicable fix, Enter inserts a newline. |
| Problems | Choose a current diagnostic to open its named file and range. Related locations expand on demand; help links require an explicit click and the demo's HTTPS TypeScript-documentation policy. |
| Occurrences | Place the caret on a symbol to shade its occurrences. Browser-provider writes also have an outline; the pinned local server reports reads for the sample's variable declarations and assignments. |

While TypeScript starts, the footer shows the last language command you requested.
It runs when the service is ready if focus and the caret are in their original positions. Editing,
moving the caret, switching panes or pressing Escape cancels the request. The footer also
reports when an explicit completion or signature request has no results.

In the references and quick-fix lists, Up and Down move the choice, including from a
focused result button. Enter in the source opens the chosen location or confirms a ready
fix. Escape from either list returns focus to the source.

The Example picker loads samples on demand. You can keep using the arrow keys while a sample
opens. The last choice appears, and returning to a sample keeps its edits. [Sample catalogue](../examples/demo/samples.ts)

- **Large file · 100,000 lines** — Scroll to the middle, edit a row, search and undo. Both source
  and output render visible rows.
- **Completion catalogue · 1,200 fields** — Type `catalogue.` and press Up for the final member,
  or type `item119` to filter. Scroll the full list and click a member to insert it. Arrow keys
  bring the keyboard choice back into view. The popup keeps up to 16 rows in the DOM and shows
  the selected member’s detail below them.
- **Project-wide results · 1,200 uses** — Browse 300 type errors and 1,201 symbol locations in
  pages of 64. Rename applies the entire validated edit.
- **Unopened files & navigation** — From `main.ts`, follow a definition into `labels.ts` or
  read-only `contracts.d.ts`. Rename `LabelOptions` to edit an unopened target. The custom
  `sttropez/readDocument` reads known sample files. Save and recovery include editable unopened
  files and exclude declarations marked read-only.
- **Documentation & help links** and **Diagnostic details** — Inspect JSDoc or a handbook link,
  then compare a compiler error and a host warning. The static provider displays JSDoc link labels
  in prose and preserves tags inside code examples. Related locations page in groups of 16. Opaque
  provider data stays hidden and is never executed.
- **Snippets & lazy completion** — In `templates.ts`, press Ctrl+End, then Ctrl+Space. Tab through
  linked fields, use Alt+Up/Down for choices and Escape to keep the text. Resolution supplies the
  declaration and import. The demo explains omitted unsupported variables. See
  [completion](language-features.md#completion).
- **Project actions** — Review a two-file edit, a note or a refactor with a project check.
  **Run action** calls only handlers registered for the captured URI and mode. If the check fails,
  the edit is undoable and a retry needs a fresh capture.
- **Host outline · indentation folding** and **Host integrations · paste & notes** — Fold nested
  regions, edit colored rules or CSV, paste a table and follow a source note. Both samples work
  without a language provider.

Three consecutive import declarations form a fold. Blank lines and comments between them do not
count toward three. A multiline import can also fold on its own. Folds hide complete body rows only.
Closing delimiters on their own line, and lines shared with the next branch, statement or comment,
stay visible.

The footer shows the caret position in the last focused editor, including generated JavaScript
and the saved copy. On narrow screens the output sits below the source. Use **Hide** to give
the editor more room, or choose **JavaScript**, **Problems** or **Changes** to open that panel.
In short windows the description and footer scroll so the source and output can each show a code row.
In the file and panel button strips, Left and Right move focus. Enter or Space opens the choice.

In **Changes**, **Hide** leaves the working file open for editing.
**Show** returns to the same review. Typing while the saved copy is hidden updates the diff,
and saving locally compares against the new saved copy. Each pane has its own syntax coloring and folds. The saved file
has its own compiler worker. The Code menu targets the last source pane you clicked or focused. Hidden-line
counts distinguish folds from alignment gaps. Find and navigation reveal hidden targets. See
[folding](folding.md) and [comparison](comparison.md).

<a id="provider-ownership-and-adaptations"></a>

### How the browser and local providers differ

Choose a provider in the URL before opening the page.
[Provider selector](../examples/demo/provider.ts)

| Selection | Execution and transport | Availability |
| --- | --- | --- |
| `?provider=browser` | Example-owned worker, public JSON-RPC clients and TypeScript 5.9.3 language service | Default for the published/static HTML; also available locally |
| `?provider=server` | Development WebSocket bridge to typescript-language-server 5.1.3 over stdio, using TypeScript 5.9.3 | Default for development HTML; requires the development server |

Reload to change providers. Sample switches and retries keep the selected provider. The Node bridge
uses canonical file URIs. The browser worker reads the sample inventory and pinned standard
libraries. Neither loads arbitrary projects or installs packages.

Both providers use the [public LSP clients](language-server.md). The
[browser session](../examples/demo/language-session.ts) queues up to 256 compiler actions and runs one
per task. Cancellation removes queued work. A running compiler call finishes synchronously. If the
queue fills or a document notification fails, Retry starts a new session with the current files.

Replace All sends edits from the end of the file toward the start. Both providers reuse the
line index across those ranges. For batches over 256 changes, the development bridge sends the
compiler one ranged replacement covering the file.

When comparing results from the two providers, keep these differences in mind.

- Both providers return standard diagnostics in a custom `sttropez/diagnostics` response. The demo
  requests syntactic and semantic diagnostics for a captured project, then checks each binding and the
  project generation before drawing markers. It does not use LSP diagnostic pull or draw current
  markers from an unversioned push. Quick fixes request fresh diagnostics for the same range and
  project.
- The local bridge drops the pinned server’s empty-title `_typescript.applyCodeActionCommand` only
  when its nested commands are missing or empty. It keeps completion data when the server replaces its
  cache key and drops edit ranges that miss the requested caret. Other values go through the public
  decoders.
- The development refactoring profile allows `_typescript.applyRefactoring` for a known project file.
  The host reviews incoming edits. Acknowledging `_typescript.rename` opens no rename dialog. The
  ordinary demo accepts no arbitrary server commands.
  [Provider policy](../examples/demo/provider-server.ts)
- Enter, comments, indentation and pairing use the demo’s TypeScript rules. For quotes and brackets,
  the host checks the classified line start and nearby text. In an uncertain multiline string, regex
  or template, it inserts the typed character literally. Display colors alone never trigger a paired
  edit.
- The browser provider keeps completion keys for the latest two lists. Navigation opens known sample
  files. Compiler library definitions stay outside the editable project. The demo does not load
  external projects, install packages or perform file operations.

### Analysis, saving and recovery

The [syntax worker](../examples/demo/syntax-worker.ts) reads the full source once and applies later
edits when their chunks arrive. It classifies the whole file. Open the JavaScript pane to request
output. Reopening it reuses unchanged source, and late replies from cancelled jobs are ignored.

After an edit, colors and diagnostic markers follow surviving text, and the last compiled output stays
visible. Problems shows **Awaiting recheck** and disables navigation. Deleted ranges or missing
revision history drop the old markers. Syntax checks reuse unchanged files. Semantic checks include
every loaded file because changing an export can break an importer. The footer shows when checks
finish. [Visible continuity](testing.md#readiness-and-visible-continuity)

Retry **Language service unavailable** to reconnect with the current files. Retry **Language
controls unavailable** to reattach controls to the connected provider. You can edit, compare, undo
and save during either failure. Switching samples suspends the inactive provider. Closing the
project releases it and, for a local server, stops its process and deletes its temporary workspace.
Idle local allocations expire after two minutes.

The demo saves the whole sample in IndexedDB, including files you haven’t opened. Saving keeps the
current tabs and selection. If you type during a save, the footer reports that the later edits
are unsaved. Save, Restore draft and Keep current files return
keyboard focus to the source editor or the last active comparison pane as soon as you activate them.
Recovery and conflict actions appear below the editor. **Reset sample** restores the open sample’s original
text in one undoable edit. You can keep typing while a recovery offer is open. The demo checkpoints
your edits alongside the offered draft. After reload, choose a version to restore or download.
Restoring one keeps the other versions available. **Keep current files** discards the offered
versions and checkpoints any unsaved current files in the same write. Reopening clears drafts identical to saved data.
If another page has saved the sample, choose **Review saved copy**. **Save my reviewed version**
writes your working files. **Use reviewed saved files** takes the other page’s version across the
sample. If any text changes, one Undo restores it. A later local edit or peer save requires a fresh review.

If a saved copy is unreadable, the demo leaves it in storage and opens the sample. Save checks the
captured token. A failed sample switch releases partial resources and keeps the open project usable.
Disposal waits for storage writes. [Development-host checkpoints](#draft-checkpoints)

## Static build and deployment

```sh
npm run build:demo
npm run preview:demo
```

Open `http://127.0.0.1:4174/StTropez/` or set `STTROPEZ_DEMO_PORT`. The
[preview server](../scripts/serve-demo.mjs) serves manifest-listed files. Relative URLs let modules,
workers and library data load below the repository path. Only the root demo is published.

`build:demo` compiles the library. The [site builder](../scripts/build-demo.mjs) resolves compiled
public entries and rejects private source imports. The site ships its compiler, standard libraries
and licenses separately from [NuGet](packaging.md). Source analysis runs locally in the browser.

`npm run test:demo` exercises the static build in Chromium, Firefox and WebKit. Set
`STTROPEZ_DEMO_URL` to check a deployed site. The tests cover asset paths, browser-only operation,
provider retry, edits, recovery and visible updates. See [testing](testing.md).

The [Pages workflow](../.github/workflows/pages.yml) checks types, docs and models, builds the
library and demo, and runs Chromium tests. Pull requests run the checks. Successful pushes to
`master` or `main` and eligible manual runs deploy. Only the deployment job receives Pages-write and
identity-token permissions.

## Host workflows

Open either host with `?editor=candidate`. Try editing the same file in two panes, changing
configuration or reviewing a saved version. The hosts share a
[controller](../examples/hosts/controller.ts). **Finish save**, **Finish run** and
**Finish remote review** let you choose when the simulated service replies. Reload resets the service.
Recovery checkpoints survive it.

### Editing, review and captured services

1. Edit **Primary source** and undo from **Secondary source**. Both views share text and history
   but keep their own selections and scroll positions. Press Escape, then Tab or Shift+Tab, to
   reach host controls.
2. **Open source review**, edit **Comparison working source** and choose **Use baseline**. Undo
   restores the edit. You can select, copy and search the reference. **Link review scrolling**
   links vertical positions. **Align review rows** pads unequal blocks.
3. **Keep draft version**, choose a saved, server, draft or historical **Review version**, then
   **Finish version load**. You can type during the load. **Discard reviewed changes** needs
   confirmation. Changing the text, reference or owner expires it.
4. Press Ctrl/Cmd+S in the source, reference or its Find/language controls. Type, then
   **Finish save**. The reply trims trailing whitespace on the captured revision. Later typing
   stays unsaved. **Fail save** lets you try recovery.
5. **Simulate external source change**, save, then **Finish save**. Choose
   **Review remote source** and **Finish remote review**. Edit the working source and
   **Save reviewed source**. A further remote write conflicts again. A failed save preserves local
   edits.
6. **Preview proposal**, then **Apply proposal** for one whole-document edit. Typing after preview
   requires a fresh preview. Correct the result in either working view, save it and
   **Finish save**. **Run captured inputs** captures source and form values separately.
   **Finish run** or **Fail run** settles that request.
7. Edit **Configuration path** and save. Use **Finish configuration save** or
   **Fail configuration save**. New form input survives an older reply. A blank path blocks
   configuration Save and Run. Source and transfer settings each have a separate save operation.
   External-change and review controls use the configuration version.
8. Try **Move primary view** and **Toggle views**. **Reopen loaded source** recovers a dirty
   temporary document. Discard checks its revision. A clean temporary source is released when its
   last tab, view and operation detach.

Ctrl/Cmd+F/H opens Find/Replace in the editor’s tool region. F3/Shift+F3 or Enter/Shift+Enter in
Find navigate. While scanning, Find keeps the latest valid navigation request. Escape returns to the
editor that opened Find. Reference Find is read-only. See [search](search.md).

Try entering a blank batch size. The transfer field keeps the raw input so it survives editing and
recovery. A valid size is a decimal integer from 1 to 100,000. Run creates a read-only record of the
source, connection and transfer inputs, including identities, versions and values. Progress adds
linked immutable log records. **Inspect Run** and current-input inspection open separate tabs. Each
source preview shows up to 512 UTF-16 units and changes only on inspection or refresh. Run and log
history last for the fixture session. The fixture records a transfer without executing it.

### Draft checkpoints

**Keep recovery draft** saves a checkpoint in one application-wide IndexedDB slot. Confirm before
replacing it. Choose which inputs or rejected edits to inspect or restore. Take another checkpoint
to cover edits made during a write. A storage failure leaves live inputs intact.

After reload, **Restore source draft**, **Restore configuration draft**, **Restore transfer
draft** and **Restore loaded-source draft** operate on the named resource or slot. Loaded-source
restore preserves an existing slot's baseline/history or uses the fixture baseline for a new
slot. Transfer restore preserves invalid raw batch input and unknown fields. A changed resource,
new save receipt or expired slot generation can invalidate a prepared restore.

Use **Inspect stored draft** for a bounded preview or **Discard stored draft** to remove the stored
copy. Discard leaves open files alone. A storage token prevents an old discard or replacement from
overwriting another page’s newer draft. Finish composition before capturing or restoring.

The [checkpoint decoder](../examples/hosts/draft-recovery.ts) reads and writes format 3. It requires
transfer data. A null loaded-source entry leaves that restore option unavailable. An unsupported
record stays in storage until you replace or discard it, with no restore choices. A draft includes
inputs and recovery context. Undo, Run and log history, simulated server state and pending requests
end with the session.

Navigation protection covers unsaved inputs without a current checkpoint, pending input and
unsettled services. Settled covered inputs need no prompt. View remounts retain the recovery
owner; final disposal settles storage and releases observers. Input-conflict recovery retains
attempted text separately, with inspection limited to 4,096 characters, without automatic
source replacement. See [host recovery ownership](host-integration.md#input-conflict-recovery).

### LSP fixture and host lifecycle

Both hosts use the [generic fixture server](../fixtures/protocol/fixture-server.ts) for the
[LSP subset](language-server.md). It speaks LSP 3.17 over WebSocket with JSON-RPC 2.0 and UTF-16
positions. The development and test reference package is version 3.17.5.

Completion, hover, F12/Shift+F12, F2, Ctrl/Cmd+., signature help, links and colors use the shared
provider. Select an action and review it before choosing **Apply captured action** or
**Execute captured action**. If its command was never advertised, the whole choice is disabled.
In **Action module**, Enter requests a preview for the source and Escape dismisses it
and returns focus to that editor.

An action’s initial edit gets its own undo step. For later edits, open **Workspace provider** and
choose **Apply captured provider edits** or **Decline captured provider edits**. If the command then
fails, the initial edit stays in history. Reconnect leaves it there. The same panel lets you register
and unregister review commands and request workspace status.
[Code actions and commands](language-features.md#code-actions-and-commands)

Remounting keeps selection and scroll by resource. React uses stable controller observables and refs.
A failed mount unwinds in reverse order. After a render failure, choose **Recover views** to reopen
the retained document. Closing the host releases views, captures, services and storage in that order.
[Embedding](getting-started.md) · [Ownership](architecture.md)

## Serverless host examples

These examples use the public [host integration hooks](host-integration.md). Their syntax,
converters and forms are application policies, independent of the language provider.

### Table conversion

Enable **Paste tables as CSV** in a development host. In the demo, open
**Host integrations · paste & notes**, then **Code → Paste format**. Choose **Insert example table**
to try it without reading the clipboard. Conversion starts off. When enabled, it uses an HTML table if
present, otherwise TSV. The same quoted CSV replaces every captured selection in one undo step.
Escape, **Cancel table paste** or another paste cancels unfinished conversion.

Every CSV cell is quoted, with doubled internal quotes and CRLF between records. TSV can contain
quoted multiline cells. HTML parsing keeps text, character references and basic line and paragraph
breaks. It skips scripts, styles, templates and embedded documents and never mounts parsed nodes. A
merged cell’s text goes in its upper-left corner. Row spans stay in their group. Nested or multiple
tables, overlapping spans and ragged rows reject the whole paste.

| Table fixture limit | Maximum |
| --- | --- |
| Plain text / HTML | 1,048,576 / 262,144 UTF-16 units |
| Rows / columns / cells | 10,000 / 1,024 / 100,000 |
| Aggregate inserted text / resulting source | 4,194,304 / 33,554,432 UTF-16 units |

### Source-backed transfer form

In either development host, place the caret on a line such as:

```text
// @transfer { "destination": "target.csv", "batchSize": "1000", "extra": { "n": -0 } }
```

Choose **Anchor instruction at caret**, or **Insert transfer instruction** to add an example.
The form accepts one JSON object on a physical line of at most 4,096 UTF-16 units. Destination
and batch size are strings. Invalid JSON, duplicate known fields or oversized lines suspend
form editing; missing/invalid field values stay editable.

Change a field, then undo from the source editor. Each field edit replaces just the known value.
Unknown members, number spelling, whitespace, order and unchanged escapes survive. Ctrl/Cmd+S saves
the source, and Escape returns focus to it. The form follows its rendered row, hides when that row is
folded or offscreen and suspends in a narrow layout. Field values and selections survive a remount.
Stale input goes to recovery.

Choose **Capture instruction copy**, edit the source, then **Finish instruction copy**. The copy uses
the captured values and checks the transfer resource’s revision, save state and permissions. Editing
the destination in the meantime expires the copy. Unknown transfer fields survive. Save and Run are
separate controls. [Source-backed forms](host-integration.md#tokenization-annotations-and-forms)

### Domain regions and imports

**Discover domain regions**, **Collapse domain regions** and **Insert catalogue import** work
from source or comparison working views. The [local cooperative provider](../fixtures/language/domain.ts)
recognizes `// #region stable-id Label` paired with `// #endregion stable-id`. Identities are unique,
nested pairs must match, and labels are literal text. Discovery publishes view folds and notes
without source/history edits. Imports add `import "catalogue";` after a leading BOM, preserving
the first LF/CRLF ending (LF when absent); an exact existing import is a no-op.

Each scan turn reads up to 16,384 UTF-16 units and keeps a 512-unit line prefix. Limits are 4,096
regions, 128 nesting levels, 256-unit labels and 65,536 units of reply text. The panel and visible
annotations show up to 64 indexed entries plus the total. Refresh keeps collapse choices and
independent manual folds. Conflicting ranges reject the entire refresh. Change a provider fold’s
bounds to make it manual. Text edits map folds and clear stale notes. An import adds one shared undo
step.

## Server-free editing fixtures

`/editing/` colors keywords, numbers and comments with a local tokenizer. It caches up to 128
visible fragments. Its typing, selection, history and Find tests run without a language server.

Use the development hosts for the synthetic provider or the [root demo](#typescript-demo) for
TypeScript.

## Contributor responsibilities

Keep compilers, storage and fixture syntax in the examples. Build static and restored hosts against
public entries. Update affected routes, controls and limits here and run their [tests](testing.md).

## Not covered

See the [support matrix](README.md#support-matrix) for library and device coverage and the
[glossary](README.md#glossary) for timing definitions.
