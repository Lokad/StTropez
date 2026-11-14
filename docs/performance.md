# Performance assessment

Reviewed 2026-11-05. This is a measurement plan and scaffold assessment, not a claim that the
native-textarea scaffold has the performance of a finished editor.

Use recorded Linux measurements as the performance baseline. The local Windows machine is
available for native input and clipboard checks; its background activity may affect timings.
Record that load and keep Windows observations labelled separately. Native correctness checks
do not require a quiet benchmark machine.

## Likely bottlenecks and design consequences

| Work | Scaling hazard | Design and measurement |
| --- | --- | --- |
| Native editing, DOM layout and text measurement | Layout across a large document or a single enormous line; repeated read/write cycles; wrapping and variable-height widgets | Virtualize vertically and horizontally where needed; group measurements; reuse DOM; trace style, layout and paint separately. A single textarea element does not imply bounded browser layout work. |
| Document edits and position mapping | Full text serialization, line-array rebuilds, copying every annotation or selection per keystroke | Range transactions, indexed text storage and mapped positions; measure edit cost at start/middle/end while document size grows. Do not flatten a tree in routine subscribers. |
| Workspace and host updates | Every editor, tab, form or host component reacts to every character | Subscribe by document and field; keep stable snapshots for unchanged resources; batch unrelated progress updates; test many inactive tabs and two active views. |
| Highlighting and diagnostics | Reparsing everything, large decoration arrays, stale responses, worker messages containing the entire document | Incremental changes, revision checks, cancellation, viewport-prioritized decoration and explicit work budgets. A large lexical invalidation must yield rather than block input. |
| Search, diff and agent proposals | Large synchronous scans, adversarial diff inputs, thousands of small incoming updates | Bounded/cancellable jobs; coalesce updates; evaluate workers before WASM; measure result freshness and interaction latency during background work. |
| Allocation and retention | Full snapshots in undo, stale promises retaining documents, detached views and listeners | Shared text/history structure, bounded caches, explicit disposal; measure GC pauses and retained memory after repeated open/edit/close cycles. |
| Startup | JS download, parse/compile, initialization, worker/WASM startup | Measure compressed production bytes and cold first-edit readiness separately from warm typing. |

The governing goal is for an ordinary local edit to depend mainly on the changed range and
visible content, with indexed lookup costs, rather than total file length or workspace size.
This is not a universal complexity promise: global search, large paste and lexical invalidation
have different costs and need separate scheduling policies.

The native view still reads/renders its whole `value` and derives a single range replacement
by scanning common text. The workspace now uses indexed piece storage, bounded history and
mapped views, but its coarse snapshot still rebuilds resource/document arrays. Scoped
document/resource/metadata subscriptions keep edits out of unrelated form and tab listeners.
Two native views can still incur browser layout for the whole text.
The remaining costs are measurable prototype limitations, not final engine contracts.

## Local diagnostic experiment

Before storage/history integration on 2026-11-05, a headless Chromium 156.0.8078.4 experiment on Windows with an Intel Core
i7-14700KF compared the scaffold with a native textarea control in the same page. Replacing
the textarea with a clone removed the application listeners for the control. Each condition
reloaded the page and used five warmup characters followed by twenty measured characters,
inserted at the beginning of repeated short ASCII lines. Three rounds alternated mode order.

| Lines | Scaffold input-handler p95 | Scaffold layout ms/input | Native control layout ms/input |
| ---: | ---: | ---: | ---: |
| 100 | 0.1 ms | 0.12 | 0.09 |
| 10,000 | 0.2 ms | 3.00 | 2.78 |
| 100,000 | 1.5 ms | 30.87 | 29.71 |

Handler timings cover capture-to-bubble dispatch, including model and synchronous subscribers,
and exclude native processing before the `input` event. Their timer resolution is about
0.1 ms. Layout values are the median of three round-average CDP `LayoutDuration` deltas,
divided by twenty inputs; they are neither per-input percentiles nor presentation latency.
The 100,000-line fixture has 2.4 million ASCII characters before edits.

At 100,000 lines, handler median was 0.5 ms. A separate Chrome trace also showed substantial
native text-input, prepaint and paint work. Nested trace durations must not be added together.
The native control retaining nearly the same layout cost strongly points to browser-native
editing/rendering as the current large-file bottleneck, rather than the small workspace model.
This does not prove the future custom renderer, history or language features will be cheap.

