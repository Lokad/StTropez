# Agent and performance instrumentation

See [performance.md](performance.md) for the StTropez performance assessment, bottlenecks,
workload matrix and measurement policy.

`npm run inspect` launches an isolated loopback server and headless Chromium, waits for the
playground to become ready, and writes a screenshot plus state metadata. The library itself
exposes no global debug API. The playground's `window.sttropez` offers readiness, document/tab
metadata, bounded timing samples and synthetic fixture generation. It omits document contents.

`npm run test:browsers` uses Chromium, Firefox and WebKit. Assertions exercise actual typing,
model revision changes, independent structured editing, and moving a view with its selection.
JSON reports include discovered/executed tests. Missing readiness, browser installation or
test discovery fails the command. Retained traces make failures reviewable by an agent.

`npm run bench` measures three synthetic sizes, warms up five inputs, then records twenty
samples each. Reports include raw samples, p50/p95, browser, Node version, CPU, viewport and
commit (or `uncommitted`). All commands clean up their own browser/server. The metric starts
at a capture-phase input listener, before the model's input handler, and ends at the second
animation-frame callback. It includes transaction/subscriber work, excludes earlier native
input processing, and is not physical paint latency. It is baseline evidence only.

Next instrumentation milestones:

1. Separately time input dispatch, transaction application, layout, rendering and idle work;
   report Event Timing/Long Tasks where available, with unsupported metrics marked absent.
2. Compare cold load, large paste, scroll, search, fold, diff, many views, form interactions,
   rapid switch/close and repeated mount/dispose. Record DOM nodes and retained memory when
   supported, distinguishing noisy browser estimates from exact counters.
3. Add fixed seeded Unicode/long-line corpora and headless transaction replay, recording
   explicit revision/origin/request metadata. Production tracing is opt-in and excludes text
   and credentials by default; exporting content requires explicit host action.
4. Establish hardware-labelled budgets from repeated same-machine measurements. Keep raw
   samples and distinguish compile/startup costs from warm operations. Do not compare CI
   machines as if they were identical or claim speed from one run.
5. For optional workers/WASM, require a handshake plus a verified result from that path.
   Test deliberate startup failure and fallback. Never let a fallback turn an accelerator
   test green without exercising the accelerator.
6. Supplement automation with native IME, screen-reader and OS clipboard checks. Synthetic
   composition events and Chromium alone are not evidence of broad browser correctness.
