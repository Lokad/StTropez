# Acceptance inventory

This is the generic evaluation inventory. A pilot is a bounded host evaluation, not broad
replacement approval. Every row below is required at its gate unless the consuming host
records an explicit deferral with user impact. No such host deferrals have been accepted.
“Pending” means there is no qualifying evidence yet; scaffold smoke tests do not close a row.

| ID | Gate | Required behavior and executable scenario | Current evidence |
| --- | --- | --- | --- |
| W01 | Pilot M1 | Open two resources with equal labels in different scopes/variants; move, close, replace and reopen during deferred load/confirmation/save; only captured targets complete | Core identity/guard tests plus plain/React deferred-work fixtures pass; consuming-host compatibility remains separate |
| W02 | Pilot M1 | Acquire/release loading, failed, ready text and typed non-text resources; pending operations retain ownership; recover a failed load | Core lifecycle/lease tests and host loading-placeholder/stale-presentation scenarios pass |
| W03 | Pilot M1 | Scoped subscribers, throwing listeners and reentrant commands preserve committed snapshots and deliver to unrelated listeners; typing leaves unrelated metadata/form snapshots identical | Core notification/identity tests and propagation benchmark; reentrant writes reject before mutation |
| W04 | Pilot M1 | Two views and an independent typed form in plain and React hosts; stable keys, Strict Mode remount, queued host writes, error recovery, selection/scroll retention and exact disposal counts | Shared controller fixtures pass in all three engines; real host hooks/design-system verification remains separate |
| S01 | Pilot M1–M3 | Two deferred saves with exact submitted contents, version preconditions, canonical response after human typing, conflict and failed retry; undo to saved content clears dirty | Core and plain/React native/candidate scenarios cover visible conflicts, captured remote comparison, guarded reviewed retry, repeated remote changes, canonical replies and undo-to-saved; real-device input remains pending |
| A01 | Pilot M1–M3 | Associate agent, capture immutable request, exclusive edit lease, interrupt/detach, proposal, human correction, save, failed acknowledgement, acknowledgement-only retry, next request; a saved older proposal never retires a newer proposal | Core and plain/React review/save/acknowledgement and exact undo/redo scenarios pass; final browser input remains M3 work |
| X01 | Pilot M1–M3 | Save and Run target captured source/configuration variants, revisions and settings; focus changes do not retarget; save never implicitly runs | Core immutable Run captures and browser Save/Run target assertions pass; full pilot qualification pending |
| C01 | Pilot M1–M3 | Read-only/history/permission/lease transitions reject every unauthorized edit origin and preserve attempted composition for review | Core capability/lease checks, two-view agent locks, synthetic composition refusal and integrated Tab/outdent refusal across permission restoration; native-device/history qualification pending |
| T01 | Pilot M2–M3 | Range edits, UTF-16 mapping/affinity, newline import/export, independent view selections and bounded shared undo/redo; stale/invalid multi-resource batches publish nothing | M2 indexed-buffer, mapping, history, atomic linked-document and retained-view scenarios pass; see history.md |
| T02 | Pilot M3 | Single selection, arrows/Home/End/Page, word navigation, Backspace/Delete, select all, indentation/outdent, brackets, newline, undo/redo, copy/cut/paste, search and replace; each command has a browser result assertion | Bounded candidate covers typing, code-word/page and complete-row bidi navigation; both hosts integrate multiline commands, brackets, shared history, literal find/replace, synthetic large-range clipboard and focus out/back with review/save activity. Contextual geometry, native clipboard and full qualification remain open |
| U01 | Pilot M3 | Combining marks, surrogate pairs, CRLF, RTL/mixed script, native IME commit/cancel, dead keys, selection, clipboard, focus to adjacent host surfaces and screen-reader announcements | Headless Unicode bidi conformance and complete-row keyboard/pointer/affinity scenarios; native-device IME, dead keys, OS clipboard and assistive technology remain pending |
| L01 | Pilot M3 | Distinguishable local token styles; provider completion replacement ranges, versioned diagnostics, cancellation, stale rejection, disconnect/reconnect; editing works during outage | Bounded-view fixture passes visible incremental tokens, real worker insertion/replacement, scoped diagnostic mapping, malformed/stale/cancel/failure/reconnect guards; full protocol and native-device/AT qualification remain separate |
| D01 | Pilot M3 | Immutable baseline with editable working comparison; whitespace differences, accept/refresh, source revisions and history stay correct through delayed results | Paired virtualized panes, exact line alignment, whitespace visibility, undoable revert and captured refresh/acceptance; advanced review remains M4 |
| P01 | Pilot M0–M3 | Workloads below, bounded viewport/long-line work, background traffic, phase measurements and content-free diagnostics; screenshots plus exact edit assertions | Bounded candidate and complete-row bidi geometry, separate model/interaction/workflow measurements; global contextual geometry, native input and production budgets remain pending |
| T03 | Replacement M4 | Multiple selections; word/line commands; drag/drop; folding; find regex/case/whole-word; shortcut routing; zoom/fonts; bidi navigation | Atomic multiple-range input/history, navigation/creation, whole-word and match-case literal find/replace and captured text transfers have host scenarios. Tokenless internal drags are refused; token-preserving native movement in the current WebKit evaluation environment remains unverified. Worker regex search/capture replacement and raw zero-width navigation have integrated and compiled host evidence. Per-view host-supplied folding covers visible navigation, target reveal, edits/shared undo, comparison, remount and disposal. Captured local domain discovery/annotations preserve independent manual folds; general language policy and remaining replacement/native coverage stay required |
| L02 | Replacement M4 | Hover/signatures, definition/references, rename, code actions, links/colors, safe hover content, host navigation/commands; validate all edits before publication | Captured plain-text hover in both pilot hosts and comparison working views; bounded real-worker results, keyboard/pointer focus and stale/lifecycle guards. Signatures, navigation/references, rename, actions, links/colors and full protocol remain required; native accessibility remains unverified |
| L03 | Replacement M4 | Protocol dynamic registration, server edits, custom messages, reconnect, incremental sync and malformed results; assert actual transport path | Deferred from pilot: limited provider operations only |
| H01 | Replacement M4 | Domain folds/annotations/import insertion, structured table paste via keyboard and browser menu; one undoable transaction | Host-owned HTML/TSV-to-CSV paste covers captured complete selections, one shared undo transaction, stale/authority/composition guards and lifecycle in both hosts. Captured local domain discovery/annotations and atomic imports preserve manual view state, shared history, review, Save/Run and lifecycle, including 100k controls and restored public assets. See [domain policy and limits](domain.md). Guarded Chromium keyboard clipboard is separate from still-unverified OS/application/browser-menu paths; full native qualification remains required |
| D02 | Replacement M4 | Draft/server/history review, discard, stale refresh, delayed loading, takeover and subsequent live/programmatic edits retain human corrections/history | Both evaluation hosts expose captured saved/server/draft/history references, deferred load/failure/cancellation, undoable whole-review discard and stale/takeover/composition guards. Source scenarios preserve later corrections and working Save/Run identity; complete replacement and native qualification remain open |
| Q01 | Replacement M5 | Repeated production p50/p95 with hardware and raw samples, constrained hardware, absolute/relative limits; missing samples/provider paths/browser errors fail | Pending; no performance guarantees |
| Q02 | Replacement M5 | Retained memory/DOM, repeated mount/dispose, inactive tabs and background activity remain bounded | Pending |
| R01 | Replacement M5 | Host-managed unsaved recovery, save error, reconnect/reload, unload/navigation choice and reversible switchback; no promise of portable undo | Deferred from pilot: host must retain/recover unsaved work |
| K01 | M0 proof; M5 qualification | Pack assets only; restore clean consumer; resolve modules/declarations; visible CSS and real edit; then upgrades/downgrades, isolation, optional assets, clean install, metadata/license/compatibility | Local package proof command: `npm run test:package`; release qualification pending |
| F01 | Subsequent M6 | Independent connection, transfer/settings, source preview, immutable run/log resources and links; progress never triggers save/run | Deferred from pilot: synthetic adjacent form only |
| F02 | Subsequent M6 | Independent validation/dirty state; lossless same-resource source/form conversion preserves invalid text/unknown fields/in-flight updates; anchored form maps through edit/fold/undo/resize/virtualization | Deferred from pilot: inline forms unavailable |
| E01 | Optional, after profiling | Compare TypeScript/worker/WASM kernel including transfer/startup/memory and semantic equivalence, prove actual path | No accelerator or compiler planned without measurements |

