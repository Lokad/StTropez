# Editor ownership and retained boundaries

`mountEditingCandidate` owns the native input projection, composition capture, ordered input,
delayed commands and its listener/subscription cleanup. During composition it preserves the
captured revision, complete selection set and LF mapping. It refreshes the native projection
outside composition; commit/recovery decides whether the captured edit can still apply.
Named composition start/end functions show that transition without a second state owner.

The internal `mountInputCaret` owns caret DOM, its placement cache and one animation frame.
It reads the adapter's composition state and current document/view; it cannot edit text,
update selections or schedule commands. The adapter disposes it before destroying the viewport.
The viewport owns rendered rows, native geometry, scrolling/folding and layout observers.
Caret reveal after layout change retains the existing revision/selection/fold/scroll guards.

Delayed word/grapheme/navigation commands remain in the adapter because they share captured
tab generation, revision, complete selections, permissions and input ordering. `cancelWord`
releases their scans, timers and prepared rows. Commands never look up the focused editor later.
Splitting those mutable guards into independent services would obscure their atomic validation.

Workspace retains atomic document/history/view updates and notification delivery. Save/agent
policies already operate through captured resource/revision APIs. This review found no concrete
reason to distribute the commit invariants across more mutable services merely to shorten it.

Public LSP clients reuse one internal feature capture/lifetime helper and one provider scope.
The host distinguishes local capture expiry from a pending resolution failure: provider cleanup
cannot replace a malformed-response error with an expiry message. Both success and failure settle
the resolving state. Decoders and confirmed command/edit policy remain separate; command preparation may intentionally
edit before synchronization. Provider/session ownership and command quarantine remain shared.

The local worker protocol v1 stays an internal fixture for bounded completion, faults and late
responses. The public Workspace/browser/LSP APIs are the reusable integration surface. Thin
development adapters still map fixture configuration, captured resource identities and counters
to the shared host UI; they contain no competing protocol session or silent fallback. Unused
clock/workspace constructor arguments were removed. The minimal restored LSP consumer imports
only public entries and demonstrates that these fixture adapters are unnecessary for integration.

Snapshots mix useful readiness/lifecycle state with development instrumentation. Pending input,
commands, scans, frames and disposal support host readiness; rendered/input extents support bounded
work checks. Event counts and handler/turn timing support existing regression/performance owners,
not product decisions or native-latency claims. Two unused counters, `queuedInputTurns` and
`queuedInputWorkMs`, were removed. Retained counters have concrete test/benchmark consumers;
new experiments should not automatically add permanent public metrics.

No renderer framework, competing workspace owner or new shaping pipeline is introduced. The
existing composition, selection, history and lifecycle tests own behavior after the extraction.
