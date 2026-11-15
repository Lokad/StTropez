# Small host integrations

The **Host integrations · paste & notes** demo sample uses public editor APIs for a small
host language, CSV/literal insertion and source notes. No compiler or language server runs
for that sample. These policies belong in the consuming application; shipped editor assets
remain dependency-free. The following pieces can be used independently.

## Captured asynchronous insertion

`editor.captureInsertion("paste")` returns a `CapturedInsertion`, or `undefined` when the
view is unavailable, read-only, composing or finishing ordered input/navigation. `"replace"`
is the other supported history kind. Only one capture can remain pending per editor.

Copy clipboard strings during the event. The host owns parsing, limits, progress and errors:

```ts
import type { EditingCandidate } from "sttropez/browser";

function attachConvertedPaste(editor: EditingCandidate,
    convert: (text: string, signal: AbortSignal) => Promise<string>,
    report: (error: unknown) => void) {
    const events = new AbortController();
    let pending: ReturnType<EditingCandidate["captureInsertion"]>;
    editor.input.addEventListener("paste", async event => {
        if (event.defaultPrevented || !event.clipboardData) return;
        event.preventDefault();
        const text = event.clipboardData.getData("text/plain");
        pending?.cancel();
        const capture = editor.captureInsertion();
        if (!capture) return;
        pending = capture;
        try { capture.insert(await convert(text, capture.signal)); }
        catch (error) { if (!capture.signal.aborted) report(error); }
        finally { capture.cancel(); if (pending === capture) pending = undefined; }
    }, { capture: true, signal: events.signal });
    return () => { events.abort(); pending?.cancel(); };
}
```

Attach this handler only while conversion is selected. Detaching it restores ordinary literal
paste. Read all required formats synchronously; never retain the clipboard event for later use.
Keep conversion cooperative and bounded. The demo's [table converter](table-paste.md) is one
example of host policy, not a required library dependency.

The capture retains exact tab/view/resource authority, revision, directed selection set and
fold generation. Revision/selection/fold/authority changes, composition, later editing or
navigation keys, language reconfiguration, another capture and view disposal invalidate it.
Focus moving to surrounding host UI alone does not retarget it. `isCurrent()` becomes false
immediately; observer-triggered signal abort and lease release occur in a microtask because
workspace observers cannot write. The signal also aborts when the capture completes normally.

`insert(text)` consumes the capture once, replaces every captured selection and returns whether
the edit applied. It runs the editor's existing edit transform, authority validation and shared
history; it never bypasses snippet mirroring. Empty text is a no-op, including with a selection.
`cancel()` is idempotent. Always cancel abandoned work. `snapshot().pendingInput` includes this
operation so host save/run actions can wait. A later edit cancels conversion and proceeds;
a delayed converter cannot overwrite it. No full-document export is needed to capture a target.

## Notes anchored to source

Use `anchoredRange` from `sttropez` for host metadata. Subscribe to `workspace.observeDocument(id)`
and, for consecutive revisions, map each range with `next.change.mapping.mapRange(range)`.
Check `next.change.previousRevision` against the metadata revision; clear or recompute on a gap.
The demo selects `{ onDelete: "invalidate" }`: deleting a range removes its note. Surviving notes
follow undo/redo maps, but undo does not resurrect discarded host metadata. The demo stores at
most 64 notes with 120-character labels. User-added notes last for the project session; they are
not source text or recovery-draft contents.

Render a host-owned sibling overlay. Obtain each visible anchor's rectangle using
`editor.viewport.coordsAt(range.from)` and hide notes outside the editor rectangle. Recompute
after `sttropez-render`, folding changes and resize. A hidden position projects to its fold
header; `editor.view.folding.getSnapshot().index.hiddenBy(line)` lets the host label that case.
Do not cache coordinates across scrolling or write inside the editor's DOM subtree. Unsubscribe
and remove the overlay when that view is detached; dispose the metadata observer when its
project/resource is released. The demo retains mapped metadata when switching tabs or Changes.

## Language rules, colors and commands