## Pinned synthetic workloads

`tests/fixtures/workloads.ts` is the source of truth. Text is generated locally from fixed
strings and a declared seed. No downloaded or host-specific corpus is needed.

| Workload | Dimensions and actions | Gate |
| --- | --- | --- |
| `normal` | Small realistic source; first/middle/last range insert, delete, selection replacement, paste | M0 baseline onward |
| `lines-100`, `lines-10000`, `lines-100000` | Repeated 24-code-unit source line; 2,400 / 240,000 / 2,400,000 UTF-16 units; edits at start/middle/end and scroll | M0 baseline onward |
| `single-line` | 2,400,000 ASCII code units, no newline; start/middle/end, horizontal scroll and selection | M0 baseline onward |
| `unicode` | Tabs, combining marks, emoji/ZWJ, RTL, CRLF and LF; range/selection and import/export checks | M0 baseline; M2 mapping; M3 native input |
| `workspace` | 1/10/100 resources, 1/2 active views, 1,000 versioned annotations, 20 background updates/second while typing/moving/closing | M0 stress fixture; M1 subscriptions; M3 rendering; M5 retention |

Initial pilot envelope: desktop source up to 10,000 lines/240,000 code units, 100 resources,
two active text views and one adjacent form. The 100,000-line and huge-line cases are stress
probes and must not freeze input; they are not a promise of full-feature parity at that size.
Renderer budgets will be selected from repeated production evidence; existing native timings
are diagnostic. Startup, asset and retained-memory limits remain unqualified until M5.

