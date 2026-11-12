# TypeScript demo qualification

The root demo is an editor/review pilot for a small TypeScript project. Run `npm ci` then
`npm run demo`, and open `http://127.0.0.1:4173/`. The server binds to loopback and does not
open a browser. Choose the large sample explicitly; the default is a two-file shopping cart.
Edited programs are not executed. [Language integration](demo-language.md) defines the pinned
provider/compiler pair, supported subset and host adaptations.

## Delivered workflow

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
remains available. The development syntax worker analyzes deferred full-file snapshots; compiler,
provider and full read-only JavaScript output costs grow with document size. Accepted Linux
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
