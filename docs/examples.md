# Examples

The TypeScript demo lets you edit, compare and save a project. Smaller development fixtures expose
individual editor features and service calls you can finish by hand. The examples supply their own
compiler, React components and storage policies.

## Use

With Node 24 or later, run:

```sh
npm ci
npm run demo
```

Open `http://127.0.0.1:4173/`. `npm run dev` starts the same loopback server and source watcher;
neither command opens a browser. `STTROPEZ_PORT` selects another port. The
[published demo](https://lokad.github.io/StTropez/) needs no local server.

### Development routes

The [development server](../scripts/serve.mjs) serves these pages:

| Route | Purpose | Entry source |
| --- | --- | --- |
| `/` | TypeScript editing, language tools, JavaScript output, Problems, Changes and local save/recovery | [Demo](../examples/demo/main.ts) |
| `/workspace/` | Native textarea baseline with workspace resources, transactions and deferred services | [Workspace fixture](../tests/fixtures/workspace/main.ts) |
| `/editing/` | Bounded input, selections, commands and local highlighting | [Editing fixture](../examples/editing/main.ts) |
| `/viewport/` | Read-only virtualized text and geometry | [Viewport fixture](../examples/viewport/main.ts) |
| `/comparison/` | Working/reference comparison and hunk commands | [Comparison fixture](../examples/comparison/main.ts) |
| `/protocol/` | JSON-RPC/WebSocket transport interoperability | [Protocol fixture](../examples/protocol/main.ts) |
| `/fonts/` | Registered-font rendering and geometry | [Font fixture](../tests/fixtures/fonts/main.ts) |
| `/hosts/plain/` | Two source views, forms, review and deferred services | [Plain host](../examples/hosts/plain-main.ts) |
| `/hosts/react/` | The same controller and workflows with React rendering | [React host](../examples/hosts/react-main.tsx) |

For either host, use `?editor=candidate` for the bounded editor. The bare URL and `?editor=native`
use the [textarea baseline](../fixtures/textarea-editor.ts) for source and the bounded editor for
comparison. The textarea and its CSS are development fixtures. Installed examples use
`mountTextEditor`. Both hosts connect to the LSP fixture at `/lsp-fixture`.

## TypeScript demo

Open **Shopping cart** or **Fix a type error**. Edit the source, inspect JavaScript or Problems,
then open Changes to compare against the saved file. Save writes to this browser. The demo compiles
TypeScript without executing it. The Code menu contains language, indentation and folding commands.

In **Shipping quotes**, enable **View → Minimap**. Locate the rate table or calculation, hover to
preview a line, then click to jump. Dragging the marker preserves the selection. The minimap also
works in generated JavaScript and both Changes panes.

In Shopping cart, open **Find** and enter `quantity:\s*(\d+)`. Choose **Use regular expression**
(`.*`) to highlight both quantities in `main.ts`. Enter and Shift+Enter navigate the matches.
Under **Replace…**, use `quantity: $1 + 1` and choose **Replace all**. Open Changes to see both
edits. One undo restores both quantities. The query and mode follow the active file while Find is open.

### Language tools and samples

| Action | Workflow |
| --- | --- |
| Completion | Type an identifier/member prefix, press Ctrl+Space or choose **Complete**. Arrows select; Enter, Tab or a click accepts an applicable item; Escape dismisses. |
| Type inspection | Hover over a symbol, or use **Inspect type** / Ctrl+K, Ctrl+I at the caret. Documentation preserves plaintext, code and the supported Markdown structure. |
| Signature help | Type a provider trigger or use **Signature help** / Ctrl+Shift+Space. Argument movement updates the active parameter; overload controls choose another signature. |
| Definition and references | F12 / Shift+F12 request locations. Choose a result explicitly when there are several. **Back to previous location** / Alt+Left restores the captured source selection and view. |
| Rename | F2 / **Rename symbol** captures the source and previews the proposed name. Changing the name requires another preview; Apply creates one shared undo command for the validated files. |
| Quick fix | Ctrl+. / **Quick fix** requests actions for the captured range. An explicit click directly applies an edit-only quickfix confined to the current file with at most four edits and 256 replaced/inserted UTF-16 units. Broader choices require preview and confirmation. Arrow selection or receipt of a result applies nothing. |
| Problems | Choose a current diagnostic to open its named file and range. Related locations expand on demand; help links require an explicit click and the demo's HTTPS TypeScript-documentation policy. |
| Occurrences | Place the caret on a symbol to shade its occurrences. Browser-provider writes also have an outline; the pinned local server reports reads for the sample's variable declarations and assignments. |

The [sample catalogue](../examples/demo/samples.ts) loads the larger cases on demand:

- **Large file · 100,000 lines** — Scroll to the middle, edit a row, search and undo. Both source
  and output render visible rows.
- **Completion catalogue · 1,200 fields** — Type `catalogue.` and press Up for the final member,
  or type `item119` to filter. The popup shows up to 16 rows, your position, the total and whether
  the provider returned a partial list.
- **Project-wide results · 1,200 uses** — Browse 300 type errors and 1,201 symbol locations in
  pages of 64. Rename applies the entire validated edit.
- **Unopened files & navigation** — From `main.ts`, follow a definition into `labels.ts` or
  read-only `contracts.d.ts`. Rename `LabelOptions` to edit an unopened target. The custom
  `sttropez/readDocument` reads known sample files. Save and recovery include editable unopened
  files and exclude declarations marked read-only.
- **Documentation & help links** and **Diagnostic details** — Inspect JSDoc or a handbook link,
  then compare a compiler error and a host warning. Related locations page in groups of 16. Opaque
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

In **Changes**, each pane has its own syntax coloring and folds. The saved file has its own
compiler worker. The Code menu targets the last source pane you clicked or focused. Hidden-line
counts distinguish folds from alignment gaps. Find and navigation reveal hidden targets. See
[folding](folding.md) and [comparison](comparison.md).

### Provider ownership and adaptations

The [provider selector](../examples/demo/provider.ts) captures a choice when the page opens:

| Selection | Execution and transport | Availability |
| --- | --- | --- |
| `?provider=browser` | Example-owned worker, public JSON-RPC clients and TypeScript 5.9.3 language service | Default for the published/static HTML; also available locally |
| `?provider=server` | Development WebSocket bridge to typescript-language-server 5.1.3 over stdio, using TypeScript 5.9.3 | Default for development HTML; requires the development server |

Reload to change providers. Sample switches and retries keep the selected provider. The Node bridge
uses canonical file URIs. The browser worker reads the sample inventory and pinned standard
libraries. Neither loads arbitrary projects or installs packages.

Both providers use the [public LSP clients](language-server.md). The
[browser session](../examples/demo/language-session.ts) queues up to 256 compiler actions and runs
one per task. Cancellation can remove a queued action. A running compiler call completes
synchronously. Queue overflow or a failed document notification closes the session so Retry can
synchronize the current files.

The demo adapts the providers in five places.

- Unversioned pushed diagnostics do not become current source annotations. The custom
  `sttropez/diagnostics` request obtains syntactic and semantic results for a captured project.
  The host validates every binding and the project generation before publication. Both providers
  return standard diagnostic shapes inside that custom response. This is not standard diagnostic
  pull support. Quick fixes obtain fresh diagnostic context for the same captured range/project.
- The local bridge removes the pinned server's empty-title `_typescript.applyCodeActionCommand`
  only when its nested command list is absent or empty. It preserves completion resolution data
  across the server's cache-key replacement and excludes edit ranges that do not contain the
  requested caret. Other values pass through the public decoders.
- A development-only refactoring profile enables `_typescript.applyRefactoring` for a known
  project file and uses captured host review for incoming edits. Its `_typescript.rename`
  acknowledgement is not a rename-dialog workflow. The ordinary demo does not grant arbitrary
  server commands. The [provider server](../examples/demo/provider-server.ts) owns this policy.
- TypeScript Enter, comments, indentation and quote/bracket pairing are host rules. Pairing
  uses classified line starts and bounded local context; uncertain multiline/regex/template
  context falls back to literal input. Provisional display colors do not authorize lexical edits.
- Browser completion resolution retains keys for the current and preceding response only.
  Navigation is confined to known sample files; compiler library definitions do not open as
  editable resources. File operations, package acquisition and external projects are outside
  this demo's inventory policy.

### Analysis, saving and recovery

The [syntax worker](../examples/demo/syntax-worker.ts) receives the full source once, then applies
each change after all its chunks arrive. It classifies the whole file and emits JavaScript only
while the output pane is open. Reopening the pane reuses unchanged source. The view discards replies
to cancelled jobs.

While analysis runs, the editor maps existing colors and diagnostics through edits and keeps the
last compiled output. Problems shows **Awaiting recheck** and disables navigation. It drops
placements for deleted ranges or gaps in revision history. Syntax checks reuse unchanged files.
Semantic checks cover every loaded file because an export can change an importer. The footer shows
analysis status. See [visible continuity](testing.md#readiness-and-visible-continuity).

Retry **Language service unavailable** to reconnect with the current files. Retry **Language
controls unavailable** to reattach controls to the connected provider. You can edit, compare, undo
and save during either failure. Switching samples suspends the inactive provider. Closing the
project releases it and, for a local server, stops its process and deletes its temporary workspace.
Idle local allocations expire after two minutes.

The demo saves files and drafts in IndexedDB. **Reset sample** restores the open sample’s original
text in one undoable edit. Recovery names the draft’s files. Restore applies it, Download exports it
and **Keep current files** discards that draft. Reopening clears drafts identical to saved data.
Storage tokens guard against overwriting a peer’s changes. Notifications name the affected sample.

An unreadable saved copy stays in storage while the sample opens for editing. Save checks the
captured token. A failed switch releases partial resources and keeps the open project usable.
Disposal waits for storage work to finish. Development hosts have a separate
[checkpoint workflow](#draft-checkpoints).

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

Open either development host with `?editor=candidate`. The shared
[controller](../examples/hosts/controller.ts) owns two independently selected views of one source,
configuration and transfer resources, review state and deferred local services. **Finish save**,
**Finish run** and **Finish remote review** complete captured responses
explicitly. Reload resets simulated service state; recovery checkpoints have a separate lifetime.

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

Transfer batch size is a text field so invalid input survives editing/recovery; valid values are
decimal integers from 1 to 100,000. Each Run creates a read-only resource containing captured
source, connection and transfer identities/versions/values. Progress creates linked immutable
log resources. **Inspect Run** and current-input inspection use separate panel tabs with source
previews capped at 512 UTF-16 units; only explicit inspection/refresh updates a preview.
Run/log history lasts for the fixture session, and the fixture does not execute a transfer.

### Draft checkpoints

**Keep recovery draft** saves a checkpoint in one application-wide IndexedDB slot. Confirm before
replacing it. Choose which inputs or rejected edits to inspect or restore. Take another checkpoint
to cover edits made during a write. A storage failure leaves live inputs intact.

After reload, **Restore source draft**, **Restore configuration draft**, **Restore transfer
draft** and **Restore loaded-source draft** operate on the named resource or slot. Loaded-source
restore preserves an existing slot's baseline/history or uses the fixture baseline for a new
slot. Transfer restore preserves invalid raw batch input and unknown fields. A changed resource,
new save receipt or expired slot generation can invalidate a prepared restore.

**Inspect stored draft** shows bounded previews; **Discard stored draft** changes storage only.
Stored-copy tokens guard replacement/discard against peer writes. Uncommitted composition
blocks capture and restore. The [checkpoint decoder](../examples/hosts/draft-recovery.ts) writes
and reads format 3. Transfer data is required; a null loaded-source entry disables loaded-source
restore. Unsupported records offer no restore choices and leave live inputs and the stored copy
unchanged until an explicit replacement or discard.
Records contain inputs and recovery context, not old-session undo, Run/log history, synthetic
server state or pending requests.

Navigation protection covers unsaved inputs without a current checkpoint, pending input and
unsettled services. Settled covered inputs need no prompt. View remounts retain the recovery
owner; final disposal settles storage and releases observers. Input-conflict recovery retains
attempted text separately, with inspection limited to 4,096 characters, without automatic
source replacement. See [host recovery ownership](host-integration.md#input-conflict-recovery).

### LSP fixture and host lifecycle

Both hosts use the [generic fixture server](../fixtures/protocol/fixture-server.ts) for the
[LSP subset](language-server.md). It speaks LSP 3.17 over WebSocket with JSON-RPC 2.0 and UTF-16
positions. The development and test reference package is version 3.17.5.

Completion, hover, F12/Shift+F12, F2, Ctrl/Cmd+., signature, link and color controls use the shared
provider. Select an action, inspect its changes and choose **Apply captured action** or
**Execute captured action**. An unadvertised command disables its whole choice. A command's
initial edit is one undoable phase; incoming edits require **Apply captured provider edits** or
**Decline captured provider edits** in **Workspace provider**. Failure after a committed phase
retains that edit; reconnect does not replay it. Register/unregister review commands and request
workspace status through the same panel. The [language-feature contracts](language-features.md)
own request validation, edit decisions and command authority.

Both hosts retain selection and scroll by resource across remounts. React reads stable controller
observables and mounts editors through stable refs. Failed mounts unwind in reverse order. **Recover
views** reopens a view on the retained document after a render failure. Teardown releases views,
captured resources, services and storage in that order. See [embedding](getting-started.md) and
[ownership](architecture.md).

## Serverless host examples

These examples use the public [host integration hooks](host-integration.md). Their syntax,
converters and forms are application policies, independent of the language provider.

### Table conversion

Enable **Paste tables as CSV** in a development host. The root demo's **Host integrations ·
paste & notes** sample exposes **Code → Paste format** and **Insert example table**, which does
not read the OS clipboard. Conversion is off by default. It prefers one HTML table and uses
TSV when HTML has no table, inserting the same quoted CSV at every captured selection as one
undoable command. **Cancel table paste**, Escape or another paste cancels pending conversion.

The converter quotes all cells, doubles internal quotes and emits CRLF record separators.
TSV accepts quoted multiline cells. Detached inert HTML parsing retains text, character
references and basic line/paragraph breaks while omitting scripts, styles, templates and embedded
documents. Merged cells put text in the upper-left anchor; row spans stay within their group.
Nested/multiple tables, overlapping spans and ragged rows fail without partial insertion.
Parsed nodes are never mounted.

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

Field edits patch known value spans without reserializing unknown members, number spelling,
whitespace, ordering or unchanged escapes. The source's shared history owns these edits;
Ctrl/Cmd+S saves source and Escape returns to its editor. The sibling form lane follows rendered
row geometry, hides for folded/unrendered rows and suspends in narrow layouts. Values and field
selections survive remounts. Stale field input goes to recovery.

**Capture instruction copy** then **Finish instruction copy** copies captured known values into
the separate transfer resource under its revision/save/authority guards. Later source typing
does not retarget it; later transfer edits expire it. Unknown transfer fields survive. Copying
does not invoke Save or Run. See the [form extension pattern](host-integration.md#tokenization-annotations-and-forms).

### Domain regions and imports

**Discover domain regions**, **Collapse domain regions** and **Insert catalogue import** work
from source or comparison working views. The [local cooperative provider](../fixtures/language/domain.ts)
recognizes `// #region stable-id Label` paired with `// #endregion stable-id`. Identities are unique,
nested pairs must match, and labels are literal text. Discovery publishes view folds and notes
without source/history edits. Imports add `import "catalogue";` after a leading BOM, preserving
the first LF/CRLF ending (LF when absent); an exact existing import is a no-op.

Each scan turn reads at most 16,384 UTF-16 units, retains a 512-unit line prefix and permits
4,096 regions, 128 nesting levels, 256-unit labels and 65,536 units of reply text. The host's
interval index limits visible annotations and the panel to 64 entries while reporting the total.
Provider folds preserve collapse choices and independent manual regions; conflicting topology
rejects a refresh atomically. Manually changing a provider fold's bounds relinquishes ownership.
Text edits map folds and clear stale notes. Imports use one captured shared undo command.

## Server-free editing fixtures

`/editing/` colors keywords, numbers and comments with a local tokenizer. It caches up to 128
visible fragments. Its typing, selection, history and Find tests run without a language server.

For the synthetic provider, use the plain or React hosts. For TypeScript semantics, use the
[root demo](#typescript-demo).

## Contributor responsibilities

Keep compilers, storage and fixture syntax in the examples. Build the static and restored-asset
hosts against the public entries. When a route, control or limit changes, update this guide and run
its [owner tests](testing.md).

## Not covered

See the [support matrix](README.md#support-matrix) for library limits, native-device qualification
and consuming-host requirements, and the [glossary](README.md#glossary) for measurement clocks.
