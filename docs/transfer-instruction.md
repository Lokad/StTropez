# Anchored transfer instruction

The plain and pure React evaluation hosts offer one task-specific source/form workflow with
`?editor=candidate`. Place the primary caret on a line such as:

```ts
// @transfer { "destination": "target.csv", "batchSize": "1000", "extra": { "n": -0 } }
```

Choose **Anchor instruction at caret**, or **Insert transfer instruction** to insert a sample
before the caret's line. The form edits this instruction in the existing source resource.
It does not create a second configuration authority or a text model for the form itself.
Connection configuration, transfer settings, saved source, comparison reference and Run inputs
remain independent. The native whole-value editor baseline remains available separately.

## Source conversion and history

The fixture accepts one JSON object on a physical line of at most 4,096 UTF-16 units, preceded
by optional spaces/tabs and `// @transfer `. Destination and batch size are JSON strings;
batch size validation uses the transfer fixture's integer range. Missing/invalid field values
remain editable. Invalid JSON, ambiguous duplicate known fields or an oversized line stay in
source and suspend form edits until corrected. Unknown members, including duplicate unknown
members, retain their source spelling.

Native JSON parsing validates syntax. A bounded scan locates known value spans; edits patch
only the changed string span. Unknown fields, number spelling, whitespace, property order and
unchanged escapes are not reserialized. The textarea projection maps newline changes back to
the original field value, preserving unchanged CRLF values and their JSON escape spelling.

Typing in one field forms a shared source-history group until focus, time or source revision
breaks it. Ctrl+Z/Ctrl+Y and Ctrl+Shift+Z use source history. Ctrl+S/Cmd+S saves source, and
Escape returns focus to the primary editor. These routes preserve the source view's complete
selection set. Source edits map the anchor; undo/redo can restore removed anchors through
immutable buffer identity. A conflicting field edit or edit-authority change rejects stale
input into the existing host recovery store instead of overwriting source.

## Explicit copy into separate transfer settings

**Capture instruction copy** captures the known field values and source revision. The form
continues to show live source values while the status identifies the captured copy. **Finish
instruction copy** updates the captured transfer resource only if its revision, saved version
and edit authority remain current. Later transfer edits expire the copy; later source edits
do not retarget it. Unknown transfer fields remain intact. Cancel/dispose releases copy leases.
Copying never saves or runs anything. Pending copy work keeps the navigation guard active.

## DOM ownership and bounds

The host owns a sibling lane beside the primary viewport. It reserves horizontal space rather
than inserting controls into editor-owned rows. The form follows a rendered row's vertical
bounds even when its text is horizontally scrolled. Folded or virtualized-away rows have no
form controls in the DOM. Narrow views suspend the form; widening/revealing restores it.
Source values and per-view field selection survive view remount. Resizing the form changes
its own layout, not source, history or editor ownership.

Switching the primary view to another document removes the form and its reserved lane. The
anchor remains attached to the original source; returning restores its field selections and
restores field focus only when no other control owns focus.

The viewport's read-only `rowBounds(line)` query returns immutable client-space vertical bounds
for an already rendered row and its revision/fold generation. It returns `undefined` for a
pending render, expired tab, hidden fold, unavailable document or unrendered row. It neither
materializes rows nor measures glyphs. Caret geometry continues to use `coordsAt`.

Synthetic composition tests cover rejected preedit recovery, authority changes and guarded
Save. Real IME/reconversion, OS clipboard, assistive technology and physical display remain
unverified. This fixture demonstrates the declared workflow, not general inline widgets or
production replacement readiness. Protocols, credentials and execution remain outside the editor.
