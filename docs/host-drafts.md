# Draft recovery example

The plain and React development hosts expose explicit recovery checkpoints for source,
connection configuration, transfer settings, temporary loaded source and rejected input.
The implementation follows the [host draft-recovery pattern](host-integration.md#save-run-and-draft-recovery)
using IndexedDB and one application-scoped checkpoint slot.

## Workflow

Choose **Keep recovery draft** and wait for the completed checkpoint message. Replacing an
existing checkpoint requires confirmation. A failed open, clone, write or transaction leaves
live inputs intact and reports failure. The example does not advertise a memory fallback as
durable coverage. Typing can continue while storage completes; later edits need a new checkpoint.

After reload, the stored draft is offered separately from freshly loaded resources. The controls
**Restore source draft**, **Restore configuration draft** and **Restore transfer draft** make
independent confirmed choices. Editing one resource does not retarget another restore.
Transfer restoration preserves raw invalid batch input and unknown fields. A later transfer
Save receipt expires its pending restore.

**Restore loaded-source draft** targets the host's temporary loaded-source slot. An absent
slot receives a resource with the fixture's current baseline; an existing slot keeps its
baseline and history. Resource generations expire an intent across load/remove cycles.
**Reopen loaded source** opens the result. Restoring it does not change the original source,
configuration, transfer, comparison, Save or Run targets.

**Inspect stored draft** shows bounded previews. **Discard stored draft** affects storage
without changing live inputs. Storage tokens protect replacement/discard from a newer peer
write, and cross-page notifications invalidate cached coverage. Malformed, unsupported or
foreign-resource data is rejected. Rejected/preedit input is inspectable separately and never
replayed automatically. Uncommitted composition blocks capture and restore choices.

## Format and lifetime

Checkpoints use format 3 with an optional loaded-source copy. Formats 1 and 2 are readable;
a missing transfer or loaded-source copy disables that restore choice. Recovery keys identify
host resources/slots independently of transient tabs and views. The checkpoint contains inputs
and recovery context, not the previous session's undo stack, Run/log history, pending requests
or synthetic server state.

The host installs navigation protection for uncovered inputs, pending editing/composition and
unsettled services. Dismissing the browser's close confirmation leaves the project open;
accepting it makes only committed checkpoint data available on reopening. Settled, covered
inputs do not require a prompt. The service survives view remounts; full host disposal releases
its observers, navigation listeners and storage connection.

See the [support matrix](README.md#support-matrix) for consuming-host persistence and device boundaries.
