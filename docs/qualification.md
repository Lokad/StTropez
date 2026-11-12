# Qualification ownership

Focused implementation checks should name the changed invariant. At coherent boundaries,
run the broad model/browser checks and qualify the compiled package. Reuse passing evidence
for unchanged runtime and packaging paths. Discovered cases and observed execution time are
different measures; reducing a matrix alone does not prove a time saving.

| Invariant | Primary deterministic owner | Browser/distribution owner |
| --- | --- | --- |
| Indexed text, UTF-16 mapping and complete selections | `text-buffer`, `positions`, `utf16-ranges`, `selections` model tests | `editing`, `host-raw-crlf-caret`, `host-multiple-input` browser tests |
| Revision guards, shared history and detached views | `workspace`, `history`, `resources` models | Plain candidate host journey; native controls for selection/history; selected React mount/lifecycle journeys |
| Save/conflict/agent/review transitions | `save-review`, `host-save-conflict`, `host-save-failure`, `agent`, `comparison` models | Save/conflict, comparison and complete host journeys; restored normal/100k pilots |
| Demo recovery captures and syntax classification | `demo-recovery` owns delayed restore/discard, linked history, disposal and unchanged-draft reuse; `demo-syntax` owns compiler classification | `demo-recovery` owns real storage/reload/failure; `demo` owns file/sample switching, find, review, save and visible coloring |
| Positional LSP captures, supersession and cancellation | `lsp-clients` models | Small affected hover/navigation/rename/action host integrations |
| Provider sharing, diagnostics and command ownership | `lsp-workspace` and protocol session/RPC models | Minimal restored LSP consumer; selected plain/React integration |
| Signature/link/color client behavior | Named independent cases in `lsp-workspace`; decoder combinations in `protocol-features` | Selected language browser journeys, not every source-model permutation through a package |
| Native projection and composition recovery | `input-context` and `input-target` models | Editing/input-target, ordered input and composition browser suites; native-device checks remain separate |
| Caret geometry, focus, scrolling and drag | Geometry-independent models where applicable | Viewport, zoom, bidi, grapheme, multiple-selection, focus and pointer/drag suites across relevant engines |
| Font registration lifetime | Browser API owns decoding | Native-font tests; one restored registration/measurement/release check |
| Assets, declarations, isolation and installation | Package manifest/hash/dependency checks | Full restored consumer and install transitions; minimal LSP and consuming-host React routes |

`hosts.spec.ts` runs model-heavy scenarios through the plain candidate host. Three native
controls retain independent selection/view state, actual typing/history and detached composition
in both host shells. Selected candidate React cases retain complete normal/large journeys,
stable refs, queued-work disposal and composition with surrounding UI updates. Explicit React
root/Strict Mode and status-reset checks remain. Other browser-sensitive suites keep their
cross-engine input/clipboard/geometry/drag coverage. Synthetic composition is not native IME.

For a small change, use the affected `node --test` files and explicit Playwright paths/grep.
`npm run check` is the broad type/model/build/Chromium boundary. Select affected Firefox/WebKit
paths with `npm run test:browsers -- --project=firefox --project=webkit ...`; the unfiltered
command still runs all three engines. Run `npm run inspect` when DOM/layout/host behavior changes.
Do not add retries, blanket timeout increases or duplicate assertions to replace a missing owner.

`npm run bench` measures the model and actual bounded-editor keyboard route. `bench:pilot` and
`bench:all` are explicit larger workloads; individual `bench:*` routes remain available.
Input-handler clocks exclude queued work, browser scheduling and host services. Frame-ready
clocks are scheduling proxies; complete scripted actions also include automation overhead.
Keep raw clocks and source/environment identities distinct. Historical failures stay documented;
rerun an unreproduced outlier only with a new hypothesis and a bounded experiment.

## One package across selected consumers

`npm run test:package` builds/packs once, restores once outside the checkout, then runs full,
LSP and React routes against the same immutable package and staged asset root. Each route still
checks package/asset hashes, zero runtime dependencies, strict declarations and input isolation.
It records its own consuming fixture, not a repeated source-model matrix.

Select routes with `--scenarios=full,lsp,react` (also `pilot,hunk,activation,workspace`). The
full route owns installation/upgrade/downgrade/root-reuse checks. Use `--skip-transitions` only
when packaging inputs are unchanged and those transitions already have applicable evidence.
`test:package:lsp` and the other single-route wrappers use the same coordinator.

After an existing qualified build/pack, `npm run test:package -- --existing --skip-transitions`
reuses that archive. Rebuild after runtime, declarations or package inputs change. When a broad
`npm run check` already built the final sources, restore the packaging project and run
`dotnet pack packaging/StTropez.Assets.csproj --no-build --no-restore` before this command.
The coordinator rejects package/source changes during a campaign. `--reuse-consumer=<metadata>`
is the lower-level staged-root option; a different package hash or root is rejected before use.
Evidence is under `artifacts/package/qualification/` and remains local.

Headless tests do not establish native IME, OS clipboard, physical display or production hardware
qualification. Keep those gates explicit and continue independent implementation work. On a shared
desktop, do not activate applications, inject global input or change the OS clipboard.
