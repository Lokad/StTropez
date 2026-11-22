import type { HostNavigationTools, NavigationSnapshot } from "./navigation.ts";
type NavigationPanelTools = Pick<HostNavigationTools, "findDefinition" | "findReferences" | "cancel" | "returnToOrigin" | "previousPage" | "nextPage" | "addCompanion" | "disconnect" | "reconnect" | "setIncludeDeclaration">;

/** Pure presentation of one captured snapshot; list rows are read only when a renderer needs them. */
export function navigationPanelModel(tools: NavigationPanelTools, state: NavigationSnapshot) {
    const pending = state.status === "pending", token = state.token;
    return {
        title: "Symbol navigation", status: { label: "Symbol navigation status", text: state.message },
        progress: { label: "Symbol navigation progress", hidden: !pending, max: Math.max(1, state.total), value: state.work },
        declarations: { label: "Include declarations in references", checked: state.includeDeclaration, change: (value: boolean) => tools.setIncludeDeclaration(value) },
        actions: [
            { label: "Find definition", invoke: tools.findDefinition, disabled: !state.available || pending || state.disconnected },
            { label: "Find references", invoke: tools.findReferences, disabled: !state.available || pending || state.disconnected },
            { label: "Cancel symbol navigation", invoke: tools.cancel, disabled: state.token === null },
            { label: "Return to navigation origin", invoke: tools.returnToOrigin, disabled: !state.canReturn },
            { label: "Previous navigation results", invoke: tools.previousPage, disabled: state.first === 0 },
            { label: "Next navigation results", invoke: tools.nextPage, disabled: !state.hasNextPage },
            { label: "Add navigation companion", invoke: tools.addCompanion, disabled: pending },
            { label: "Disconnect navigation provider", invoke: tools.disconnect, disabled: !state.connected && !pending },
            { label: "Reconnect navigation provider", invoke: tools.reconnect, disabled: !state.disconnected && state.status !== "failed" }
        ],
        results: { label: "Navigation results", identity: `${token}:${state.first}:${state.count}:${state.status}`,
            items: () => state.locations.map(note => ({ key: `${token}:${note.ordinal}`,
                label: `${note.title}:${note.line}:${note.column}${note.declaration ? " · declaration" : ""}`,
                invoke: note.open } as const)) },
    } as const;
}
export function mountNavigationPanel(host: HTMLElement, tools: HostNavigationTools): () => void {
    const initial = navigationPanelModel(tools, tools.state.getSnapshot());
    const owner = host.ownerDocument, heading = owner.createElement("h2"), status = owner.createElement("output"), progress = owner.createElement("progress"), notes = owner.createElement("ul"), controls = owner.createElement("div"), label = owner.createElement("label"), include = owner.createElement("input");
    host.setAttribute("aria-label", initial.title); heading.textContent = initial.title; status.setAttribute("aria-label", initial.status.label);
    progress.setAttribute("aria-label", initial.progress.label); notes.setAttribute("aria-label", initial.results.label); include.type = "checkbox"; label.append(include, initial.declarations.label); include.onchange = () => initial.declarations.change(include.checked);
    const buttons = initial.actions.map(action => { const button = owner.createElement("button"); button.textContent = action.label; button.onclick = action.invoke; controls.append(button); return button; });
    host.replaceChildren(heading, status, progress, label, controls, notes); let previous: string | undefined;
    const render = () => {
        const model = navigationPanelModel(tools, tools.state.getSnapshot());
        status.textContent = model.status.text; progress.hidden = model.progress.hidden; progress.max = model.progress.max; progress.value = model.progress.value; include.checked = model.declarations.checked;
        for (const [index, action] of model.actions.entries()) buttons[index]!.disabled = action.disabled;
        if (previous !== model.results.identity) {
            notes.replaceChildren(...model.results.items().map(note => { const item = owner.createElement("li"), button = owner.createElement("button");
                button.textContent = note.label; button.onclick = note.invoke; item.append(button); return item; }));
        }
        previous = model.results.identity;
    }; const stop = tools.state.subscribe(render); render(); return () => { stop(); host.replaceChildren(); };
}
