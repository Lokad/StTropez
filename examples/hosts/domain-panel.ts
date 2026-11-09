import type { HostDomainTools, DomainSnapshot } from "./domain.ts";
export function domainActions(tools: HostDomainTools) {
    const state = tools.state.getSnapshot(), busy = state.status === "running";
    return [
        { label: "Discover domain regions", invoke: tools.discover, disabled: !state.available || busy },
        { label: "Collapse domain regions", invoke: tools.collapse, disabled: !state.available || !state.foldCount || busy },
        { label: "Insert catalogue import", invoke: tools.insertImport, disabled: !state.available || !state.editable || busy },
        { label: "Cancel domain command", invoke: tools.cancel, disabled: !busy }
    ] as const;
}
export function mountDomainPanel(host: HTMLElement, tools: HostDomainTools): () => void {
    const owner = host.ownerDocument, heading = owner.createElement("h2"), status = owner.createElement("output"), progress = owner.createElement("progress"), notes = owner.createElement("ul"), controls = owner.createElement("div");
    heading.textContent = "Domain tools"; status.setAttribute("aria-label", "Domain command status"); status.setAttribute("aria-live", "polite");
    progress.setAttribute("aria-label", "Domain discovery progress"); notes.setAttribute("aria-label", "Domain annotations");
    const buttons = domainActions(tools).map(action => { const button = owner.createElement("button"); button.textContent = action.label; button.onclick = action.invoke; controls.append(button); return button; });
    host.replaceChildren(heading, status, progress, controls, notes); let previous: DomainSnapshot | undefined;
    const render = () => {
        const state = tools.state.getSnapshot(); status.textContent = state.message; progress.hidden = state.status !== "running"; progress.max = Math.max(1, state.total); progress.value = state.work;
        for (const [index, action] of domainActions(tools).entries()) buttons[index]!.disabled = action.disabled;
        if (!previous || state.token !== previous.token || state.revision !== previous.revision || state.annotations.length !== previous.annotations.length || state.annotations.some((note, i) => note !== previous!.annotations[i])) {
            notes.replaceChildren(...state.annotations.map(note => { const item = owner.createElement("li"), button = owner.createElement("button"), token = state.token!, revision = state.revision!;
                button.textContent = note.label; button.onclick = () => tools.reveal(token, revision, note.id); item.append(button); return item; }));
        }
        previous = state;
    }; const stop = tools.state.subscribe(render); render(); return () => { stop(); host.replaceChildren(); };
}
