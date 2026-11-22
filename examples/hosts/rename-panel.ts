import { createToolPanel } from "./tool-panel.ts";
import { changedFiles, createChangedFileList } from "./edit-review.ts";
import type { HostRenameTools, RenameNote, HostRenameSnapshot } from "./rename.ts";
type RenamePanelTools = Pick<HostRenameTools, "prepare" | "cancel" | "showPage" | "disconnect" | "reconnect" | "bindName" | "setName" | "openChanged">;
export function renamePageActions(tools: Pick<HostRenameTools, "showPage">, s: HostRenameSnapshot, previous: string, next: string) {
    const { preview, reviewKey, page, count, locations } = s;
    const action = (label: string, destination: number, enabled: boolean) => ({
        label, reviewKey, disabled: !preview || !enabled, invoke: () => { if (preview && enabled) tools.showPage(preview, destination); }
    });
    const last = locations.at(-1);
    return [action(previous, page - 1, page > 0), action(next, page + 1, !!last && last.ordinal + 1 < count)];
}
function renameActions(tools: RenamePanelTools, s: HostRenameSnapshot) {
    return [
        { label: "Prepare rename preview", invoke: tools.prepare, disabled: !s.available || s.disconnected || s.pending },
        { label: "Apply captured rename", reviewKey: s.reviewKey, invoke: () => s.preview?.confirm(), disabled: !s.canApply },
        { label: "Dismiss rename preview", invoke: tools.cancel, disabled: !s.pending && !s.preview },
        ...renamePageActions(tools, s, "Previous rename targets", "Next rename targets"),
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
        targets: { label: "Captured rename targets", identity: s.locations, start: s.page * 64 + 1,
            items: () => s.locations.map(at => ({ key: at.ordinal, text: renameTarget(at) } as const)) },
        changes: changedFiles("Renamed resources", "Open renamed changes in ", s.changes, s.pending || !!s.preview, id => tools.openChanged(id)),
    } as const;
}
export function mountRenamePanel(host: HTMLElement, tools: HostRenameTools): () => void {
    const { owner, initial, controls, mount } = createToolPanel(host, tools.state, state => renamePanelModel(tools, state));
    const label = owner.createElement("label"), name = owner.createElement("input"), targets = owner.createElement("ol"), changes = createChangedFileList(owner, initial.changes.label);
    name.maxLength = initial.name.maxLength; name.type = "text"; name.value = initial.name.value; name.oninput = () => initial.name.change(name.value); label.append(initial.name.label, name);
    initial.name.bind(name);
    targets.setAttribute("aria-label", initial.targets.label);
    let previousTargets: unknown;
    return mount([label, controls, targets, changes.element], model => {
        if (name.value !== model.name.value) name.value = model.name.value;
        if (previousTargets !== model.targets.identity) { previousTargets = model.targets.identity; targets.start = model.targets.start;
            targets.replaceChildren(...model.targets.items().map(at => { const li = owner.createElement("li"); li.textContent = at.text; return li; })); }
        changes.render(model.changes);
    }, () => initial.name.bind(null));
}
