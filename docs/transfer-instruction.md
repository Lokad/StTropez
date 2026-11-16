# Source-backed form example

The plain and React development hosts expose a transfer form beside a source instruction.
With the editor selected, place the primary caret on a line such as:

```text
// @transfer { "destination": "target.csv", "batchSize": "1000", "extra": { "n": -0 } }
```

Choose **Anchor instruction at caret**, or **Insert transfer instruction** to insert an example
before that line. The form edits the existing source resource using the
[source-backed form pattern](host-integration.md#tokenization-annotations-and-forms).
Connection configuration and typed transfer settings are separate resources.

## Source editing

The fixture accepts one JSON object on a physical line of at most 4,096 UTF-16 units,
preceded by optional spaces/tabs and the instruction prefix. Destination and batch size are
JSON strings. Missing or invalid field values stay editable; invalid JSON, duplicate known
fields and oversized lines suspend form editing until corrected in source.

Native JSON parsing validates syntax. A bounded scan locates known value spans; field edits
patch only those spans. Unknown members, number spelling, whitespace, order and unchanged
escape spelling survive without reserialization. Textarea newline projection preserves
unchanged source CRLF values and their JSON escapes.

Field typing uses shared source history until focus, time or source revision breaks the group.
Undo/redo routes to that history; Ctrl/Cmd+S saves source, and Escape returns focus to its editor.
The complete source selection set is preserved. Source maps move the anchor; immutable buffer
identity allows undo/redo to restore a removed anchor. Stale field input enters host recovery.

## Explicit copy and presentation

**Capture instruction copy** retains known field values and source revision. The form continues
showing live values while status describes the captured copy. **Finish instruction copy** updates
only its captured transfer resource, guarded by revision, saved version and edit authority.
Later source edits do not retarget it; later transfer edits expire it. Unknown transfer fields
are preserved. Cancel/disposal releases retention. Copying does not invoke Save or Run.

The host reserves a sibling lane beside the viewport. Controls follow a rendered row's vertical
bounds even when text is scrolled horizontally; folded or virtualized-away rows have no form
controls. Narrow layouts suspend the form. Source values and field selections survive remounts.
Switching documents removes the lane; returning restores field state and restores focus only
when no other control owns it. Resizing the form changes host layout, not source/history.

See [viewport geometry](viewport.md#geometry-and-readiness) for positioning contracts and the
[support matrix](README.md#support-matrix) for native-input boundaries.
