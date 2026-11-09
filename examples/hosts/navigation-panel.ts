import type { HostNavigationTools, NavigationSnapshot } from "./navigation.ts";
export function navigationActions(tools: HostNavigationTools) {
    const state = tools.state.getSnapshot(), pending = state.status === "pending";
    return [
        { label: "Find definition", invoke: tools.findDefinition, disabled: !state.available || pending },
        { label: "Find references", invoke: tools.findReferences, disabled: !state.available || pending },
        { label: "Cancel symbol navigation", invoke: tools.cancel, disabled: state.token === null },
        { label: "Return to navigation origin", invoke: tools.returnToOrigin, disabled: !state.canReturn },
        { label: "Previous navigation results", invoke: tools.previousPage, disabled: state.page === 0 },
        { label: "Next navigation results", invoke: tools.nextPage, disabled: (state.page + 1) * 64 >= state.count },
        { label: "Add navigation companion", invoke: tools.addCompanion, disabled: pending }
    ] as const;
}
export function mountNavigationPanel(host: HTMLElement, tools: HostNavigationTools): () => void {
    const owner = host.ownerDocument, heading = owner.createElement("h2"), status = owner.createElement("output"), progress = owner.createElement("progress"), notes = owner.createElement("ul"), controls = owner.createElement("div"), label = owner.createElement("label"), include = owner.createElement("input");
    heading.textContent = "Symbol navigation"; status.setAttribute("aria-label", "Symbol navigation status"); status.setAttribute("aria-live", "polite");
    progress.setAttribute("aria-label", "Symbol navigation progress"); notes.setAttribute("aria-label", "Navigation results"); include.type = "checkbox"; label.append(include, "Include declarations in references"); include.onchange = () => tools.setIncludeDeclaration(include.checked);
    const buttons = navigationActions(tools).map(action => { const button = owner.createElement("button"); button.textContent = action.label; button.onclick = action.invoke; controls.append(button); return button; });
    host.replaceChildren(heading, status, progress, label, controls, notes); let previous: NavigationSnapshot | undefined;
    const render = () => {
        const state = tools.state.getSnapshot(); status.textContent = state.message; progress.hidden = state.status !== "pending"; progress.max = Math.max(1, state.total); progress.value = state.work; include.checked = state.includeDeclaration;
        for (const [index, action] of navigationActions(tools).entries()) buttons[index]!.disabled = action.disabled;
        if (!previous || state.token !== previous.token || state.page !== previous.page || state.count !== previous.count || state.status !== previous.status) {
            notes.replaceChildren(...state.locations.map(note => { const item = owner.createElement("li"), button = owner.createElement("button"), token = state.token!;
                button.textContent = `${note.title}:${note.line}:${note.column}${note.declaration ? " · declaration" : ""}`; button.onclick = () => tools.open(token, note.ordinal); item.append(button); return item; }));
        }
        previous = state;
    }; const stop = tools.state.subscribe(render); render(); return () => { stop(); host.replaceChildren(); };
}
