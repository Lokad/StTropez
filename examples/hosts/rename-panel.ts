import type { HostRenameTools, RenameNote, RenameSnapshot } from "./rename.ts";
type RenamePanelTools = Pick<HostRenameTools, "prepare" | "apply" | "cancel" | "previousPage" | "nextPage" | "disconnect" | "reconnect" | "bindName" | "setName" | "openChanged">;
function renameActions(tools: RenamePanelTools, s: RenameSnapshot) {
    return [
        { label: "Prepare rename preview", invoke: tools.prepare, disabled: !s.available || s.disconnected || s.pending },
        { label: "Apply captured rename", invoke: () => tools.apply(s.token), disabled: !s.canApply },
        { label: "Dismiss rename preview", invoke: tools.cancel, disabled: s.token === null },
        { label: "Previous rename targets", invoke: tools.previousPage, disabled: s.page === 0 || s.status !== "ready" },
        { label: "Next rename targets", invoke: tools.nextPage, disabled: (s.page + 1) * 64 >= s.count || s.status !== "ready" },
        { label: "Disconnect rename provider", invoke: tools.disconnect, disabled: !s.connected && !s.pending },
        { label: "Reconnect rename provider", invoke: tools.reconnect, disabled: !s.disconnected && s.status !== "failed" }
    ];
}
export const renameDescription = "Enter a new name and request its provider edit preview, then review the captured changes before applying. Changing the name requires a fresh preview. This fixture returns lexical replacements and a source comment; it does not resolve scopes or types. Long edit text is explicitly abbreviated.";
export function renameTarget(at: RenameNote, symbol: string, name: string): string { return `${at.title} · ${at.resource} · ${at.document} @ revision ${at.revision} · ${at.line + 1}:${at.column + 1} [${at.from},${at.to}) · ${at.before ?? symbol} → ${at.after ?? (name || "(enter name)")}\n${at.context}`; }

/** One captured preview supplies both renderers; formatting stays lazy for retained lists. */
export function renamePanelModel(tools: RenamePanelTools, s: RenameSnapshot) {
    return {
        title: "Rename preview", description: renameDescription, status: { label: "Rename status", text: s.message },
        name: { label: "New identifier ", value: s.name, maxLength: 256, bind: tools.bindName, change: (value: string) => tools.setName(value) },
        actions: renameActions(tools, s),
        targets: { label: "Captured rename targets", identity: s.locations, start: s.page * 64 + 1,
            items: () => s.locations.map(at => ({ key: at.ordinal, text: renameTarget(at, s.symbol, s.name) } as const)) },
        changes: { label: "Renamed resources", identity: s.changes, disabled: s.token !== null,
            items: () => s.changes.map(change => ({ key: change.document, label: `Open renamed changes in ${change.title}`,
                invoke: () => tools.openChanged(change.document) } as const)) },
    } as const;
}
export function mountRenamePanel(host: HTMLElement, tools: HostRenameTools): () => void {
    const initial = renamePanelModel(tools, tools.state.getSnapshot());
    const owner = host.ownerDocument, title = owner.createElement("h2"), description = owner.createElement("p"), status = owner.createElement("output"), label = owner.createElement("label"), name = owner.createElement("input"), controls = owner.createElement("div"), targets = owner.createElement("ol"), changes = owner.createElement("ul");
    host.setAttribute("aria-label", initial.title); title.textContent = initial.title; description.textContent = initial.description; status.setAttribute("aria-label", initial.status.label);
    name.maxLength = initial.name.maxLength; name.type = "text"; name.value = initial.name.value; name.oninput = () => initial.name.change(name.value); label.append(initial.name.label, name);
    initial.name.bind(name);
    targets.setAttribute("aria-label", initial.targets.label); changes.setAttribute("aria-label", initial.changes.label);
    const buttons = initial.actions.map(action => { const button = owner.createElement("button"); button.textContent = action.label; controls.append(button); return button; });
    host.replaceChildren(title, description, status, label, controls, targets, changes);
    let previousTargets: unknown, previousChanges: unknown, previousName: string | undefined;
    const render = () => {
        const model = renamePanelModel(tools, tools.state.getSnapshot()); status.textContent = model.status.text; if (name.value !== model.name.value) name.value = model.name.value;
        for (const [i, action] of model.actions.entries()) { buttons[i]!.disabled = action.disabled; buttons[i]!.onclick = action.invoke; }
        if (previousTargets !== model.targets.identity || previousName !== model.name.value) { previousTargets = model.targets.identity; previousName = model.name.value; targets.start = model.targets.start;
            targets.replaceChildren(...model.targets.items().map(at => { const li = owner.createElement("li"); li.textContent = at.text; return li; })); }
        if (previousChanges !== model.changes.identity) { previousChanges = model.changes.identity; changes.replaceChildren(...model.changes.items().map(change => { const li = owner.createElement("li"), button = owner.createElement("button"); button.textContent = change.label; button.onclick = change.invoke; li.append(button); return li; })); }
        for (const button of changes.querySelectorAll("button")) button.disabled = model.changes.disabled;
    };
    const stop = tools.state.subscribe(render); render(); return () => { stop(); initial.name.bind(null); host.replaceChildren(); };
}
