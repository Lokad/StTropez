# TypeScript demo qualification

The root demo is an editor/review pilot for a small TypeScript project. Run `npm ci` then
`npm run demo`, and open `http://127.0.0.1:4173/`. The server binds to loopback and does not
open a browser. Choose the large sample explicitly; the default is a two-file shopping cart.
Edited programs are not executed. [Language integration](demo-language.md) defines the pinned
provider/compiler pair, supported subset and host adaptations.

## Delivered workflow

The **Unopened files & navigation** sample demonstrates an editable module and a read-only
declaration absent from the initial editor resources. The shared source/static/restored-assets
journey covers F12 loading, return navigation, atomic rename/undo/redo across an unopened file,
and save/reload. A held-content source check rejects loading after edits or sample changes;
an injected standard edit action exercises preview/application of another newly resolved target.
Partial-inventory recovery tests cover complete draft contents, redundant saved drafts and a
stale read that cannot authorize replacing newer edits. Native/device qualification remains
separate. The public [target-loading contract](lsp-navigation.md) defines retention and authority.

The **Documentation & help links** sample has a shared source/static/restored-assets journey
for formatted hover/signature content, active-parameter documentation, explicit permitted help
opening and popup placement. The public renderer preserves plaintext, creates no provider HTML
and retires links on replacement/disposal. Its contract is the focused
[documentation subset](documentation.md), not a general Markdown engine.

The documentation milestone passes strict types and 442 model/provider tests. The affected
source campaign initially passed 68/69 checks: a pointer helper assumed one DOM text node.
Correcting that helper exposed a reproducible pending-paint hover defect: clearing occurrence
decorations on blur discarded pointer movement before the next frame. The host now keeps the
existing dwell delay and rechecks settled geometry/document revision without synchronous paint
or an unbounded retry. The corrected three-engine interaction checks and all 12 plain/React
hover checks pass, including 100k documents, stale replies and disposal. The static documentation
journey passes in Chromium, Firefox and WebKit. Longer popups also fit their rendered size inside
the viewport, keeping their help link reachable.

Three complete static-demo inspection observations measured 36.7–47.0 ms from keydown capture
through two correctly formatted frames, and 41.2–52.9 ms through automation. The former includes
request/synchronization/provider/rendering; it is not input-handler or provider-only time. A
separate 120,000-unit unmatched-punctuation renderer probe retained exact text in two elements:
8.5 ms for the synchronous render call and 24.9 ms through two frames. These small-sample shared
Windows/headless observations do not establish stable tails or physical-display latency.

Caret occurrence highlighting has a shared source/static/restored-assets journey for text
placement, provider read/write kinds, composition, caret movement, edit/undo, file switches and
scrolling through 10,001 occurrences. The source milestone passes 18 affected checks across
Chromium/Firefox/WebKit, including deliberately late replies, completion, folding, save/reload
and explicit provider retry; the static occurrence journey passes in all three engines. Strict
types, the dependency-free build and all 441 model/provider tests pass. The Node server reports
the tested variable writes as reads; the static compiler provider supplies distinct write kinds.

Three static-demo scroll observations with 10,001 occurrences kept 37–38 source rows mounted.
Scroll-event handlers measured 0–0.1 ms, two frames with matching code/gutter/highlights took
25.1–47.7 ms, and complete automation took 28.3–50.0 ms. Initial insertion through first visible
occurrences took 852 ms including synchronization, debounce, provider work and rendering. These
shared-Windows/headless measurements are separate clocks, not provider-only, stable-tail or
physical-display guarantees. The initial local run timed out during provider startup; a bounded
restart using the qualification temp directory succeeded, without establishing exact attribution.

Automatic TypeScript and off-side folding share one source/static/restored-assets journey:
keyboard and group commands, edit/undo, Find revealing hidden text, gutter agreement and
independent comparison views. Expanded discovery metadata preserves language results and
typing undo groups; failed providers await explicit Retry. The folding/lifecycle suite passes
30 checks across three engines. The restored consumer also passes the new folding journey.

The shared journey now also checks TypeScript saved/working colors and import-fold controls,
an explicit hidden-line label, independent collapse/expand, differing ranges after an edit,
hunk navigation, undo, save/refresh and return to the source. The saved snapshot uses its own
captured syntax analysis; a focused failure/held-reply check covers Retry, replacement and
disposal. Generated fold labels remain outside raw source/copy text and caret geometry.