The `/probes/` workspace stress fixture exercises the largest pinned workspace with 100
resources/tabs, two shared native views, 1,000 immutable host annotation records and a 20 Hz
background resource. Browser tests assert shared typing, view movement and timer/view disposal.
Annotation rendering/mapping and the smaller workspace combinations remain later engine
scenarios; generating annotation records is not evidence of a production decoration path.

## Browser and native-device matrix

Proposed pilot platform is Windows 11 desktop with US English and French AZERTY keyboards.
The consuming host must confirm this envelope before adoption. Automation uses the exact
Chromium, Firefox and WebKit revisions pinned by Playwright in the lockfile. Browser versions
and OS are recorded in artifacts. Headless WebKit on Windows is not Safari qualification.

| Coverage | Required exercise | Evidence status |
| --- | --- | --- |
| All three automated engines | Real keyboard/selection, input event ordering, native baseline and contenteditable probe; provider outage; explicit edit results | `npm run test:browsers` |
| Windows 11 Chromium and Firefox, US/French hardware keyboards | Navigation, shortcuts, AltGr/dead keys, OS clipboard and browser/menu paste, focus out/back | Manual pending |
| Windows Japanese Microsoft IME and Chinese Pinyin | Start/update/commit/cancel, reconversion, selection, candidate placement at scroll boundary, permission change during composition | Manual pending; synthetic/CDP composition is not native IME proof |
| Windows NVDA with Chromium and Firefox; Narrator with Chromium | Name/role, caret/selection, reading, diagnostic/completion announcements, keyboard-only form/editor routing | Manual pending |
| macOS/Safari/VoiceOver, Linux native input, touch/mobile | Separate native qualification required | Outside initial pilot envelope; no support claim |

Record manual results with OS/browser/AT/input-method versions, date, keyboard, steps, expected
and actual text/selection, and pass/fail. A pending or unsupported cell cannot be converted
into a pass by automated composition events or screenshots.

## Probe decision rules

Time-box the input and language boundary experiments to one development iteration each.
Keep the native baseline. The input probe compares textarea and contenteditable event,
selection and composition behavior without building a renderer. Native-device results remain
a gate before selecting a production input engine. The language probe uses a deterministic
line tokenizer plus a deliberately narrow revisioned transport (completion/diagnostics,
cancel, disconnect/reconnect), independent of view and wire-protocol choice. It is not a full
language client. A probe can reject an approach; passing does not qualify a production editor.

The automated input probe currently demonstrates actual keyboard replacement of a surrogate
pair on both native textarea and contenteditable in all three engines. Chromium's browser
protocol exercises composition start/update/commit and records event trust/selection metadata;
its `compositionend` was untrusted on the measured browser. No production input strategy is
selected from this result. The provider probe round-trips JSON through a real dedicated worker,
asserts exact Unicode completion/diagnostic ranges and visible token colors, rejects late
replies after typing/cancellation, and verifies editing through disconnect/reconnect. This
is a narrow fixture protocol, not evidence that a full language protocol is implemented.

The project implements these small synthetic fixtures locally because taking a complete
editor/client runtime would conflict with the zero-runtime-dependency boundary. Standards
inform event and transport contracts; no reference implementation is copied.
