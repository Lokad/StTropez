# StTropez

StTropez is a standalone TypeScript editor and workspace foundation.

- Runtime code has zero third-party dependencies. Development tools may depend on packages.
- Preferred distribution is an assets-only NuGet package. Keep the browser implementation independent of .NET; the package supplies compiled modules, declarations, CSS and build integration, without consumer-time compilation or an additional package installation.
- `src/core` is headless and must not import DOM, React, Node, networking or storage APIs.
- `src/protocol` is headless and may depend on core. Supply transport and scheduling through interfaces; keep DOM, Node and platform networking/storage APIs out of this layer. Browser transport adapters belong in `src/browser`.
- `src/browser` owns its DOM subtree. A host owns surrounding application UI and services.
- React examples use controllers with stable observable handles for shared state and pure function components. Effects register/clean up listeners; never use effects, layout effects or memo callbacks to synchronize or manage application/editor state. Mount views through stable refs or explicit host lifecycle APIs. Keep reactive libraries and design-system components in the host.
- Keep resource identity, document revision, tab identity and view state separate. Never address delayed work by a tab's array position or by whichever editor is focused later.
- Preserve strict TypeScript and explicit lifecycle/disposal. Use immutable public snapshots and versioned transactions.
- `external/` is ignored reference material. Do not import or copy its implementation into production. Any future upstream code reuse requires explicit licensing and attribution review.
- Keep external-editor comparisons, upstream source links and revision manifests in ignored local research. Committable files describe StTropez's own requirements, design and measurements without naming reference editors.
- `PLAN.md` is an ignored local roadmap. Keep all project files generic: no private repositories, tickets, customer data, endpoints, or copied internal implementation details.
- Before adding logic, search this project and relevant public references for an existing solution. Explain a deliberate new implementation where reuse conflicts with the zero-dependency requirement.
- Use `npm run check`, `npm run test:browsers`, `npm run inspect` and `npm run bench` for the relevant change. A native-input prototype is not proof of a production editing engine.
- Use focused owner regressions during implementation; batch broad browser/package qualification at coherent milestones and reuse evidence for unchanged inputs. Test ownership, commands and measurement boundaries are in `docs/testing.md`.
- Use `npm run test:package` for relevant package/consumer changes and `npm run build:demo` with `npm run test:demo` for static-demo changes. Use `npm run check:docs` for documentation links/anchors, public value ownership, prose and TypeScript examples. Select the affected owner checks from `docs/testing.md` instead of repeating unchanged qualification.
- Keep `docs/` organized by subject and describe current behavior in present tense. Put plans in ignored `PLAN.md` and detailed investigations/run evidence in ignored research; do not link tracked documentation into ignored material.
- Give each contract one owning page. Keep the support/device matrix and clock definitions in `docs/README.md`; link to them from other pages. Public behavior changes update their owning page in the same change. Use actual exported names and type-check fenced API examples through the public entries.
- API pages have a purpose paragraph followed by `Use`, `Contract`, `Host responsibilities` and `Not covered`. Describe guarantees, validation and limits; omit delivery narratives, milestone labels, dates, commit hashes, pass counts and measured-run timings. `Not covered` links to the support matrix. Contributor guides can use shell/text examples without an artificial API snippet.
- On a shared desktop, keep browser automation headless or in the background. Do not activate applications, inject global input or change the OS clipboard without coordinating with the user. Keep test servers separate from the user's interactive demo server.
- Do not add a WASM compiler or runtime until a measured kernel experiment justifies it. Keep a TypeScript implementation and test semantic equivalence.
- No publishing, remote creation or application-service integration is part of the scaffold.
