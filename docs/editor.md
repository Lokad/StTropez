# Editor

The editor combines a bounded native input surface, virtualized text, independent view selections
and shared workspace history. The host supplies a text tab, layout and language rules; the editor
owns its DOM subtree, input scheduling and view-specific commands.

## Use

Load the packaged stylesheet and give the host a bounded height as described in
[getting started](getting-started.md). This attachment function accepts a retained document view
and an optional scroll capture. It restores the view's current complete selections, including
edits made while detached, instead of overwriting them with cached selections:

```ts
import type { DocumentView, TabId, Workspace } from "sttropez";
import { mountEditingCandidate } from "sttropez/browser";
import type { ViewState } from "sttropez/browser";

export function attachSource(
    host: HTMLElement, workspace: Workspace, tab: TabId,
    view: DocumentView, saved?: ViewState
) {
    const editor = mountEditingCandidate(host, workspace, tab, {
        view, ariaLabel: "Source",
        language: {
            tabSize: 4, insertSpaces: true, lineComment: "//",
            blockComment: { open: "/*", close: "*/" }, enter: "keep"
        },
        bracketMatching: true, columnRulers: [80], highlightCurrentLine: true
    });
    try {
        if (saved) {
            const current = view.getSnapshot();
            editor.restoreView({ ...saved, ...current.selection,
                selectionSet: current.selectionSet });
        }
        return editor;
    } catch (error) {
        editor.destroy();
        throw error;
    }
}
```

Before detaching, retain `editor.captureView()`, then call `editor.destroy()`. Keep the supplied
view until its model lifetime ends; dispose it explicitly then. Store captures by document and
view identity. Mounting another resource requires that resource's own view and capture.

## Contract

### Mounting and presentation

`mountEditingCandidate(host, workspace, tabId, options)` returns an `EditingCandidate`. The tab
must identify a text surface; a supplied view must belong to that document and workspace. The
mount captures tab generation and document identity. Replacing a tab invalidates the old target
instead of redirecting input to the replacement. Omitting `view` creates a mount-owned view.

