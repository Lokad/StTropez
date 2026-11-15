# Captured document colors and presentation edits

This page describes the default local-worker fixture. The `language=lsp` route
uses [public document-color and presentation clients](lsp-language.md) with these
same host controls, arbitrary provider labels and captured edit confirmation.

Both candidate hosts expose **Discover document colors** (F6 in a source), a paged
inspector and **Proposed color** host field. Inspecting a result focuses/selects
that field; typing changes no source text. Enter requests presentations. Choose
**Color presentation**, review every proposed edit, then explicitly confirm with
**Apply captured color**. Escape in the inspector/field dismisses it and returns
to the source. Primary, secondary and comparison working origins retain their
resource/view identities; delayed discovery does not steal new host form focus.

The actual resident worker scans common literal spellings: hex3/4/6/8 and legacy
comma-separated RGB/RGBA numbers or percentages. Finite channels follow normalized
sRGB/RGBA values, including alpha and clamping. RGB percentage components must
use the same unit; scientific numbers are supported. This is a literal fixture,
including strings/comments, rather than a CSS or language parser. Keywords,
HSL/HWB, modern space-separated functions, color spaces, context/type resolution
and full consuming-host/protocol qualification remain required where needed.

No reusable parser was present and runtime dependencies are prohibited. The owned
scanner retains at most96 token units and one carried surrogate, rejects cut word
boundaries and reads at most16,384 fresh UTF-16 units per continuation. It uses
acknowledged project buffers/deltas, not a source mirror on the host. Scope is one
document up to16 Mi units,1,024 references and64 visible results; incomplete or
oversized results are rejected in full. Long malformed tokens remain bounded.

Every reference is checked for source/revision identity, raw range, exact source
text, numeric RGBA, token boundaries, order and non-overlap. Swatches use CSS made
only from validated numeric channels. Labels are bounded plain text. The existing
interval index supplies a generic dotted underline in bounded visible fragments
of all attached views of that resource. The source marker does not change font
metrics or supply a native color picker. The host inspector shows the actual
numeric color, independently of the source spelling.

Presentation requests separately capture discovery/reference identity, proposed
RGBA, revision, complete origin selections and visible fold projection. Discovery and each
presentation preview use `captureViewRequest` as read captures. Ready references retain their
resource guards separately, so view movement does not discard the list. Application consumes
the preview capture once, with edit permission checked separately. The worker checks
the captured literal and returns edit-bearing hex/RGBA choices. Hex is offered only
for byte-representable channels, so alpha is never silently quantized; otherwise
RGBA preserves the value. Every choice and every primary/additional edit passes
the shared whole-batch validator before publication. The primary edit must cover
the captured literal and preserve the proposed color. Targets/revisions, ordered
non-overlapping ranges,256 edits and16,384 inserted units are bounded. Preview
context is capped around each edit's start; a wide additional edit cannot copy its
entire replaced range. Labels, source strings and commands never execute.

Source text, authority, composition, lifecycle and pending input/navigation/table
conversion invalidate captured work. A ready reference list allows ordinary
selection/fold movement; a presentation captures the latest complete set and is
discarded when that set/fold changes. Editing the proposed value also cancels its
preview while retaining valid references. Interrupted transport can reconnect and
validate the captured reference against a freshly synchronized buffer; no stale
preview is reused. Each reply has a5-second deadline and the whole request a30-second
deadline. Core notifications latch invalidity and defer lease cleanup.

Apply checks human/host permission without a lock and uses the existing atomic
workspace edit path as one shared undo command. Origin positions inside a replaced
literal use the existing name-relative selection mapping, clamped without splitting
surrogates. Undo restores the exact original complete set; later corrections remain
separate. A matching presentation is a no-op with no new revision/history. Other
views follow their independent mappings. Immutable review and primary Save/Run
stay independent after editing a secondary resource. **Open color changes in …**
reveals the participating resource. Disposal clears markers and releases field/list
listeners, views, subscriptions, resource leases and workers.

Focused regressions cover raw Unicode/BOM/CRLF, chunk and token boundaries, alpha,
normal/100k sources, keyboard form entry, markers, complete-set history, malformed
later choices, safe labels, stale input/authority/tokens, reconnect, secondary identity
and cleanup. Synthetic composition/table guards do not qualify native IME, OS/app
clipboard or physical display. Those remain unverified. Candidate
beforeinput listener duration, command dispatch and complete worker/view/review
readiness are distinct clocks; bulk correctness is not a latency pass.
