import type { HostRenameTools, RenameNote } from "./rename.ts";
export function renameActions(tools: HostRenameTools) {
    const s = tools.state.getSnapshot();
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
export const renameDescription = "Lexical token fixture: scans captured working resources, skipping quoted strings/comments. Includes matching names in different scopes and regular expressions; no type or scope resolution. Preview every target. Dollar identifiers and truncated results are rejected.";
export function renameDescriptionFor(tools: HostRenameTools): string { return tools.usesLsp ? "Enter a new name and request its provider edit preview, then review the captured changes before applying. Changing the name requires a fresh preview. This fixture returns lexical replacements and a source comment; it does not resolve scopes or types. Long edit text is explicitly abbreviated." : renameDescription; }
export function renameTarget(at: RenameNote, symbol: string, name: string): string { return `${at.title} · ${at.resource} · ${at.document} @ revision ${at.revision} · ${at.line + 1}:${at.column + 1} [${at.from},${at.to}) · ${at.before ?? symbol} → ${at.after ?? (name || "(enter name)")}\n${at.context}`; }
export function mountRenamePanel(host: HTMLElement, tools: HostRenameTools): () => void {
    const owner = host.ownerDocument, title = owner.createElement("h2"), description = owner.createElement("p"), status = owner.createElement("output"), label = owner.createElement("label"), name = owner.createElement("input"), controls = owner.createElement("div"), targets = owner.createElement("ol"), changes = owner.createElement("ul");
    title.textContent = "Rename preview"; description.textContent = renameDescriptionFor(tools); status.setAttribute("aria-label", "Rename status");
    name.maxLength = 256; name.type = "text"; name.value = tools.state.getSnapshot().name; name.oninput = () => tools.setName(name.value); label.append("New identifier ", name);
    tools.bindName(name);
    targets.setAttribute("aria-label", "Captured rename targets"); changes.setAttribute("aria-label", "Renamed resources");
    const buttons = renameActions(tools).map(action => { const button = owner.createElement("button"); button.textContent = action.label; controls.append(button); return button; });
    host.replaceChildren(title, description, status, label, controls, targets, changes);
    let previousTargets: unknown, previousChanges: unknown, previousName: string | undefined;
    const render = () => {
        const s = tools.state.getSnapshot(); status.textContent = s.message; if (name.value !== s.name) name.value = s.name;
        for (const [i, action] of renameActions(tools).entries()) { buttons[i]!.disabled = action.disabled; buttons[i]!.onclick = action.invoke; }
        if (previousTargets !== s.locations || previousName !== s.name) { previousTargets = s.locations; previousName = s.name; targets.start = s.page * 64 + 1;
            targets.replaceChildren(...s.locations.map(at => { const li = owner.createElement("li"); li.textContent = renameTarget(at, s.symbol, s.name); return li; })); }
        if (previousChanges !== s.changes) { previousChanges = s.changes; changes.replaceChildren(...s.changes.map(c => { const li = owner.createElement("li"), button = owner.createElement("button"); button.textContent = `Open renamed changes in ${c.title}`; button.onclick = () => tools.openChanged(c.document); li.append(button); return li; })); }
        for (const button of changes.querySelectorAll("button")) button.disabled = s.token !== null;
    };
    const stop = tools.state.subscribe(render); render(); return () => { stop(); tools.bindName(null); host.replaceChildren(); };
}
