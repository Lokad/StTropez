# Performance assessment

Reviewed 2026-11-05. This is a measurement plan and scaffold assessment, not a claim that the
native-textarea scaffold has the performance of a finished editor.

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

The current scaffold deliberately falls short: the native view reads its whole `value` and
submits a full-document replacement, workspace edits scan/copy arrays, every subscriber runs,
and the playground updates unrelated metadata on every transaction. These are measurable
prototype limitations, not contracts to preserve in the final engine.

## Local diagnostic experiment

On 2026-11-05, a headless Chromium 156.0.8078.4 experiment on Windows with an Intel Core
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
   traces and profiles supply CPU/layout attribution.

[Event Timing](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceEventTiming) can
separate input delay and processing time from the duration through the next paint. Its
duration is rounded to 8 ms and the observer's minimum threshold is 16 ms; it cannot certify a
sub-4-ms model budget or establish that unreported interactions cost zero. Check support and
report missing metrics explicitly. Continuous scrolling also needs frame/layout measurements.
[Chrome's Performance panel](https://developer.chrome.com/docs/devtools/performance/reference)
can inspect the recorded interactions and CPU/layout/paint work. A browser paint estimate is
not a physical keyboard-to-monitor measurement.

The current `npm run bench` starts at input dispatch and ends at the second animation-frame
callback. It excludes earlier native editing and contains frame scheduling delay. It is a
useful smoke signal but not editor CPU time or end-to-end presentation latency. Twenty samples
per size are insufficient for a reliable tail estimate. Serially waiting for each sample also
misses pressure from sustained input. Improve this harness before using it as a performance gate.

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
  report p50/p95 and enough observations before claiming p99. Do not compare noisy CI machines
  directly. Keep detailed tracing in separate diagnostic runs so its overhead is explicit.
- Start with deterministic guards for bounded DOM, unchanged-resource notification counts,
  bounded caches and actual operation success. Add timing thresholds only after establishing
  variance on reference hardware, with both an absolute budget and a meaningful regression
  allowance. Missing samples or a skipped path must fail a benchmark, not produce a fast score.

At 60 Hz, a frame is 16.7 ms; at 120 Hz, 8.3 ms. A provisional synchronous model budget of
p95 below 4 ms on reference hardware leaves some room for the host and browser, but does not
guarantee either frame rate. An ordinary interaction target below 50 ms is a separate,
provisional end-to-end objective. Define workload and hardware before adopting either as a gate.

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
