# Examples

The examples show how a host combines StTropez's editor, workspace and language clients.
The root TypeScript demo is an editable application; the development pages expose smaller
fixtures and deferred services. Their compilers, React components, storage policies and
fixture protocols belong to the examples, outside the dependency-free library and NuGet assets.

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

For either host, append `?editor=candidate` to use the bounded editor. The bare route and
`?editor=native` use the whole-value textarea source baseline; their comparison working pane
uses the bounded editor. Both hosts use the shared LSP fixture provider.
The [textarea baseline](../fixtures/textarea-editor.ts) and its CSS are fixture assets, outside
the library and NuGet package. Development entrypoints inject that mount into the shared hosts;
installed consumers start the host with the public `mountTextEditor` implementation.
The development WebSocket endpoint `/lsp-fixture` is a fixture service, not an HTML page.

## TypeScript demo

Start with **Shopping cart** or **Fix a type error**. Edit the source, undo/redo, inspect
JavaScript or Problems, and open Changes to compare against the saved text. Save stores the
sample locally. The demo compiles edited TypeScript but does not execute the generated program.
The Code menu groups editing, indentation, language, folding and source-character commands.

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

- **Large file · 100,000 lines** exercises scrolling, middle-of-file editing, find and undo.
  Source and generated output both use virtualized rendering. Current text, retained colors
  and analysis status are separate presentation concerns.
- **Completion catalogue · 1,200 fields** offers real TypeScript members. Type `catalogue.`
  at the end, use Up to reach the final member, or type `item119` to narrow the list. All
  returned items are reachable; the popup renders at most 16 rows and shows position/count
  and the provider's partial-list flag.
- **Project-wide results · 1,200 uses** supplies 300 type errors and 1,201 symbol locations
  through TypeScript analysis. Problems, reference results and edit previews render 64 entries
  per page without discarding the rest. Rename applies the complete validated batch.
- **Unopened files & navigation** starts with `main.ts` registered. Definition navigation
  loads `labels.ts` or read-only `contracts.d.ts` through the host's target resolver. The custom
  `sttropez/readDocument` message reads known sample contents; it is not an LSP file-loading
  method. Renaming exported `LabelOptions` also exercises an unopened target. Save/recovery
  retain unopened editable contents and exclude read-only declarations.
- **Documentation & help links** demonstrates JSDoc, lists, code and an explicitly permitted
  handbook link. **Diagnostic details** combines a real TypeScript error with a labeled host
  warning carrying tags, help and opaque data. Related entries page in groups of 16; opaque
  provider data is neither rendered nor executed.
