# StTropez

A standalone TypeScript foundation for a browser workspace combining source editing,
structured configuration, review and data operations. Production code has **zero
third-party dependencies**. React, editor libraries and compiler runtimes are not
required by the package.

This is an early scaffold. It contains a headless document/tab model, revision-checked
edits, a native textarea view, and a playground with a host-owned configuration form.
The textarea is an input and instrumentation baseline. Syntax rendering, durable undo,
virtualized layout, language services and production accessibility are roadmap work.

## Run

Requires Node.js 24 or newer.

```sh
npm ci
npm run browsers:install
npm run dev
```

Open `http://127.0.0.1:4173`. The playground uses synthetic data and makes no application
service requests. The development server binds to loopback only.

```sh
npm run check          # Type checking, model tests, build, Chromium tests
npm run test:browsers  # Chromium, Firefox and WebKit
npm run inspect        # Screenshot and machine-readable state
npm run bench          # Browser timing samples and machine metadata
```

Generated evidence is in `artifacts/`; failed browser tests also retain traces in
`test-results/`. Missing browsers, missing readiness, page errors and missing tests
cause failures. Benchmark results describe the native-input baseline, not a completed
editor engine. Their frame timing is a scheduling proxy, not measured physical paint.

## Layout

| Path | Responsibility |
| --- | --- |
| `src/core` | Documents, resource keys, tab lifetimes, transactions; no DOM |
| `src/browser` | Explicitly mounted and disposed browser views |
| `examples/playground` | Synthetic mixed-surface host and development-only agent hooks |
| `tests` | Model invariants and real browser interactions |
| `scripts` | Build, local server, screenshots and benchmark runner |
| `docs` | Architecture, integration boundaries and performance guidance |
| `external` | Ignored reference checkouts; not part of build or package |

`npm run build` emits ESM, declaration files and CSS to `dist/`, checks that the runtime
dependency graph contains only `src/`, and records compressed JavaScript sizes. The
package allowlist contains only `dist/`. The package is private until release metadata
and a license are deliberately selected.

The preferred distribution is a NuGet package containing the browser assets and MSBuild
integration files. NuGet packing is planned; the current build produces `dist/` only.
See [packaging](docs/packaging.md) for the artifact and consumer build contract.

See [the architecture](docs/architecture.md), [performance assessment](docs/performance.md), and
[instrumentation guide](docs/instrumentation.md). The local roadmap is `PLAN.md`.
