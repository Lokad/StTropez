# StTropez

StTropez is a standalone TypeScript editor and workspace foundation.

- Runtime code has zero third-party dependencies. Development tools may depend on packages.
- Preferred distribution is an assets-only NuGet package. Keep the browser implementation independent of .NET; the package supplies compiled modules, declarations, CSS and build integration, without consumer-time compilation or an additional package installation.
- `src/core` is headless and must not import DOM, React, Node, networking or storage APIs.
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
- On a shared desktop, keep browser automation headless or in the background. Do not activate applications, inject global input or change the OS clipboard without coordinating with the user. Keep test servers separate from the user's interactive demo server.
- Do not add a WASM compiler or runtime until a measured kernel experiment justifies it. Keep a TypeScript implementation and test semantic equivalence.
- No publishing, remote creation or application-service integration is part of the scaffold.
