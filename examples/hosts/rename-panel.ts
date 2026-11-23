import { createPanelTextField, createDestinationList, createToolPanel } from "./tool-panel.ts";
import { changedFiles, editPageSize } from "./edit-review.ts";
import { pageActions } from "./panel-actions.ts";
import type { HostRenameTools, RenameNote, HostRenameSnapshot } from "./rename.ts";
type RenamePanelTools = Pick<HostRenameTools, "prepare" | "apply" | "cancel" | "disconnect" | "reconnect" | "bindName" | "setName" | "openChanged">;
function renameActions(tools: RenamePanelTools, s: HostRenameSnapshot) {
    return [
        { label: "Prepare rename preview", invoke: tools.prepare, disabled: !s.available || s.disconnected || s.pending },
        { label: "Apply captured rename", reviewKey: s.reviewKey, invoke: () => tools.apply(s.preview), disabled: !s.canApply },
        { label: "Dismiss rename preview", invoke: tools.cancel, disabled: !s.pending && !s.preview },
        ...pageActions("rename targets", s.paging),
        { label: "Disconnect rename provider", invoke: tools.disconnect, disabled: !s.connected && !s.pending },
        { label: "Reconnect rename provider", invoke: tools.reconnect, disabled: !s.disconnected && s.status !== "failed" }
    ];
}
export const renameDescription = "Enter a new name and request its provider edit preview, then review the captured changes before applying. Changing the name requires a fresh preview. This fixture returns lexical replacements and a source comment; it does not resolve scopes or types. Long edit text is explicitly abbreviated.";
export function renameTarget(at: RenameNote): string { return `${at.title} · ${at.resource} · ${at.document} @ revision ${at.revision} · ${at.line + 1}:${at.column + 1} [${at.from},${at.to}) · ${at.before} → ${at.after}\n${at.context}`; }

/** One captured preview supplies both renderers; formatting stays lazy for retained lists. */
export function renamePanelModel(tools: RenamePanelTools, s: HostRenameSnapshot) {
    return {
        title: "Rename preview", description: renameDescription, status: { label: "Rename status", text: s.message },
        name: { label: "New identifier ", value: s.name, maxLength: 256, bind: tools.bindName, change: (value: string) => tools.setName(value) },
        actions: renameActions(tools, s),
        targets: { label: "Captured rename targets", identity: s.locations, start: s.page * editPageSize + 1,
            items: () => s.locations.map(at => ({ key: at.ordinal, text: renameTarget(at) } as const)) },
        changes: changedFiles("Renamed resources", "Open renamed changes in ", s.changes, s.pending || !!s.preview, id => tools.openChanged(id)),
    } as const;
}
export function mountRenamePanel(host: HTMLElement, tools: HostRenameTools): () => void {
    const { owner, initial, controls, mount } = createToolPanel(host, tools.state, state => renamePanelModel(tools, state));
    const name = createPanelTextField(owner, initial.name), targets = owner.createElement("ol"), changes = createDestinationList(owner, initial.changes);
    targets.setAttribute("aria-label", initial.targets.label);
    let previousTargets: unknown;
    return mount([name.label, controls, targets, changes.element], model => {
        name.render(model.name.value);
        if (previousTargets !== model.targets.identity) { previousTargets = model.targets.identity; targets.start = model.targets.start;
            targets.replaceChildren(...model.targets.items().map(at => { const li = owner.createElement("li"); li.textContent = at.text; return li; })); }
        changes.render(model.changes);
    }, name.dispose);
}