Three headless Chromium comparison openings on shared Windows measured 3.9–6.0 ms through
click dispatch and 212.7–230.5 ms to two colored frames for the small navigation sample.
For the 100k-line sample, dispatch was 4.3–6.4 ms and two colored frames took 596.0–659.9 ms,
including saved-worker startup, upload and analysis. Full opening automation took 253.9–256.3 ms
and 626.4–687.1 ms respectively. Subsequent middle scrolling kept 27 rows in each pane;
scroll handlers took 0–0.2 ms and two matching colored frames took 33.1–33.9 ms. Other
qualification was running on the shared machine. These are distinct clocks and small-sample
observations, not provider-only latency, stable-tail or physical-display guarantees.

The affected source campaign retained a Firefox provider-startup timeout; one isolated retry
passed and attribution remains unresolved. A WebKit lost expansion click and file-tab switch
were reduced to replacing identical button text during a pointer press. Fold controls and file
tabs now preserve unchanged text nodes; regressions hold a press across viewport painting and
compiler-result delivery. This finding does not attribute older unexplained misses or establish
native input qualification. No deadlines were increased.

The associated static campaign passed 35/36 checks. One WebKit project-results check lost a
hover popup; two bounded instrumented runs did not reproduce it or establish scroll-related
attribution. This remains an explicit unresolved qualification observation, not a folding failure
or a reason to rerun unrelated campaigns. Native input/display qualifications remain separate.

In a 100,002-line host outline with one fold, three collapse observations measured 0.9–1.1 ms
through the click handler, 46.4–47.6 ms to two frames with matching code/gutter rows, and
74.5–80.6 ms through complete automation. Initial text insertion plus discovery took 844 ms.
These are small-sample shared-Windows/headless observations, not provider, physical-display or
stable-tail claims. Model transactions and the standard 18 two-view typing cases also passed.

The public-DOM walkthrough edits the discount and checks real emitted JavaScript, inspects a
type/signature, follows a definition, renames across both files with shared undo/redo, applies
a real spelling fix, compares/reverts/undoes, saves and reloads, then explicitly restores and
undoes a two-file recovery draft. A second journey runs two real providers against shared
browser storage and checks conflict review, rejection after later typing, reviewed save and
reload of both files. The same helpers qualify source and restored-assets compositions.

Source journeys cover Chromium, Firefox and WebKit. Focused controls also cover file/sample
view state, find/replace, provider restart with offline edits, stale responses and disposal.
The restored Chromium consumer uses one immutable assets-only package/staged root shared with
the full and generic LSP consumers: compiled public exports, strict declarations, CSS and the
standalone regex worker. Checkout library sources/private imports and consumer package
installation are rejected. Compiler/provider dependencies remain in the development host.
Owned provider projects, connections, processes and pending removals are zero after closure.
Selected plain/React fixture journeys retain the broader workspace/host lifecycle coverage.

The documentation journey also exercises **Diagnostic details**: real TypeScript related
declarations, a labeled host warning's source/severity/deprecated tag, explicit permitted help,
related-location selection, correction/undo and sample replacement. The same journey runs
against source, static and restored-package demos. Protocol checks own nested immutability,
malformed metadata, unknown tags, opaque data forwarding and stale/unversioned exclusions.

The project-result journey reaches diagnostic 300 and reference 1,201 through visible controls,
previews all 1,201 rename edits with bounded rows, applies the complete rename, then checks one
undo/redo and save. It is shared by the source, static and restored-package demos. Protocol tests
own malformed-tail rejection and larger completion/opaque content; a 65-choice fixture checks
action paging and captured application in both hosts. Result counts are correctness workloads,
not response-time or arbitrary-project scalability guarantees.

## Visible continuity and complete-host coverage

Local input-handler time and an eventually correct snapshot are insufficient acceptance criteria.
The first visible response must also retain the surviving source text, its existing syntax colors,
selection/caret and the last completed output while deferred services run. Fresh compiler output
and diagnostics have separate readiness clocks. The syntax host provisionally maps completed
classification ranges through the public document transactions, querying only visible spans.
Changed lexical context can retain provisional colors until the current compiler result arrives;
these colors never supply diagnostics, edits or provider authority. File changes and unmapped
resource reloads clear the old classification. Undo to the analyzed immutable buffer restores it.

The generated output view stays mounted while analysis is pending or unavailable. The footer
reports that state; the last completed output is a preview, not a claim about the current source.
Fresh output updates that read-only resource and preserves its approximate scroll position.
Changing files/panels or disposing the page releases the view and its resource.

