# Agent and performance instrumentation

Host fixtures select the bounded candidate with `?editor=candidate`; `?editor=native` retains
the native control. `window.hostFixture.snapshot()` includes mounted view identities,
bounded input/viewport metrics, captured Run metadata, command settlement and recovery metadata.
Raw recovered text and Run values require explicit readers. Inspection records both modes,
failed acknowledgement, typing through Run and a rejected composition recovery preview.
`bench:hosts` writes complete-workflow automation proxies and proposal transaction elapsed time separately
under `artifacts/bench/hosts/`, with source/environment identity and raw samples.

The `/comparison/` development fixture exposes `window.comparisonFixture`: captured identities,
reference epoch/version, exact hunk ranges, revision, bounded viewport/input metrics, ticket
counts and disposal diagnostics. Text is available only through explicit range readers.
Inspection writes `comparison.png`, `comparison-whitespace.png` and `comparison.json`.
`bench:comparison` records exact alignment elapsed time, maximum cooperative-step time and browser
readiness proxies separately, with raw samples and source/environment identity. It does not
infer physical presentation, native input qualification or production tail latency.

Clocks based on `performance.now()` report elapsed time between their endpoints, including
any delays within that span. They do not measure process CPU time. Keep adapter handlers,
capture-to-bubble observations, complete callbacks, inner-loop maxima, readiness and complete
automation actions separate. Sampling profiles estimate observed stacks over elapsed intervals;
inclusive weights can overlap and must not be added as independent durations. Older reports
retain their original values and labels; interpret their clock boundaries from the producer.

See [performance.md](performance.md) for the StTropez performance assessment, bottlenecks,
workload matrix and measurement policy.

`npm run inspect` launches an isolated loopback server and headless Chromium, waits for the
playground to become ready, and writes a screenshot plus state metadata. The library itself
exposes no global debug API. The playground's `window.sttropez` offers readiness, document/tab
metadata, bounded timing samples and synthetic fixture generation. It omits document contents.
The separate `/probes/` page exposes development-only event/provider/workspace counters and
can be inspected through `window.probe`. Inspection also writes `probes.png` and `probes.json`.
Neither global is exported by the runtime package.
The `/editing/` fixture exposes `window.editingFixture` with content-free document/view/input
counters, explicit bounded text readers for assertions, and disposal. Conflict snapshots include
reasons and attempted lengths; the recovery text requires an explicit reader. Inspection types
in a 100,000-line document and records `editing-lines.png` plus `editing.json`.
It also records `editing-provider.png`, `editing-find.png` and `editing-services.json`, requiring
a real worker offer and exact highlighted search/diagnostic text before capture. The fixture
snapshot includes bounded lexer cache, search progress/step and replacement-transaction timings,
and posted/received/applied/stale/invalid/failed provider counters. Text readers are explicit.
The plain/React hosts expose `window.hostFixture` only in development. Snapshots omit text,
include request/proposal/save/acknowledgement versions and live view/subscription counters,
and support explicit mount/unmount/dispose. Inspection records failed acknowledgement and
successful retry. React Profiler counts observe commits, without render-time mutation.
Runtime `workspace.diagnostics()` contains counts only.
Routine buffer polling uses `TextBuffer.readMetrics()` for frozen export/read counters in
constant work. `TextBuffer.diagnostics()` also validates/counts the complete retained tree and
belongs in explicit diagnostics outside polling/timed subscribers. The bulk-replacement probe
exposed and removed that tree walk from readiness polls; older wall proxies include its overhead.

`npm run test:browsers` uses Chromium, Firefox and WebKit. Assertions exercise actual typing,
model revision changes, independent structured editing, and moving a view with its selection.
JSON reports include discovered/executed tests. Missing readiness, browser installation or
test discovery fails the command. Retained traces make failures reviewable by an agent.

`npm run bench` measures all six pinned corpora at start/middle/end, warms up five inputs,
then records twenty samples per condition. It separately runs a 60-sample seeded headless
replay for each corpus. Reports include raw samples, p50/p95, browser, Node version, CPU,
viewport/font, seed and content hashes for every nonignored source file. All commands clean
up their own browser/server. Input dispatch, second-frame proxy, aggregate browser layout/style
and startup are distinct fields. `npm run bench:trace` exports content-free per-event
layout/paint attribution in a separate diagnostic run. See performance.md for metric boundaries
and limitations; no timing here certifies physical presentation latency.
`bench:viewport` separately measures programmatic range edits and bounded read-only projection.
`bench:editing` measures actual keyboard insertions through the bounded input candidate. Its
input-handler time includes model/context work; beforeinput-to-frame-ready is a scheduling
proxy, excluding a physical presentation claim. Both include exact-result and no-export/fallback
guards. Their raw reports are separate from the native-control baseline.
`bench:services` separately measures global literal search and atomic replacement. It asserts
full counts (including dense matches), bounded display previews, zero whole-buffer exports,
one revision/history unit per replacement and exact undo restoration. Smaller conditions repeat
ten measurements; the 100,000-line replacement is one diagnostic observation. A real worker
result is mandatory. Transaction and scheduling boundaries remain distinct from display latency.

Next instrumentation milestones:

1. Extend the separated input/model/layout/paint measurements to renderer and idle work;
   report Event Timing/Long Tasks where available, with unsupported metrics marked absent.
2. Compare cold load, large paste, scroll, search, fold, diff, many views, form interactions,
   rapid switch/close and repeated mount/dispose. Record DOM nodes and retained memory when
   supported, distinguishing noisy browser estimates from exact counters.
3. Extend the fixed seeded Unicode/long-line replay to mapping/history and full request
   lifecycles. Production tracing is opt-in and excludes text
   and credentials by default; exporting content requires explicit host action.
4. Establish hardware-labelled budgets from repeated same-machine measurements. Keep raw
   samples and distinguish compile/startup costs from warm operations. Do not compare CI
   machines as if they were identical or claim speed from one run.
5. For optional workers/WASM, require a handshake plus a verified result from that path.
   Test deliberate startup failure and fallback. Never let a fallback turn an accelerator
   test green without exercising the accelerator.
6. Supplement automation with native IME and OS clipboard checks. Synthetic
   composition events and Chromium alone are not evidence of broad browser correctness.