This was a development-bundle diagnostic, with sixty measured inputs per condition and no
cross-browser or production comparison. It is not an editor ranking or a stable regression
baseline. Raw samples, environment and source hashes are in the ignored local artifact
`artifacts/bench/diagnostic.json`; `diagnostic-trace.json` in the same directory can be loaded
in Chrome's Performance panel. The ignored reproducer is `artifacts/perf-investigation.mjs`.

## How to assess it

Use three complementary layers:

1. Deterministic headless model benchmarks: apply a seeded edit log, map positions, undo/redo,
   search and diff, then validate final text/revisions. Time the operations without browser
   work or framework updates. Include retained history and allocation measurements.
2. Browser interaction benchmarks: use real automated keyboard, selection, paste and scroll
   actions, verify the expected result, and record input delay, synchronous processing and
   rendering delay. Add User Timing marks around transaction application, subscriptions,
   visible-range computation and DOM updates. Never infer success from a screenshot alone.
3. Whole-workspace scenarios: type while diagnostics arrive, a form changes, background status
   updates run, or a comparison opens. Distinguish service/network latency from local input
   latency. Use screenshots and Playwright traces for behavioral review; Chrome performance
   traces and profiles supply stack/layout attribution with their measurement boundaries.

[Event Timing](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceEventTiming) can
separate input delay and processing time from the duration through the next paint. Its
duration is rounded to 8 ms and the observer's minimum threshold is 16 ms; it cannot certify a
sub-4-ms model budget or establish that unreported interactions cost zero. Check support and
report missing metrics explicitly. Continuous scrolling also needs frame/layout measurements.
[Chrome's Performance panel](https://developer.chrome.com/docs/devtools/performance/reference)
can inspect the recorded interactions and script/layout/paint work. A browser paint estimate is
not a physical keyboard-to-monitor measurement.

`npm run bench` now writes separate headless model and browser reports. `bench:model` runs
only the model replay; `bench:trace` runs a separate Chromium layout/paint attribution
diagnostic. All are baselines, not performance gates or production-engine qualification.
The bounded editing candidate has its own `bench:editing` report covering actual keyboard input,
model commit and two viewport projections. `inputHandlerMs` times the adapter's `input` listener,
including context refresh and synchronous model/subscriber work. It excludes browser processing
before the event and later layout/paint. `beforeInputToFrameProxyMs` spans the native beforeinput
event through an animation-frame readiness poll; it is not physical latency. Three warmups and
twenty samples per corpus/position form a development diagnostic. Runtime counters require one
input and commit, exact inserted text, bounded native context/DOM, zero whole-buffer exports and
no whole-value fallback. Cross-candidate production comparison and native-device gates remain open.
The editing fixture now includes incremental visible-line tokens, idle find state and a connected
host-owned provider. `bench:services` measures search and replacement separately: scan-step maxima,
global scheduling/readiness proxies, synchronous replacement transaction/publication, exact
count/history/undo and no-export guards. Offset-index memory is proportional to match count.
Planning yields; the final bulk transaction still scales with changed ranges. Its 100,000-line
case is a single diagnostic, with no percentile/adoption claim. A real worker reply is required
independently of local highlighting so fallback cannot satisfy the provider guard.
`bench:bulk` isolates the actual tree's multi-range construction, traversal and scanner elapsed time in
fresh Node processes, with full oracle checks outside timing. Dense packing trades some copied
backing/index units for fewer nodes; sparse-subtree sharing and retained roots have separate
guards. This measured TypeScript kernel work precedes optional worker/WASM experiments.

`bench:comparison` measures exact line alignment over immutable snapshots. Headless total elapsed time
and cooperative-step maxima are separate from browser controller-step time and scheduled
readiness proxies. Reconstruction checks occur outside timing. Normal/10,000-line/Unicode
browser cases repeat; 100,000-line and huge-line browser cases are diagnostic observations.
Line metadata and search arrays scale with the input; cooperative work accounting does not
bound allocator/GC pauses or qualify adversarial repeated-line tail latency.

`bench:hosts` exercises full request/correction/save/acknowledgement/Run sequences in plain
and React hosts with two views, a typed form and 20 Hz progress. Each native/candidate and
normal/10,000-line condition uses three warmups and ten measured workflows. Proposal
acceptance/notification elapsed time is separate from automation/readiness proxies. Explicit host
captures export their exact snapshots; routine candidate rendering stays bounded. See the
[workflow contract](host-workflows.md) for metric limits and recovery/disposal behavior.

`bench:storage` separately compares immutable flat, chunk and piece storage with edit,
first-lookup, local-read, snapshot, export and GC retention boundaries. The selected runtime
piece tree is exercised through its own adapter. See [the storage decision](text-storage.md)
for the repeated quiet-machine measurements, source identity and tradeoffs. Current workspace
measurements include the selected piece tree, bounded shared history and mapped selections;
the native-control report retains whole-value rendering. Viewport and bounded-input reports
exercise their separate paths. All remain diagnostics.

| Report | Measured boundary | Limit |
| --- | --- | --- |
| `artifacts/bench/model.json` | 60 seeded range transactions after 5 warmups, including history, a counting subscriber and bounded range/line reads; zero routine exports asserted; separate undo/redo samples check exact retained roots and undo-to-saved state | Oracle exports/validation are outside timing; arbitrary UTF-16 offsets are deliberate; logical retention is not a heap byte estimate |
| `artifacts/bench/latest.json` input handler | Capture-to-bubble dispatch, including synchronous model/subscribers | Excludes native editing before `input`; timer resolution can produce zero samples |
| Same report, second frame proxy | Capture through second animation-frame callback | Frame scheduling proxy; neither physical presentation nor CPU time |
| Same report, browser work | CDP LayoutDuration/RecalcStyleDuration counter deltas around 20 measured inputs | Aggregate milliseconds, includes intervening harness activity; no per-event percentile claim |
| Same report, startup | Navigation time origin to module readiness for 3 page loads | Includes parse/mount and server work; mixed warm caches, insufficient for a tail/cold-start claim |
| `artifacts/bench/phases.json` | Per-event Layout/Paint/PrePaint/style/event-dispatch durations from a separate 5-input trace | Diagnostic overhead; events can nest, so phase sums are invalid; raw trace/content is not exported |

Browser runs exercise start/middle/end input for all six pinned corpora and assert exact text
and model lengths. Native LF display coordinates map to preserved model CRLF; native and model
lengths are checked independently. Reports include a hash of every nonignored source
file (including uncommitted files), lockfile identity, seed, hardware, OS, browser, viewport
and computed font settings. Model and browser measurements run sequentially.

The model report also measures propagation for 1/10/100 resources and 1/2 document listeners
with retained selection handles.
It asserts exact changed-document deliveries and zero unrelated resource/unchanged metadata
deliveries, mapped-selection deliveries and stable snapshot identities. These listeners represent view subscriptions,
not browser mounts. The current browser campaign explicitly records two mounted native views;
earlier one-view native baselines are different workloads and cannot be compared as regressions.

Twenty browser samples per condition and three startup loads are insufficient for a reliable
tail estimate. Serially waiting for each sample also misses sustained-input pressure. These
desktop diagnostics are separate from any quiet-machine campaign. Production/constrained
hardware, repeated alternating runs and retention budgets remain qualification work.

The [bounded read-only viewport](viewport.md) has a separate `artifacts/bench/viewport/latest.json`
report. It asserts visible range text, viewport-sized rows/reads and zero whole-text exports under
programmatic edits in two views. Geometry/range/DOM-write timings are separate from a frame-ready
scheduling proxy. These are rendering-layer diagnostics, not native input or full editor latency;
the UTF-16 horizontal estimate still needs measured glyph geometry for long shaped lines.

## Workload matrix and regression policy

- Use representative short files plus 100, 10k and 100k lines. Vary bytes independently of line
  count: a multi-megabyte single line, short ASCII lines, long Unicode lines and many tokens.
  Include tabs, combining characters, emoji, bidi text, wrapping on/off, and large annotations.
- Exercise first/middle/last edits, sustained typing, large paste/delete, undo, rapid scrolling,
  search, diff, cold open and tab switch. Include IME and native clipboard/manual checks.
- Vary workspace size (1/10/100 open documents), active view count and background traffic.
  Measure per-view DOM growth, retained memory and mount/dispose behavior, not just typing.
- Record source hashes or commit plus dirty-state identity, package lock, corpus/seed, browser,
  hardware, viewport/font, build mode, power settings, sample count and raw samples. Separate
  cold and warm results. Test production bundles for release decisions.
- Alternate baseline/candidate order on the same machine, use repeated independent runs,
  report sample count and p50/max for batches below 20; use p95 only with enough observations
  and a stated sampling method, and gather more before claiming p99. Do not compare noisy CI machines
  directly. Keep detailed tracing in separate diagnostic runs so its overhead is explicit.
- Start with deterministic guards for bounded DOM, unchanged-resource notification counts,
  bounded caches and actual operation success. Add timing thresholds only after establishing
  variance on reference hardware, with both an absolute budget and a meaningful regression
  allowance. Missing samples or a skipped path must fail a benchmark, not produce a fast score.

The shared distribution includes `n`, `max` and the exact nearest-rank `p95`. With fewer than
20 samples, that p95 is the sample maximum, so `statistic` is `max` and console summaries omit
the p95 label. These small batches describe observed values, not production latency tails.

Host workflows, save/conflicts, services, folding and table-paste reports use one writer. Each
explicit variant keeps `artifacts/bench/<driver>/<variant>/runs/<run-id>.json`; only a passed
run updates that variant's `latest.json`. Writes use a temporary file and rename. Running and
failed records retain their own run identity and cannot replace the last passed report; completed
records cannot be rewritten. Full and smoke variants are separate. Services additionally separate
literal/regex, whole-word/substring and case-sensitive/ignore-case choices. Existing historical
artifacts remain intact. Report writing stays outside the timed point actions.

At 60 Hz, a frame is 16.7 ms; at 120 Hz, 8.3 ms. A provisional synchronous model budget of
p95 below 4 ms on reference hardware leaves some room for the host and browser, but does not
guarantee either frame rate. An ordinary interaction target below 50 ms is a separate,
provisional end-to-end objective. Define workload and hardware before adopting either as a gate.

The [M3 pilot](m3-pilot.md) defines separate initial budgets for handler elapsed time, interaction
readiness and complete automation actions. `bench:editing` reports these as `inputHandlerMs`,
`beforeInputToFrameProxyMs` and `completeActionProxyMs`. Readiness verifies exact inserted
text, revision, primary selection and both rendered view revisions across two consecutive
animation frames. The complete action starts before the keyboard automation call and includes
transport and returning that same readiness result. Neither measure proves physical display
latency. Compare reports only when their timing boundaries match; older frame reports used
one readiness frame. Integrated host workflow reports also wait for comparison work and both
comparison viewports, so they are a different workload from earlier source-only host reports.

## LSP lifecycle retention

A separate headless source-host experiment on Windows/Chromium 156.0.8078.4 covers plain and React,
normal and 100k-line sources, immutable comparison, typing/history, confirmed commands, server-edit
Apply/Decline, cancellation, remount and disposal during a pending decision. Each condition has one
identical warmup followed by four phases with three forced-GC observations: 48 observations total.
The parent target/isolate remains stable; the same-origin pilot frame must expose its execution
context in that target. Exact source/reference bytes, complete-set history, actual protocol paths
and final live-ownership counters are checked independently of the memory readings.

The final boundary is explicit host disposal, closure of sockets and live views/leases/subscriptions/
jobs, release of the embedding frame, then two animation frames before the first collection.
The host retains its document graph until that embedding owner is released. All 12 final samples
meet the unchanged limits against their condition's minimum warmed baseline: +4 MiB V8 used heap,
+32 DOM nodes and +0 event listeners. Observed maxima are +5,376 bytes, +0 nodes and +0 listeners.
Owned-phase observations describe the live working set and have no additional pass threshold.

Immediate post-detach collection exceeded these limits in the first sample of three conditions;
later collections returned near baseline. One control restored the existing collector's two-frame
settlement step before the first GC and passed every final sample. This supports an inference that
collection ordering affected the first reading; no internal engine retainer attribution was proved.
The immediate post-detach boundary remains unqualified.

`Runtime.getHeapUsage.usedSize` and `Memory.getDOMCounters` define this retained V8/DOM scope.
Other reported heap fields are descriptive. These results establish neither native/backing/total-
process/peak memory, GC pauses, other-engine retention nor production or physical-display latency.
The settlement frames are a memory collection boundary, not an interaction-latency measurement.

## WASM decision

Prioritize bounding work and isolating host updates. WASM does not remove DOM layout, native
input processing or unnecessary subscriptions. Candidate kernels are large diff/search/parser
operations only after profiling shows that their execution dominates. Compare optimized
TypeScript, a worker version and any WASM version end to end, including encoding, copying,
message queues, memory and startup. Moving work to a worker can improve responsiveness even
without reducing total CPU time. A custom compiler is a separate investment, not a prerequisite.

## Implementation order

Establish workloads and input/provider feasibility probes before committing to the engine.
Measure subscription propagation during the initial host integration, including non-text forms.
Add phase measurements and deterministic transaction replay alongside the text buffer work,
then DOM-size and long-line guards alongside the browser engine. Qualification consolidates
these results into regression budgets. Evaluate accelerators only for measured bottlenecks;
do not defer measurement until all editor features are implemented.
