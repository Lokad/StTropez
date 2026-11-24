# StTropez

StTropez is a standalone TypeScript editor and workspace foundation.

- Runtime code has zero third-party dependencies. Development tools may depend on packages.
- Preferred distribution is an assets-only NuGet package. Keep the browser implementation independent of .NET; the package supplies compiled modules, declarations, CSS and build integration, without consumer-time compilation or an additional package installation.
- `src/core` is headless and must not import DOM, React, Node, networking or storage APIs.
- `src/protocol` is headless and may depend on core. Supply transport and scheduling through interfaces; keep DOM, Node and platform networking/storage APIs out of this layer. Browser transport adapters belong in `src/browser`.
- `src/kernels` re-exports headless algorithms from core and protocol.
- `src/browser` owns its DOM subtree. A host owns surrounding application UI and services.
- React examples use controllers with stable observable handles for shared state and pure function components. Effects register/clean up listeners; never use effects, layout effects or memo callbacks to synchronize or manage application/editor state. Mount views through stable refs or explicit host lifecycle APIs. Keep reactive libraries and design-system components in the host.
- Keep resource identity, document revision, tab identity and view state separate. Never address delayed work by a tab's array position or by whichever editor is focused later.
- Preserve strict TypeScript and explicit lifecycle/disposal. Use immutable public snapshots and versioned transactions.
- `external/` is ignored reference material. Do not import or copy its implementation into production. Any future upstream code reuse requires explicit licensing and attribution review.
- Keep external-editor comparisons, upstream source links and revision manifests in ignored local research. Committable files describe StTropez's own requirements, design and measurements without naming reference editors.
- `PLAN.md` is an ignored local roadmap. Keep all project files generic: no private repositories, tickets, customer data, endpoints, or copied internal implementation details.
- Before adding logic, search this project and relevant public references for an existing solution. Explain a deliberate new implementation where reuse conflicts with the zero-dependency requirement.
- Support documents up to 512,000 UTF-8 bytes. Keep demo samples, test documents and benchmarks inside this bound.
- Target French AZERTY, US QWERTY and US International keyboards. Support dead-key composition. Non-Latin input methods and right-to-left editing are outside scope.
- Keep the built JavaScript at or below its checked size budget. Lower the budget after a cut. Raising it requires owner approval.
- Cover a defect once, at the layer that owns the behavior. Use focused regressions during implementation. Run `npm run check` at milestones and select affected browser, package, demo and measurement checks from `docs/testing.md`.
- Keep one documentation page per contract. Explain what hosts must do and why. Change prose for a fix only if it changes the host's obligations. Use headings suited to the subject and compile TypeScript examples against public entries.
- Keep support limits and clock definitions in `docs/README.md`. Link there for shared details. Describe current behavior in present tense. Keep investigation notes in ignored research and use Git for change history.
- Use one statement per line and aim for 120 columns in new or edited code. Measure footprint on built assets.
- While simplifying the library, keep new work in the existing benchmark suites, package scenarios, host samples and documentation pages. Add no new host features or measurement counters during this work.
- On a shared desktop, keep browser automation headless or in the background. Do not activate applications, inject global input or change the OS clipboard without coordinating with the user. Keep test servers separate from the user's interactive demo server.
- Do not add a WASM compiler or runtime until a measured kernel experiment justifies it. Keep a TypeScript implementation and test semantic equivalence.
- CI deploys the demo to GitHub Pages on a qualifying push. NuGet publication requires separate owner approval.
