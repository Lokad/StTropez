# Static TypeScript demo

The public demo is built for GitHub Pages at <https://lokad.github.io/StTropez/>. It uses the
same editor, workspace, history, comparison and LSP clients as the local example. All changes
for static hosting belong to the example, tests and build/deployment tooling. The library in
`src/`, its public APIs, runtime dependencies and NuGet contents are unchanged.

## Host boundary

The static build replaces only the example's `provider.ts` connection factory. Its replacement
owns a Web Worker and supplies the existing public `RpcTransport` interface to `LspWorkspace`.
The worker uses the public `JsonRpcConnection` for framing, request ownership and cancellation,
and TypeScript 5.9.3's language service for actual language intelligence. The local development
server continues to use the existing TypeScript language server over WebSocket/stdio.

The browser provider implements initialization with UTF-16 positions, open/change/close,
completion/resolve, hover, signature help, definition/references, prepare-rename/rename and
edit-only quick fixes. The existing captured `sttropez/diagnostics` host extension supplies
syntactic and semantic results. It advertises this bounded subset; it is not the internal
worker-protocol-v1 fixture or a general-purpose language server.

Only the selected sample's known virtual files and the pinned compiler's standard libraries
are available. Unknown files, file creation/renaming, external projects, automatic package
acquisition, snippets, command-bearing fixes and edited-program execution are unsupported.
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

Reset sample restores only the selected sample's original files as an undoable edit. Saved
copies and drafts for other samples are retained. Recovery notices name the draft's files:
visiting Large file can therefore offer unsaved edits from an earlier visit even after resetting
Shopping cart. Restore applies them, Download preserves a copy, and Keep current files discards
that exact offered draft. A draft already identical to the current saved files is cleared on
reopen; token checks prevent cleanup from deleting a newer draft written by another page.
Caret/scroll snapshots belong to the actual document view, independently of workspace-local IDs.

The completion catalogue sample offers 1,200 fields from a real TypeScript object. Every matching
candidate remains reachable through typing or arrow keys, while the popup renders at most 16 rows.
Its position/count and partial-list indicator distinguish the visible window from provider results.

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
same completion catalogue journey used by the local provider and restored-assets demo.
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
