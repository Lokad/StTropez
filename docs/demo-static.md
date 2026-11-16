# Static TypeScript demo

The public demo is built for GitHub Pages at <https://lokad.github.io/StTropez/>. It uses the
same editor, workspace, history, comparison and LSP clients as the local example. All changes
for static hosting belong to the example, tests and build/deployment tooling. The library in
`src/`, its public APIs, runtime dependencies and NuGet contents are unchanged.

## Host boundary

The page selects its example-owned connection factory at runtime. The published HTML defaults
to `browser`; the development HTML defaults to `server`. Append `?provider=browser` to the local
demo URL to run the published provider without starting a server project. `?provider=server`
selects the local WebSocket service and requires the development server. The choice is captured
when the page opens and retained across sample switches and retries; changing it requires a reload.
There is no build-time provider substitution or silent fallback between providers.

The browser factory owns a Web Worker and supplies the existing public `RpcTransport` interface to `LspWorkspace`.
The worker uses the public `JsonRpcConnection` for framing, request ownership and cancellation,
and TypeScript 5.9.3's language service for actual language intelligence. The local development
server continues to use the existing TypeScript language server over WebSocket/stdio.
Both builds use the same pinned standard-library catalogue for the browser worker. Static hosting
includes the small server connection factory, but opening the published page never calls it by default.

The worker queues requests and document notifications in arrival order, executing one compiler
action per task. Cancellation removes requests that have not started; it cannot interrupt a
synchronous compiler call. Disposal releases queued work and the service. The queue holds at
most 256 actions; overflow or a failed document notification closes the session so Retry can
resynchronize it, instead of continuing with a missing change. The existing RPC request and
message-size limits remain separate from this action-count bound.

The browser provider implements initialization with UTF-16 positions, open/change/close,
completion/resolve, hover, signature help, definition/references, prepare-rename/rename and
edit-only quick fixes. The existing captured `sttropez/diagnostics` host extension supplies
syntactic and semantic results. It advertises this bounded subset; it is not the internal
worker-protocol-v1 fixture or a general-purpose language server.

Only the selected sample's known virtual files and the pinned compiler's standard libraries
are available. Unknown files, file creation/renaming, external projects, automatic package
acquisition, command-bearing fixes and edited-program execution are unsupported.
Navigation returns known open resources. Compiler work runs in workers; provider failures
leave editing and local saving usable, and Retry resynchronizes current document snapshots.

Compiler and protocol-reference packages are demo dependencies. Their bundles, standard-library
data and license notices go into the static site and never into the editor's NuGet assets.
Source code stays in this browser and its workers; saving/recovery uses browser-local IndexedDB.
The site needs no language backend, WebSocket endpoint, credentials or code-upload service.
Generated JavaScript uses the existing read-only virtualized text viewport, so large samples
keep bounded DOM content in both panes instead of laying out the complete output in one element.
Edits retain provisionally mapped syntax colors and the last completed output while analysis
runs; the footer reports pending or unavailable analysis. Only current worker results replace
them. File changes clear presentation ownership. See the [visible-continuity checks](demo-qualification.md#visible-continuity-and-complete-host-coverage).
The syntax worker retains compiler state and receives incremental replacement text. JavaScript
emission follows panel visibility; reopening requests current output without re-uploading the
source. Syntax colors remain active when the output panel is hidden or showing review/problems.
Cursor, tab, save and recovery metadata paint at most once per animation frame. Document
captures and provisional color mapping still follow every revision immediately.
Diagnostic messages and underlines also retain mapped positions while checking; Problems
navigation waits for current results. Syntax checks reuse unchanged files, while semantic
checks cover the project to preserve errors caused by changes in imported files.

Reset sample restores only the selected sample's original files as an undoable edit. Saved
copies and drafts for other samples are retained. Recovery notices name the draft's files:
visiting Large file can therefore offer unsaved edits from an earlier visit even after resetting
Shopping cart. Restore applies them, Download preserves a copy, and Keep current files discards
that exact offered draft. A draft already identical to the current saved files is cleared on
reopen; token checks prevent cleanup from deleting a newer draft written by another page.
Peer draft notices identify the changed sample, so unrelated cached samples do not reread
their records. Token checks remain authoritative when peer notifications are unavailable.
Caret/scroll snapshots belong to the actual document view, independently of workspace-local IDs.

An unavailable or unreadable saved project opens an editable sample and leaves the stored copy
untouched; saving still checks the captured storage token. Project construction failures instead
release acquired files, subscriptions and stores and report the original error. A failed sample
switch keeps the current editor and its history usable; the sample picker stays available for
another attempt. Recovery disposal waits for outstanding storage work before closing its store.

The completion catalogue sample offers 1,200 fields from a real TypeScript object. Every matching
candidate remains reachable through typing or arrow keys, while the popup renders at most 16 rows.
Its position/count and partial-list indicator distinguish the visible window from provider results.
The **Snippets & lazy completion** sample uses a labeled demo-owned template provider over the
same public protocol. Ctrl+End, Ctrl+Space then Tab inserts linked fields; Tab/Shift+Tab traverse
them, Alt+Up/Down or the visible buttons select a choice, and Escape ends the session while
keeping text. The lazy declaration supplies its body and import during resolution. TypeScript
continues to color, check and compile the result. See the [supported snippet subset](language-features.md#completion).
The **Project-wide results** sample exposes 300 diagnostics and 1,201 references/rename edits
from real TypeScript analysis. Problems, reference navigation and edit previews retain the whole
result while rendering 64 entries per page; applying a rename creates one shared undo command.

## Build and qualify

```sh
npm ci
npm run build:demo
npm run preview:demo
```

Open `http://127.0.0.1:4174/StTropez/`. The preview server serves only the explicit static output,
with no development-source or backend fallback. Relative HTML, worker, module and library-data
URLs support repository subpaths and custom domains.

`build:demo` first compiles the normal library. The site build resolves example imports only
through the four compiled public library entry points; private library imports and checkout
library source compilation are rejected. It records inputs and hashes under `artifacts/`,
and clears only its verified generated `artifacts/pages` directory before rebuilding.

Run `npm run test:demo` for Chromium, Firefox and WebKit. The suite reuses the complete source
demo walkthrough/conflict helpers, checks that every request stays below the repository path
and no backend/WebSocket is used, and exercises worker failure/retry, large-file editing and the
same completion catalogue, snippet and project-result journeys used by the local provider and restored-assets demo.
The focused provider test covers raw UTF-16/CRLF incremental edits, versions and file confinement.
Setting `STTROPEZ_DEMO_URL` runs the same browser tests against a deployed site without starting
a local preview server. All unattended browsers run headless.

## Deployment

The Pages workflow builds on pushes to `master`/`main` or manual dispatch. It typechecks, tests
the browser provider, builds the static consumer and runs the Chromium static-site journeys
before uploading the Pages artifact. Only the deployment job receives Pages-write and identity
token permissions. GitHub-hosted Linux runners build and deploy; no shared benchmark VM is used.

Native IME, OS clipboard and physical-display checks retain their existing unverified status.
The static build adds no new production-editor or arbitrary large-project performance claim.