| Option | Behavior |
| --- | --- |
| `view` | Retained host view, or a new independent view when omitted |
| `ariaLabel` | Input label; defaults to the document title |
| `readOnly` | `false` by default; captured for this mount |
| `language` | Host indentation, comment, pair and Enter rules; see [language configuration](#language-configuration) |
| `decorate`, `lineClass` | Host syntax/annotation presentation through the [viewport contract](viewport.md#mounting-and-presentation) |
| `columnRulers`, `highlightCurrentLine`, `fontLigatures`, `scrollBeyondLastLine` | Initial [viewport settings](viewport.md#mounting-and-presentation); live setters are on `editor.viewport` |
| `bracketMatching` | Off by default; `true` or explicit matching limits enable it |
| `characterWarnings` | Off by default; `true` or a [character-warning policy](unicode.md#character-warnings) enables it |

`element` is the editor root and `input` its native textarea. `view` exposes retained model
selections/folds; `viewport` exposes rendering, geometry and presentation controls. The textarea
value is an internal context, not a full-document edit API. Use revision-checked workspace
transactions to replace text. `focus()` focuses the input without browser scrolling.

`readOnly: true` permits navigation, selection, copying and Find while refusing edits, cut/paste,
drop, undo/redo and Find replacement through this mount. Dragging from it offers copying.
Resource permissions and edit locks also gate input; other views and host transactions retain
their own authority. Remount with the retained view to change the mount's read-only policy.

### Native input and ordered commands

The input context contains a bounded selection and surrounding raw source, projected to native
LF coordinates. Large selections use one selected placeholder with reversible model mappings.
Typing replaces the captured source range even when its text is not present in the textarea.
Unrelated edits preserve raw CRLF; ordinary editor Enter uses the contextual line ending.

`beforeinput` captures the native replacement range, document revision and complete model
selection set. `input` uses that range when the native value/caret agree with it; other supported
rewrites use a bounded difference. Replacing a selection with equal text can collapse the
selection without creating a document revision. Projection-driven selection events preserve
existing affinities when endpoints agree.

Composition stages in the primary native input and commits once through shared history.
Starting composition cancels pending commands; cancellation does not revive them. A changed
revision, selection, capability or target rejects stale input for host recovery.

Navigation, deletion, word selection and language planning can yield. Subsequent supported
editing/navigation keys and literal text are retained in order and use the completed destination
selection. Adjacent text retains event-time history grouping; paste and structural commands
keep their own boundaries. Short navigation cases can complete synchronously. A command's
acceptance does not imply that its deferred work or rendering has finished.

Pending input belongs to the captured document/revision, whole selection set, view and tab
generation. Escape, changed authority/selection/revision, composition, copy/cut, host-owned paste
and detach cancel that continuation. Unapplied text is offered to recovery without automatic
retargeting. A failed command releases scans, rows and timers and reports `command-failed` with
the original cause. Text committed before a later callback/presentation failure is not offered
for insertion again. See [input-conflict recovery](host-integration.md#input-conflict-recovery)
for event payloads, pending-text interpretation and destruction ordering.

### Selections and history

Every view has one normalized complete selection set and a primary range. Typing, paste, deletion,
indentation and movement operate on the whole set; the native textarea projects the primary range.
Visible secondary selections/carets use bounded rendered geometry. Offscreen ranges do not create
text nodes. The [workspace view contract](workspace.md#document-views) owns selection setters,
revision validation and retention; [selection primitives](text-model.md#selection-sets) own
normalization and affinity mapping.

Plain typing replaces every range with the same text. Deletion plans all targets before mutation
and merges overlapping deletions, including carets inside one grapheme. Movement preserves
extension anchors and bidi affinities, then normalizes and publishes the result once. Only the
primary destination is revealed. Vertical commands retain each range's measured horizontal
column across short lines until another selection, edit or layout breaks the sequence.

Ordinary adjacent typing or same-direction deletion groups within one second when revision,
complete selection and initiating mount/view agree. Newlines, composition, paste, replacement,
focus loss, selection movement and other-origin edits separate actions. Undo/redo can run through
either editable view. The [workspace history contract](workspace.md#transactions-and-history)
defines linked transactions, save boundaries, permission checks and initiating-view restoration.

### Keyboard and pointer commands

Ctrl/Cmd means either Control or Meta, without Alt. The word modifier is Control, or Option
on Apple platforms. Shift extends movement from each selection's anchor.

| Input | Command |
| --- | --- |
| Left / Right | Grapheme or measured visual movement; see [Unicode navigation](unicode.md#graphemes-and-word-movement) |
| Word modifier + Left / Right | Code-word movement from the active head |
| Up / Down | Previous/next visible line at the retained horizontal column |
| PageUp / PageDown | Move by the viewport's visible page, retaining the column |
| Home / End | Logical line start/end; End excludes CR in CRLF and includes a final lone CR |
| Ctrl/Cmd + Home / End | Document start/end |
| Apple Cmd + Left / Right, Up / Down | Line endpoints, document endpoints respectively |
| Backspace / Delete | Delete selections or the adjacent grapheme |
| Word modifier + Backspace / Delete | Delete selections or a code word |
| Ctrl/Cmd + A | One whole-document selection |
| Ctrl/Cmd + Z, Ctrl/Cmd + Shift+Z, Ctrl+Y | Undo, redo, redo |
| Tab / Shift+Tab | Indent/outdent; read-only views use normal focus traversal |
| Enter | Contextual newline and configured Enter rule |
| Ctrl/Cmd + /, Ctrl/Cmd + Shift+/ | Configured line/block comment commands |
| Escape | Cancel pending commands and keep only the primary range; arm focus traversal |
| Escape then Tab / Shift+Tab | Leave the editor for the next/previous host control |
| Click / Shift+click | One caret / extend the primary range while retaining secondary ranges |
| Alt+click / Alt+drag / Alt+double-click | Add a caret / range / code-word selection |
| Double-click | Select the code-word, symbol or whitespace run within the clicked logical line |

Host tools can own keys before the editor handles them. The editor respects cancelled events
and composition-marked keys, including keyCode 229. Language, search and folding controllers
have their own commands; the [examples](examples.md) describe host bindings for those tools.

Word selection excludes the line terminator and snaps to grapheme boundaries. Keyboard word
movement uses the [code-word policy](unicode.md#graphemes-and-word-movement), not dictionary
segmentation. Pages use `max(1, floor(viewportHeight / lineHeight) - 1)` visible rows; folding
and [comparison alignment](comparison.md) determine the navigation grid.

Pointer selection uses source hit testing, including where the transparent input overlaps text.
The captured pointer owns the gesture. Release, lost capture, cancellation or a changed source/view
ends it. Holding a drag beyond an edge extends selection through logical scrolling; speed is capped
at three viewport lengths per second per axis, with at most 32 ms of movement per callback.
A delayed frame therefore does not imply an unbounded scroll jump. Composition keeps native
input handling instead of source-pointer interception.

### Clipboard and text drag

Copy joins nonempty selected fragments in source order with LF. Cut removes them in one
transaction. Copy/cut with only collapsed ranges leave the event and history untouched. Literal
paste reads plain text during dispatch and inserts the same raw payload at every destination;
it preserves CRLF and does not distribute lines among carets. Empty/nontext payloads change
nothing, including an existing selection or pending command. Clipboard objects are not retained
after dispatch. Hosts can intercept in the input's capture phase and call `preventDefault()`
to own conversion and insertion through [captured host insertion](host-integration.md#captured-insertion-and-structured-paste).

Dragging painted selected text captures source fragments, the whole selection set, revision
and tab/view identity. Editable sources in the same workspace move by default; Control
(Option on Apple platforms) requests a copy. Read-only sources and other workspaces copy.
Drop validates an opaque token and the last accepted target revision/model offset independently
of focus. An active internal drag that loses its token is refused without deleting the source.

Same-document moves use one original-coordinate plan; cross-document moves use shared atomic
history. Undo restores the initiating sets. Dragend does not delete text. External plain text
inserts literally at the accepted offset; HTML is not interpreted and unsupported file drops
do not navigate. Preview text is capped at 160 UTF-16 units. Cancellation/disposal removes the
drop caret, preview and edge-scrolling work.

### Language configuration

`LanguageConfiguration` defines editing rules without requiring a parser or language service.
`configureLanguage(configuration)` validates and replaces the view's configuration, updates tab
geometry and cancels pending commands. It returns `false` during composition or after disposal.
`languageConfiguration()` returns the resolved snapshot. Arrays and delimiter objects are copied
and frozen; callbacks receive the exact immutable buffer and source endpoints.

| Field | Contract |
| --- | --- |
| `tabSize`, `insertSpaces` | Integer 1–256 (default 4); spaces by default, otherwise a tab |
| `lineComment` | Optional nonempty delimiter without CR/LF |
| `blockComment` | Optional nonempty opening/closing delimiters without CR/LF |
| `pairs` | Single-UTF-16-unit opening/closing delimiters, unique openings, no CR/LF; defaults to `()`, `[]`, `{}`; an empty array disables pairing |
| `allowPair` | Receives `PairingContext` with buffer/range, pair and `open`, `close` or `surround` operation; the host owns lexical eligibility and callback cost |
| `enter` | Omitted: newline without indentation copying. `"keep"`: copy indentation. Callback: return `EnterIndent` with `indent: -1 \| 0 \| 1` and optional `split` |

`EditingPair` describes delimiters; `LanguageEditContext` describes the immutable buffer/range.
`ResolvedLanguageConfiguration` supplies validated defaults. `runCommand(EditingCommand)` accepts
`indent`, `outdent`, `line-comment`, `block-comment` or `newline`. It returns `false` when the view
cannot edit, is composing/disposed, or lacks the requested comment rule. Long plans yield, then
commit once after validating the captured target; intermediate planning publishes no text.

Indent inserts one configured unit at every collapsed caret. With any nonempty range, indent/
outdent visits the union of touched lines once; an endpoint at the next line's start excludes
that next line. Outdent removes one tab-size unit in visual columns, including mixed tabs/spaces.
Line comments toggle selected nonblank lines; block comments surround/unwrap selections.
Pair rules can insert, skip a matching closer or surround selected text.

Enter chooses the current row's LF/CRLF terminator, falling back to the preceding terminator
at EOF and LF when absent. Callback indentation removes/keeps/adds one unit and can split the
closing text onto another line. Pairing, comments and cancellable non-composing line-break input
use the same transaction/transform path. Composition and noncancellable input use literal capture.

`resolveLanguageConfiguration` and `planLanguageEdit` provide the same headless planning. The
generator yields between bounded batches; its final `SelectionEditPlan` is a proposal, not a
commit. This example leaves scheduling with the caller and releases a cancelled planner:

```ts
import { planLanguageEdit, resolveLanguageConfiguration } from "sttropez";
import type { SelectionSet, TextBuffer } from "sttropez";

export async function planIndent(
    buffer: TextBuffer, selections: SelectionSet,
    yieldTurn: () => Promise<void>, signal: AbortSignal
) {
    const planner = planLanguageEdit(buffer, selections, "indent",
        resolveLanguageConfiguration({ tabSize: 2 }));
    try {
        while (!signal.aborted) {
            const step = planner.next();
            if (step.done) return step.value;
            await yieldTurn();
        }
        return undefined;
    } finally {
        planner.return({ edits: [], selectionSet: selections });
    }
}
```

Before applying a returned plan, validate its captured revision, complete selections, target and
edit authority. The [workspace transaction](workspace.md#transactions-and-history) performs the
final model validation; the host owns any asynchronous selection/lifecycle guards.

### Edit transforms

`registerEditTransform(transform)` installs one `CandidateEditTransform` and returns its removal
function. A disposed editor or occupied slot throws. `CandidateEdit` contains `expectedRevision`,
proposed original-coordinate edits, resulting `selectionSet`, history `kind` and optional
`adjustNewlines` when the newline command supplied contextual indentation.

Returning `undefined` preserves the plan; returning edits/selections replaces it subject to normal
workspace validation and authority. `complete(applied)` runs after the commit attempt/notifications
and before input refresh. Keep the transform synchronous and tied to its captured view; callback
failure does not roll back an already committed transaction. Undo/redo, external transactions and
drag/drop do not pass through this input-transform slot. The [completion controller](language-features.md#completion)
uses it for snippet mirroring, so a host must coordinate ownership of that slot.

### Bracket matching

`BracketMatcher` compiles asymmetric configured pairs. Its `createCursor(buffer, caret, options)`
captures the immutable source; `next(workBudget)` advances and `dispose()` releases work. The
matcher prefers the character at the caret, then the preceding character when absent or vetoed.
Mixed nesting is validated, including openings that share a closing delimiter. A character with
both eligible roles is `ambiguous`; symmetric quote pairs are insertion/surrounding rules.
`allowPair` supplies lexical eligibility for each examined delimiter's existing range.

```ts
import { BracketMatcher } from "sttropez";
import type { TextBuffer } from "sttropez";

export async function matchBracket(
    buffer: TextBuffer, caret: number,
    yieldTurn: () => Promise<void>, signal: AbortSignal
) {
    const cursor = new BracketMatcher().createCursor(buffer, caret);
    try {
        while (!signal.aborted) {
            const progress = cursor.next(4096);
            if (progress.status === "ready") return progress.result;
            await yieldTurn();
        }
        return null;
    } finally {
        cursor.dispose();
    }
}
```

`BracketMatchOptions` configures total work and depth. `BracketMatchCursor` exposes
`BracketMatchProgress`, including status, reads, work, callback count and failure.
`BracketMatchResult` distinguishes `matched`, `unmatched`, `none`, `vetoed`, `ambiguous` and
`limited`. Only `matched` proves a pair; budget exhaustion must not be displayed as a mismatch.
The host must discard a completed result when its source/selection capture expires.

The browser's `BracketHighlights` handle is `editor.bracketMatching`. Its stable `state`
observable supplies `BracketHighlightSnapshot` for the primary collapsed caret. `configure(true)`
or explicit limits enable matching; `configure(false)` removes its document/view listeners.
Matching does not block input, and its pending work is separate from editor input activity.
Edits, selection, configuration, composition, focus and disposal invalidate stale work, including
changes made inside a host callback. Shadow-root inputs use their own focus root.

Only proven pairs receive decorations, composed with host colors and selections. Style them with
`--st-bracket-background` and `--st-bracket-border`. Call `bracketMatching.refresh()` outside
workspace notification delivery when lexical knowledge changes without a source/configuration
change. Working and reference views require their own snapshot's lexical context.

### View state, activity and limits

`captureView()` synchronizes native selection and returns immutable `ViewState`. `restoreView()`
restores the supplied complete set when present, otherwise its anchor/head selection. Preserve
the retained view's mapped whole set when combining it with saved scroll state. The
[viewport contract](viewport.md#scrolling-and-saved-views) owns scroll anchors, validation and fold
restoration. Editing reveals the primary caret at the nearest edge on both axes and preserves
scroll when the caret fits; explicit host navigation can request a centered reveal.

`activity()` returns a reused immutable `EditingActivity` without measuring layout, collecting
metrics or flushing work. It distinguishes composition/disposal from `pendingInput`,
`pendingCommand`, `pendingCaret`, `pendingWord`, `pendingGrapheme` and `pendingDragScroll`.
A focus/blur caret frame is distinct from unfinished selection/navigation. Compare the viewport's
painted revision, complete set and fold/alignment identities separately. Provider requests,
bracket matching and visible syntax completion have their own readiness conditions.

`snapshot()` adds input sizes, event/commit/conflict counts, queue size and command/scan metrics.
Use the [clock glossary](README.md#glossary) to interpret handler, preparation, continuation and
scan fields. A cancelled `beforeinput` can have no subsequent native `input`; a retained
`lastInputMs` then is not a new sample. The [testing guide](testing.md#readiness-and-visible-continuity)
defines interaction-specific readiness and continuous text/color checks.

| Area | Limit or scheduling policy |
| --- | --- |
| Settled native context | Up to 256 UTF-16 units on each side and 2,048 selected units; at most 2,560 before LF projection |
| Large native insertion | Known cancellable non-composing text that exceeds the context bound commits through the model before native mutation; no synthetic `input` event |
| Composition / missing-data / noncancellable input | Native capture can exceed the settled context bound until commit |
| Ordered input | At most 256 actions and 65,536 UTF-16 units; overflow offers exact unapplied text to recovery |
| Language planning | Yields across 256-range/line batches and bounded whitespace scans; the final transaction scales with the changed content |
| Bracket matching | Default 100,000 total work units and 1,024 nesting levels; positive safe-integer limits; at most 256-unit read windows |
| Bracket cursor advance | Budget at least 256; checkpoint overshoot at most 63 work units; host callback work is separate |
| Browser bracket task | Checks between 256-unit advances; stops after 4 ms or 4,096 work units; one advance/callback can exceed the scheduling target |
| Ordinary reads | Typing, navigation, scrolling and metadata updates do not export the whole document; copying/large edits can require proportional work |

Scheduling bounds are not interaction-latency guarantees. [Viewport limits](viewport.md#rendering-limits)
govern long contextual lines and geometry; [Unicode](unicode.md) owns grapheme/bidi behavior.

### Whole-value text adapter

`mountTextEditor(host, workspace, tabId, { ariaLabel?, view? })` exposes a native textarea baseline
as `MountedEditor`: `element`, `view`, `captureView`, `restoreView` and `destroy`. It shares model
history and view retention but projects the whole document and edits only the primary range.
Its native LF projection maps selection/replacements back to raw source; explicit unrelated
edits preserve CRLF. Rendering and whole-value differences require document-sized work. Use it
only where that cost and native-control behavior suit the host. The bounded editor above is the
implementation used by the main demo and comparison working views.

## Host responsibilities

Own resources, tabs, layout, fonts, language/lexical policy and surrounding controls. Retain views
and scroll captures by identity; never use later focus or tab position to address delayed work.
Keep decoration and language callbacks bounded. Run mutations outside notification delivery.
Coordinate transform/controller ownership and check full interaction readiness before dependent
Save/Run/service captures. Treat rejected input as content-bearing recovery data.

Call `destroy()` to cancel work, release subscriptions/listeners and owned views, and remove DOM.
It is idempotent. Keep recovery listeners installed through destruction, then release host-owned
views/resources when their own lifetimes end. Use stable refs or explicit host lifecycle methods;
do not synchronize editor state in React rendering or effects.

## Not covered

See the [support matrix](README.md#support-matrix) for unsupported features, native-device
qualification and consuming-host requirements.
