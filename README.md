# StTropez

StTropez is a standalone TypeScript editor and workspace foundation.
It provides source editing, shared undo/redo, search, folding, comparison and language-server integration.
Runtime code has **zero third-party dependencies**.
The host owns storage, services, framework state and surrounding controls.
The preferred distribution is an assets-only NuGet package; browser execution is independent of .NET.

Start with the [documentation index](docs/README.md), [embedding guide](docs/getting-started.md)
or [packaging contract](docs/packaging.md). The [support matrix](docs/README.md#support-matrix)
defines the implemented subset and unverified native-input, clipboard and device boundaries.

## Try the demo

Open the [browser-only TypeScript demo](https://lokad.github.io/StTropez/), or run it locally
with Node.js 24 or later:

```sh
npm ci
npm run demo
```

Open `http://127.0.0.1:4173/`. Edit a sample project, inspect diagnostics and generated
JavaScript, review Changes and save in the browser. Edited programs are not executed.
The server binds to loopback and does not open a browser window. Compiler/provider dependencies
belong to the example and are excluded from the editor package.

The [example guide](docs/examples.md) describes the samples, providers and development hosts;
[static hosting](docs/examples.md#static-build-and-deployment) describes the deployment build.
`npm run dev` starts the same server, including the additional development fixtures.
Use `STTROPEZ_PORT` for a different source-server port and `STTROPEZ_DEMO_PORT` for static preview.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run demo` | Local TypeScript demo and development fixtures |
| `npm run build` | Compiled library modules, declarations, CSS and manifest |
| `npm run build:demo` | Static demo using the compiled library assets |
| `npm run preview:demo` | Serve the built static demo locally |
| `npm run check` | Types, documentation examples, models, library build and Chromium tests |
| `npm run check:docs` | Compile public TypeScript documentation examples |
| `npm run browsers:install` | Install the configured Playwright browser binaries |
| `npm run test:browsers` | Source browser tests across Chromium, Firefox and WebKit |
| `npm run test:demo` | Built static-demo tests |
| `npm run inspect` | Headless behavioral and visual inspection |
| `npm run bench` | Model and keyboard-input measurements |
| `npm run pack:nuget` | Build and pack the local assets-only NuGet archive |
| `npm run test:package` | Qualify restored assets through isolated consuming hosts |

Package commands also require a .NET SDK capable of building the `net10.0` packaging project.
See [testing](docs/testing.md) for focused checks, ownership, readiness, measurement policy
and the native-device checklist. CI runs a selected Chromium gate and built-demo checks;
full multi-engine and package qualification have separate scopes.

## Layout

| Path | Responsibility |
| --- | --- |
| `src/core/` | Headless text, edits, selections, history, resources and computation |
| `src/protocol/` | Headless JSON-RPC/LSP sessions, synchronization and feature clients |
| `src/browser/` | Editor DOM, input, geometry, view controllers and browser adapters |
| `examples/demo/` | TypeScript project demo and example-owned compiler/providers |
| `examples/hosts/` | Plain/React host controllers, forms, deferred services and recovery |
| `examples/playground/` | Mixed-surface workspace fixture |
| `examples/editing/` | Editing, search and language-feature fixture |
| `examples/comparison/` | Reference/working review fixture |
| `examples/viewport/` | Read-only rendering and geometry fixture |
| `examples/probes/` | Input, provider and workspace probes |
| `examples/protocol/` | Protocol integration fixture |
| `examples/shared/` | Shared host presentation, readiness and lifecycle helpers |
| `fixtures/` | Deterministic text/workspace workloads and language/protocol peers |
| `experiments/` | Development storage comparisons, excluded from runtime assets |
| `tests/` | Model/browser tests, helpers and isolated-consumer fixtures |
| `scripts/` | Build, development servers, qualification, inspection and measurements |
| `packaging/` | NuGet project, MSBuild bridge and packaged README |
| `licenses/` | Notices for included Unicode data |
| `docs/` | Public contracts, architecture and contributor guides |
| `.github/workflows/` | CI qualification and demo deployment |

[Architecture](docs/architecture.md) defines dependency and ownership boundaries.
Frameworks, compilers, test providers and development tools stay outside the library runtime.

## License

StTropez is [MIT licensed](LICENSE.txt), copyright Lokad. Included Unicode data carries the
[Unicode License V3](licenses/Unicode-3.0.txt). Retain both notices when redistributing assets.