Pass `language` to `mountEditingCandidate`, or call `configureLanguage` for a mounted view.
`LanguageConfiguration` supports indentation, comment markers, pairs and an Enter planner.
Use a `LineDecorator` to return source-offset ranges and host CSS classes for presented
fragments. The demo's tiny single-line lexer colors its own rule syntax and quoted CSV; it is
not a general language parser. Folding uses the existing indentation discovery API.

`new BracketMatcher(language)` compiles the asymmetric configured pairs for headless matching.
`createCursor(buffer, caret, options)` captures the immutable buffer; call `next(workBudget)`
cooperatively and dispose the cursor when its owning revision or selection expires. It prefers
the character at the caret, then the preceding character when absent or vetoed. Mixed nesting
is checked, including different openings that share a closing delimiter. A character eligible
as both opening and closing is reported as `ambiguous`; symmetric quote pairs remain insertion
and surrounding rules. String/comment eligibility comes from `allowPair`, called for each
candidate delimiter with `operation: "open" | "close"` and its existing `[from, to)` range.

Results distinguish `matched`, `unmatched`, `none`, `vetoed`, `ambiguous` and `limited`.
Default limits are 100,000 work units and 1,024 nesting levels (`maxWorkUnits`, `maxDepth`).
Each examined UTF-16 unit and eligible-pair check consumes work; reads use at most 256-unit
windows. `next` requires a budget of at least 256 and may overshoot by at most 63 work units.
Host callback time/reads are separate from those counters and are not a wall-clock guarantee.
Only a `matched` result establishes a pair; budget exhaustion must not be presented as a mismatch.

Enable editor presentation with `bracketMatching: true` (or the limit options) at mount, or
`editor.bracketMatching.configure(true)`. It is off by default; disabling it removes its
document/view listeners. The stable `bracketMatching.state` handle reports pending, completed
and failed results for the captured primary collapsed caret. Matching does not block input,
and its pending state is separate from the editor's input/navigation activity. Edits, selection,
configuration, composition, focus and disposal invalidate stale work, including a host callback
that changes the document during a scan. A shadow-root input uses its own focus root.

Decorations compose with host colors and selections, using `--st-bracket-background` and
`--st-bracket-border`. Only proven pairs are highlighted. Call `bracketMatching.refresh()` when
host lexical knowledge changes without a document/configuration change; queue it outside a
Workspace notification. The demo enables matching for working and reference editors using
each snapshot's own syntax context. A browser turn checks elapsed time between 256-unit advances
and stops after 4 ms or 4,096 work units; a single batch or host callback can exceed that target.

`CharacterWarnings` classifies advisory Unicode18 ranges without changing source text.
Its `categories` switches independently control `bidi-control`, `invisible` (default-ignorable
characters), `bom` (U+FEFF after offset zero), `non-breaking-space` and `unusual-space`.
All categories are enabled by default; `allow` copies an exact list of permitted characters.
Ordinary space, tab, LF and CR, letters in other writing systems, and ordinary combining marks
are not warnings. Joiners and variation selectors may be meaningful; hosts choose their policy.

`scan(buffer, from, to, limits)` returns immutable warning ranges, category and code point.
It reads at most `maxUnits + 5` UTF-16 units, including boundary/lookahead checks; defaults are
4,096 scanned units and 256 warnings. A limited batch supplies `nextFrom` for continuation
against the same buffer and original end. Queries include complete code points intersecting
the requested range, even at a clipped surrogate boundary. `scanText(text, absoluteOffset)`
handles an already bounded, complete-code-point fragment. `characterWarningLabel` supplies a
plain-text category/code-point description. These ranges are advisory, not a language-validity
or security-profile verdict.

Host buttons and keyboard listeners can call `editor.runCommand("line-comment")` or capture
an insertion. The sample exposes **Code → Paste format**, **Insert example table** and
**Add source note**. Ctrl+Alt+V changes paste mode; Ctrl+Alt+M adds a note. The example-table
button makes conversion inspectable without touching the OS clipboard. Comparison, save and
undo use the same document and public controllers. Native clipboard/layout/IME checks remain
unverified; automated synthetic events do not establish those capabilities.
