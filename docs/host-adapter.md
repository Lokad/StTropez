# Host adapter fixture

The [browser workflow slice](host-workflows.md) runs this contract with the native control and
the bounded candidate through `?editor=native` or `?editor=candidate`. It includes deferred Run,
input recovery and command settlement during disposal in both plain and React hosts.

`/hosts/plain/` and `/hosts/react/` share the persistent `HostController` in
`examples/hosts/controller.ts`. Both mount two independently identified views of one document
and an independently versioned typed form. Data and deferred services are synthetic. React and
its types are pinned development dependencies and never enter the runtime build or package.

## Controller boundary

Construct the controller outside component render at the host composition boundary. Stable
readonly handles expose editor resources/review state and host-owned layout, modal, navigation,
settings and activity snapshots. Modal/navigation alternatives are discriminated unions. Shared
text has one workspace authority; immutable request/save captures are operation inputs, not
second writable text cells. Form schema and validation belong to the host.

The small fixture `HostCell` demonstrates a scheduler; it is not a package API or another
reactive library. A consuming application uses its own cells, pure selectors and observer hooks
against `Observable<T>`. Unchanged source metadata and form snapshots retain identity through
typing. React reads handles through `useSyncExternalStore`. Components read snapshots and return
elements; events invoke controller commands. No effects, layout effects, memo callbacks or local
React state manage application/editor state. Profiler counters run at commit time, outside render.

Queued host writes and editor commands have different completion semantics. The fixture queues
a settings write, applies an editor transaction synchronously and invokes Run before and after
awaiting that write. The asserted order is `edit:true`, `run:preview`, `write:inspect`,
`run:inspect`. Observable read compatibility does not imply equivalent write APIs.

## DOM and lifecycle boundary

`ViewBindings` owns stable primary/secondary refs and preserves selection/scroll independently.
Detach captures view state, destroys the editor and removes subscriptions. Attach mounts the
exact current tab and restores that view state. Controller/resources survive moves and remounts.
View keys are stable identities; delayed work never uses tab array position or later focus.
The React mount key includes tab ID/generation so replacement remounts an expired binding.
Saved view state is keyed by view identity and document ID, preserving each resource's cursor
without carrying another document's selection into it.

React owns each empty editor container and surrounding controls; StTropez owns its descendants.
The plain host uses the same explicit mount/destroy boundary. Strict Mode's extra ref cycle must
leave exactly two active views and the expected subscription count. `workspace.diagnostics()`
counts live registrations even on released handles, so registry removal cannot hide a missing
unsubscribe.
The fixture's explicit React `mount` completes its initial render synchronously, including
Strict Mode ref replay, before it reports readiness or returns to imperative input. This closes
the interval in which a transient textarea could receive an edit before being replaced.
Ordinary observable updates still flow through `useSyncExternalStore`; no effect manages editor
or application state. A browser assertion remounts and immediately verifies stable live views.

React root error callbacks report to the controller. An injected form render failure unmounts
views while retaining the document. The host-owned Recover views control clears the failure and
explicitly renders again. Controller state is never recreated or synchronized in an effect.
Fixture controls/CSS are generic host UI; consuming-host controls, tokens and existing observer
hooks remain that application's responsibility.

## Executable acceptance

`tests/browser/hosts.spec.ts` runs both hosts in Chromium, Firefox and WebKit and verifies:

- Proposal/correction/save/failed acknowledgement/retry/next request, immutable inputs during
  form changes, and late-reply rejection after interruption.
- Two deferred saves and a newer proposal: retrying an older receipt never repeats save or
  retires the newer proposal, and later human text survives.
- Move/close/replace/reopen during resource operations, dirty prompt expiration and stale load
  presentation rejection.
- Independent selections through movement/remount, zero unrelated form/metadata commits during
  typing, stable subscription counts and no listeners/views/timers after fixture disposal.
- Queued host-write ordering, captured Run inputs, and React root error recovery with unsaved text.

`npm run inspect` records both hosts after failed acknowledgement and successful retry, with
screenshots and content-free counters/state. Both editor modes also exercise deferred Run and
host input recovery. These fixtures prove the generic adapter contract; the consuming host
separately verifies its hooks, lint rules and service policies. Native-device input and assistive
technology remain explicit qualification gates. Shared history
and retained selection handles are covered by [the document/view contract](history.md).