The shared presentation journey holds actual compiler replies and observes every animation frame
and completed viewport render during deletion, undo/redo and scrolling. It runs on mixed code and
the 100k-line sample, checks colors on surviving rows and continuous bounded output, then releases
replies and requires current analysis. Existing long-line/multiline, file-change, worker-failure,
save/review and native-scrollbar journeys cover the adjacent behavior without a new test matrix.
DOM/style observations and screenshots are evidence of browser state, not physical-display proof.

The integrated measurement checks every mounted text pane, not only source/comparison. It records
whole-host long tasks, animation-frame gaps and supported Event Timing entries, alongside existing
handler, local-frame and fresh-service clocks. Event Timing durations are quantized and only
entries reported at the 16 ms threshold are collected; these are not a complete latency
distribution or a page INP score. Input delay, event processing and presentation delay are distinct
parts of browser responsiveness. [Browser measurement guidance](https://web.dev/codelabs/measuring-inp).

The bounded campaign now includes ordinary code, 2,000 unique functions/10,000 semantic TypeScript
lines, and 100k comment lines. Cold readiness, start/middle/end edits, navigation, completion,
comparison and save use the complete host with services active. This replaces neither the native
device matrix nor constrained-hardware qualification, and does not establish stable tail latency.

That wider campaign exposed a bulk-input gap: a single synthetic insertion of 285,560
UTF-16 units took about 160 seconds on Chromium, including one main-thread long task of the same
duration. Subsequent local-frame observations were about 43–83 ms. Good warm typing therefore
does not qualify document replacement. A bounded comparison isolated native textarea expansion:
48 KB took about 345 ms through native insertion (about 330 ms between beforeinput and input,
followed by roughly 1,200 input events), versus 5–12 ms through captured host/paste transactions.
Cancelling native expansion and applying the same existing transaction also took about 6 ms.

The bounded adapter now handles known, cancellable non-composition insertions before they exceed
its native context limit. The original 285,560-unit replacement then completed through the rebuilt,
restored package in about 66 ms of automation time, 52 ms from beforeinput to local-frame observation,
and 6 ms in its beforeinput handler: one model commit, no native input events, and a 390-unit maximum
native context observed at dispatch. The semantic workload subsequently passed completion,
navigation, comparison and save; warm local-frame p95 observations at the three positions were
about 45–78 ms (eight samples each). This closes
the reproduced cancellable bulk-input stall, not every native input path. Composition, missing-data
and noncancellable events retain their native fallback. OS clipboard/IME remain unverified.

The existing five-second local-readiness deadline is also enforced from Node around measured
typing and semantic fixture insertion. An in-page timer cannot fire while that page's main thread
is blocked. The external watchdog closes only the campaign-owned headless browser and preserves
partial failure evidence. `--corpora=semantic` qualifies that workload independently; selected-case
runs never imply a new pass for every corpus. Historical failures and raw measurements are retained.
The shared Windows machine and small sample counts do not establish stable latency tails.

## Sample and recovery lifecycle

Reset is scoped to the selected sample and remains undoable. A genuine draft for another sample
is retained and its notice names its files. Checks cover a fresh reset, a prior large-file draft,
sample switches, restore/reset, reload, late claims, storage failures and concurrent token changes.
Already-saved identical drafts are removed on reopen without changing documents. A recovery read
cannot cancel cleanup of the page's own saved draft. Cleanup always compares the exact stored
token, so another page's newer work survives. View state is keyed by the actual view handle;
workspace-local view IDs must not transfer carets or scrolling between samples.
Save and recovery restoration also require settled input, including deferred commands and queued
typing. A save clicked during a pending command reports that editing must finish before retrying;
it does not capture an older revision as if that already-accepted command had completed. The shared
editing journey verifies the refusal, subsequent save and reload without a redundant recovery offer.
Successful save feedback waits for cleanup of this page's own draft token, even when that draft
contains older text. Cleanup failure remains visible through recovery status; offered or newer peer
drafts are preserved. This closes the reload window between a saved revision and deferred cleanup.

The milestone typecheck, all 403 model tests and dependency-free build passed. The broad
Chromium campaign passed 729/731 cases. One existing isolated headless-clipboard case missed
its 30-second test deadline; the fractional-zoom scrollbar case stopped at the five-second
provider-startup prerequisite, before its layout assertions. Attribution remains unresolved;
no deadline was enlarged and neither miss was retried or traced. This is not a clean broad
pass or a reproduction of scrollbar oscillation. Focused cross-engine and packaged demo
workflow evidence remains separate from those misses.
Inspection and the representative model/two-view keyboard benchmarks completed. The final
manual-prefix regression passed all three engines, explicitly waiting for resolved details
before keyboard acceptance.

Saves persist the whole sample in this browser's IndexedDB, with captured version/conflict
guards. Recovery is deferred and explicit; the status reports completed capture. Last
keystrokes or abrupt termination can precede capture. Saving is not a remote filesystem service.

## Integrated responsiveness

A bounded headless Chromium 156.0.8078.4 campaign on shared Windows (kernel 10.0.26200) x64,
Intel Core i7-14700KF, 64 GiB RAM, Node 24.17.0 and a 1440×900 viewport exercised the actual
restored-package demo. The ordinary active file had 390 UTF-16 units/14 lines; the large
sample had 4,488,894 units/100,000 comment lines; the completion step adds a real Math call.
This does not qualify arbitrary 100k-line TypeScript semantic workloads. Every keyboard sample checks exact text, revision,
selection and two settled editor frames. Native contexts, rendered rows and viewport reads
remain bounded; the large source used at most 512 input units and 38 rendered rows.

| Clock, milliseconds | Ordinary | 100k lines |
| --- | ---: | ---: |
| Initial editor-ready automation proxy | 111 | 79 |
| First edit: beforeinput to two settled editor frames | 78 | 47 |
| Warm input-handler maximum, eight edits per start/middle/end | 9.5 | 3.5 |
| Warm beforeinput-to-frame maximum, same observations | 49 | 82 |
| Warm complete automation-action maximum, same observations | 51 | 84 |
| Initial compiler-output readiness from beforeinput | 146 | 877 |
| Initial provider connection observation from beforeinput | 27 | 2,005 |
| Initial current-diagnostic readiness from beforeinput | 561 | 2,547 |

The large editor-ready clock starts at explicit sample selection; the ordinary clock starts
at navigation. Handler spans cover only the named adapter listener and synchronous work inside
it. Frame proxies include browser scheduling; automation proxies also include transport and
settlement. Compiler/provider observations are separate deferred feedback clocks. None measures
physical presentation or process CPU. The first edit after feedback is retained separately;
its handler/frame maxima were 2.9/48 ms ordinary and 5.4/48 ms large.

| Complete automation workflow observation, milliseconds | Ordinary | 100k lines |
| --- | ---: | ---: |
| Completion visible at an existing member prefix | 38 | 1,215 |
| Completion resolved/applied and editor frames ready | 113 | 1,268 |
| Home/PageDown/End navigation, largest of three observations | 101 | 51 |
| Open comparison with both panes ready | 99 | 168 |
| Browser-local save acknowledgement | 39 | 50 |
| Save plus refreshed comparison ready | 66 | 79 |

These are small diagnostic samples on a busy machine, not stable latency tails or provider
service guarantees. Language feedback can take seconds on the large sample while local editing
remains available. These historical measurements did not check intermediate syntax-color loss
or bound the full JavaScript pane, and must not be read as proof of visual continuity. The current
host retains provisional colors/output and virtualizes both panes. The development syntax worker
still analyzes deferred full-file snapshots; compiler/provider and output-buffer construction costs
grow with document size. Pending color queries depend on visible spans and the transactions since
the last completed analysis, not a full token-array remap on each keystroke. Accepted Linux
editor baselines remain separate and do not qualify this new compiler/provider composition.

CDP observations cover the main target only, without forced collection. Large-file used V8 heap
was about 27 MB after initial feedback and 112 MB after save/review; embedder/backing observations
are recorded separately. These include transient allocation and establish neither a leak nor
retained/peak/process memory. Worker/provider heaps, total resident memory and constrained
hardware remain unmeasured. No new memory investigation is required without a reproduced defect.

Reproduce the bounded campaign after the package routes using the existing stage:

```sh
node scripts/package-demo.mjs --reuse-consumer=artifacts/package/qualification/staged-consumer.json --measure-only
```

The hook exists only in that instrumented development-host bundle. Raw source/package/environment
identities, clocks and semantic snapshots are retained locally under `artifacts/bench/demo/`;
partial failures retain completed samples without retries. Historical failures remain explicit;
rerun an unreproduced outlier only with a new hypothesis and bounded experiment.

## External qualification

Native IME/dead keys/AltGr/reconversion, OS/application/menu clipboard, native shutdown and
physical display remain **UNVERIFIED**. Use the [native matrix](acceptance.md#browser-and-native-device-matrix)
for US/French and Japanese/Chinese layouts, commit/cancel/reconversion/placement, actual paste,
focus escape and unsaved work. Headless keyboard and synthetic composition do not satisfy those
device checks. Unattended work stays in the background and does not alter the OS clipboard.
Production/constrained hardware, adoption and release decisions remain separate from the usable
demo milestone. Further font/shaping expansion requires a reproduced pilot defect.