- **Snippets & lazy completion** adds labeled host templates to TypeScript completion. In
  `templates.ts`, Ctrl+End then Ctrl+Space offers linked fields, a choice and a final caret.
  Tab/Shift+Tab traverse fields, Alt+Up/Down select a choice, and Escape keeps inserted text
  while ending the session. Lazy resolution supplies the declaration body and import. An
  unsupported-variable item is omitted with a reason. See the [snippet subset](language-features.md#completion).
- **Project actions** adds a labeled two-file replacement fixture, a host review-note command
  and a refactor followed by a project check. Select a command, then **Run action**. A failed
  check retains the earlier edit and its undo command; another request needs a fresh capture.
  Only registered handlers with the captured sample URI/mode can run. These controls do not
  execute edited programs.
- **Host outline · indentation folding** provides nested plain-text blocks and region markers.
  **Host integrations · paste & notes** provides rule/CSV coloring, colon indentation, `#`
  comments, structured insertion and mapped source notes. Both operate without a language
  provider; their language rules and UI are host-owned.

Source folding uses the selected provider's ranges. Changes colors both snapshots and discovers
reference folds through its snapshot-bound compiler worker. The panes keep independent fold
choices; the working side retains source-view preferences. Hidden-line labels and the review hint
distinguish collapsed rows from alignment gaps. Find and explicit navigation reveal their targets.
The [folding](folding.md) and [comparison](comparison.md) pages own these library contracts.

### Provider ownership and adaptations

The [provider selector](../examples/demo/provider.ts) captures a choice when the page opens:

| Selection | Execution and transport | Availability |
| --- | --- | --- |
| `?provider=browser` | Example-owned worker, public JSON-RPC clients and TypeScript 5.9.3 language service | Default for the published/static HTML; also available locally |
| `?provider=server` | Development WebSocket bridge to typescript-language-server 5.1.3 over stdio, using TypeScript 5.9.3 | Default for development HTML; requires the development server |

The choice survives sample changes and retries; changing it requires a reload. There is no
silent provider fallback. Compiler, protocol-reference and URI packages are pinned development
dependencies. The Node bridge uses canonical file URIs from its URI library; browser-provider
files and standard libraries come from the known virtual inventory and pinned compiler catalogue.
Neither provider installs project packages or accesses arbitrary project files.

Both use the [public LSP clients](language-server.md) for negotiation, UTF-16 synchronization and
captured language requests. The [browser session](../examples/demo/language-session.ts) queues
at most 256 compiler actions and executes one per task. Cancellation removes an unstarted
request; it cannot preempt a synchronous compiler call. Queue overflow or a failed document
notification closes the session so a retry can synchronize complete current snapshots.
RPC message and request limits are independent of that queue bound.

The demo has these explicit provider adaptations:

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

The [syntax worker](../examples/demo/syntax-worker.ts) retains compiler state and versioned
snapshots. A first upload seeds the document; subsequent bounded replacement transfers commit
only when complete. Classification covers the whole source in the worker. JavaScript emission
runs only while its panel is visible; reopening requests current output without resending unchanged
source. A synchronous compiler action can finish after cancellation, but an obsolete reply cannot
replace the current presentation.

Edits retain mapped colors, the last completed output and provisionally mapped diagnostic ranges
while analysis runs. Problems labels old results **Awaiting recheck** and disables their navigation.
Deleted ranges or unavailable revision history discard placement. Syntax checks reuse unchanged
files; semantic checks cover every loaded file because a changed export can affect an importer.
The footer exposes pending/unavailable analysis. [Visible-continuity checks](testing.md#readiness-and-visible-continuity)
require the expected text and colors in addition to editor readiness.

**Language service unavailable** offers a fresh provider retry using current documents.
**Language controls unavailable** offers a separate controls retry on the connected provider.
Editing, comparison, history and local saving are usable during these failures. Switching samples
suspends the inactive provider. Closing a project cancels its work and releases its provider;
the local server also stops its owned process and removes its allocated temporary workspace.
Idle local allocations expire after two minutes.

Saved files and recovery drafts use browser-local IndexedDB. **Reset sample** restores only
that sample's original text as an undoable edit; it does not clear another sample's saved files
or drafts. A recovery notice identifies the offered files. Restore applies the draft, Download
exports it, and **Keep current files** discards that exact offered draft. A draft identical to
the saved files is cleared on reopen. Storage tokens protect against a newer peer write; peer
notifications identify the changed sample. Caret/scroll state belongs to the document view.

Unreadable saved data opens an editable sample without overwriting the stored copy; Save checks
its captured storage token. Construction and switch failures release partial owners and leave
the current project usable when one exists. Recovery disposal settles storage work before closing
the connection. The demo's storage policy is separate from the development hosts' explicit
[checkpoint workflow](#draft-checkpoints).

## Static build and deployment

```sh
npm run build:demo
npm run preview:demo
```

Open `http://127.0.0.1:4174/StTropez/`; `STTROPEZ_DEMO_PORT` changes the port. The
[preview server](../scripts/serve-demo.mjs) serves only manifest-listed static files, with no
source/backend fallback. Relative module, worker and library-data URLs support repository
subpaths. Only the root demo is published; development routes and fixture services are separate.

`build:demo` compiles the library, then the [site builder](../scripts/build-demo.mjs) resolves
example imports through compiled core, browser, protocol and CSS entries. It rejects private
library imports and checkout library-source compilation. Compiler bundles, standard-library
data and license notices belong to the site, outside the [NuGet payload](packaging.md).
The static provider needs no language backend, credentials or code-upload service; source
analysis takes place in this browser and its workers.

`npm run test:demo` runs the static-site journeys in Chromium, Firefox and WebKit. Set
`STTROPEZ_DEMO_URL` to run them against a deployed site instead of starting the preview server.
They check repository-path confinement, absence of backend/WebSocket traffic, provider retry,
editing, recovery and visible continuity. [Testing](testing.md) owns test selection and evidence policy.

The [Pages workflow](../.github/workflows/pages.yml) runs on pull requests, pushes to `master`
or `main`, and manual dispatch. It checks types, documentation and models, builds the library,
runs the Chromium owner gate, builds the static site and runs its Chromium journeys. Qualified
branch pushes/manual runs upload and deploy the site; pull requests do not deploy. Only the
deployment job receives Pages-write and identity-token permissions.

## Host workflows

Open either development host with `?editor=candidate`. The shared
[controller](../examples/hosts/controller.ts) owns two independently selected views of one source,
configuration and transfer resources, review state and deferred local services. **Finish save**,
**Deliver proposal**, **Finish run** and **Finish remote review** complete captured responses
explicitly. Reload resets simulated service state; recovery checkpoints have a separate lifetime.

### Editing, review and captured services

1. Edit **Primary source**, replace a selection and undo/redo through **Secondary source**.
   The text/history is shared while selections and scroll positions are independent. Escape
   followed by Tab/Shift+Tab leaves the editor for host controls.
2. Choose **Open source review**, edit **Comparison working source**, navigate a change and
   choose **Use baseline**. Undo restores the correction. The reference permits selection,
   copying and Find without mutation. **Link review scrolling** links vertical positions;
   **Align review rows** also inserts visual padding for unequal blocks. Neither changes text.
3. Choose **Keep draft version**, select a saved/server/draft/historical **Review version**,
   then **Finish version load**. Typing can continue during the load. **Discard reviewed changes**
   needs **Confirm reviewed discard**; later text, reference or ownership changes expire it.
4. Press Ctrl/Cmd+S in a source or its owned Find/language controls. In these hosts, the reference
   pane and its Find controls save the working source. Type while Save is pending, then choose
   **Finish save**. It acknowledges the captured revision and trims trailing whitespace in the
   canonical reply; later typing is preserved and unsaved. **Fail save** exposes retry recovery.
5. Choose **Simulate external source change**, Save and **Finish save** to produce a conflict.
   **Review remote source** / **Finish remote review** captures the remote baseline. Correct the
   working source and choose **Save reviewed source**. Its precondition is the reviewed version;
   another remote write conflicts again. A failed reviewed save retains local work for retry.
6. **Associate agent**, **Request proposal**, then **Deliver proposal**. Pending proposals make
   source read-only while forms stay independent. Correct and save the proposal. **Retry
   acknowledgement** exercises the fixture's failed first acknowledgement and successful retry.
   **Interrupt agent** restores editing. **Run captured inputs** separately captures source/form
   values; **Finish run** / **Fail run** settle that request without following later typing.
7. Edit **Configuration path**, Save it, then use **Finish configuration save** or **Fail
   configuration save**. New form edits survive an older receipt. A blank path blocks configuration
   Save and Run while source Save stays independent. External-change/review controls exercise
   the form's own version precondition. Transfer settings have an independent save owner too.
8. **Move primary view** and **Toggle views** exercise movement/remount with shared text/history
   and independent view state. A dirty temporary loaded source stays reachable through **Reopen
   loaded source**; explicit discard is tied to its captured revision. Clean unused loaded
   sources are released after their tabs, views and operations detach.

Ctrl/Cmd+F/H and F3/Shift+F3 work in an editor's owned tool region. Enter/Shift+Enter in Find
navigates; during scanning it retains the latest valid navigation intent. Reference Find offers
no replacement. Escape returns to the captured source. The [search contract](search.md) defines
capture invalidation and replacement behavior; the host chooses keyboard routing and focus.

Transfer batch size is a text field so invalid input survives editing/recovery; valid values are
decimal integers from 1 to 100,000. Each Run creates a read-only resource containing captured
source, connection and transfer identities/versions/values. Progress creates linked immutable
log resources. **Inspect Run** and current-input inspection use separate panel tabs with source
previews capped at 512 UTF-16 units; only explicit inspection/refresh updates a preview.
Run/log history lasts for the fixture session, and the fixture does not execute a transfer.

### Draft checkpoints

**Keep recovery draft** stores an explicit IndexedDB checkpoint in one application-scoped slot.
Replacing it needs confirmation. Source, configuration, transfer, temporary loaded source and
rejected input have independent restore/inspection choices; nothing is replayed automatically.
Typing during a write requires another checkpoint for the later changes. Failed storage leaves
live inputs intact and does not count as durable coverage.

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

Use `?editor=candidate` for either host. The
[generic fixture server](../fixtures/protocol/fixture-server.ts) uses LSP 3.17 over JSON-RPC 2.0
and WebSocket, UTF-16 positions, and the 3.17.5 development/test reference package. It exercises
the [supported protocol subset](language-server.md); it is separate from the real TypeScript demo.

Completion, hover, F12/Shift+F12, F2, Ctrl/Cmd+., signature, link and color controls use the shared
provider. Select an action, inspect its changes and choose **Apply captured action** or
**Execute captured action**. An unadvertised command disables its whole choice. A command's
initial edit is one undoable phase; incoming edits require **Apply captured provider edits** or
**Decline captured provider edits** in **Workspace provider**. Failure after a committed phase
retains that edit; reconnect does not replay it. Register/unregister review commands and request
workspace status through the same panel. The [language-feature contracts](language-features.md)
own request validation, edit decisions and command authority.

Both hosts construct their controller outside rendering and expose stable observable handles.
React uses pure components, subscription hooks and stable refs for editor subtrees. View bindings
retain resource-specific selection/scroll state across remounts; effects do not synchronize
application state. A failed attachment releases acquired owners in reverse order. **Recover views**
can remount after a render failure without recreating the document. Final host teardown releases
views before captured resources, then settles tracked services and storage. See
[embedding](getting-started.md) and [lifecycle ownership](architecture.md).

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

The `/editing/` fixture uses a local keyword/number/comment tokenizer,
without a worker or language server. Editing views cache up to 128 visible fragments;
this is not a full grammar or multiline lexer. Its tests cover typing, selection,
history, find and lifecycle independently of a provider.

The plain/React development hosts use the synthetic LSP peer described above. Its
scanners exercise protocol and captured-result behavior, not TypeScript semantics.
The public demo uses the real TypeScript providers described under language tools.

## Contributor responsibilities

Keep example services, compiler choices, storage schemas and fixture syntax out of runtime
modules. Use the public entry points when building the static demo or a restored-assets host.
Update this guide when routes, controls, limits or provider policy change. Select the focused
owner tests through [testing](testing.md), and check the full user-visible result as well as
model/editor readiness.

## Not covered

See the [support matrix](README.md#support-matrix) for library limits, native-device qualification
and consuming-host requirements, and the [glossary](README.md#glossary) for measurement clocks.
