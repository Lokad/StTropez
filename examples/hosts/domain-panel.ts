import type { HostDomainTools, DomainSnapshot } from "./domain.ts";
type DomainPanelTools = Pick<HostDomainTools, "discover" | "collapse" | "insertImport" | "cancel" | "reveal">;
function domainActions(tools: DomainPanelTools, state: DomainSnapshot) {
    const busy = state.status === "running";
    return [
        { label: "Discover domain regions", invoke: tools.discover, disabled: !state.available || busy },
        { label: "Collapse domain regions", invoke: tools.collapse, disabled: !state.available || !state.foldCount || busy },
        { label: "Insert catalogue import", invoke: tools.insertImport, disabled: !state.available || !state.editable || busy },
        { label: "Cancel domain command", invoke: tools.cancel, disabled: !busy }
    ] as const;
}
/** Annotation activation keeps the displayed session, revision and annotation identity. */
export function domainPanelModel(tools: DomainPanelTools, state: DomainSnapshot) {
    return {
        title: "Domain tools", status: { label: "Domain command status", text: state.message },
        progress: { label: "Domain discovery progress", hidden: state.status !== "running", max: Math.max(1, state.total), value: state.work },
        actions: domainActions(tools, state),
        annotations: { label: "Domain annotations", capture: `${state.token}:${state.revision}`, identity: state.annotations,
            items: () => state.annotations.map(note => ({ key: `${state.token}:${state.revision}:${note.id}`, label: note.label,
                invoke: () => { if (state.token !== null && state.revision !== null) tools.reveal(state.token, state.revision, note.id); } } as const)) },
    } as const;
}
export function mountDomainPanel(host: HTMLElement, tools: HostDomainTools): () => void {
    const initial = domainPanelModel(tools, tools.state.getSnapshot());
    const owner = host.ownerDocument, heading = owner.createElement("h2"), status = owner.createElement("output"), progress = owner.createElement("progress"), notes = owner.createElement("ul"), controls = owner.createElement("div");
    host.setAttribute("aria-label", initial.title); heading.textContent = initial.title; status.setAttribute("aria-label", initial.status.label);
    progress.setAttribute("aria-label", initial.progress.label); notes.setAttribute("aria-label", initial.annotations.label);
    const buttons = initial.actions.map(action => { const button = owner.createElement("button"); button.textContent = action.label; button.onclick = action.invoke; controls.append(button); return button; });
    host.replaceChildren(heading, status, progress, controls, notes); let previous: typeof initial.annotations | undefined, noteButtons: HTMLButtonElement[] = [];
    const render = () => {
        const model = domainPanelModel(tools, tools.state.getSnapshot()); status.textContent = model.status.text; progress.hidden = model.progress.hidden; progress.max = model.progress.max; progress.value = model.progress.value;
        for (const [index, action] of model.actions.entries()) buttons[index]!.disabled = action.disabled;
        if (!previous || model.annotations.capture !== previous.capture || model.annotations.identity.length !== previous.identity.length || model.annotations.identity.some((note, i) => note !== previous!.identity[i])) {
            for (const button of noteButtons) button.onclick = null; noteButtons = [];
            notes.replaceChildren(...model.annotations.items().map(note => { const item = owner.createElement("li"), button = owner.createElement("button");
                button.textContent = note.label; button.onclick = note.invoke; noteButtons.push(button); item.append(button); return item; }));
        }
        previous = model.annotations;
    }; const stop = tools.state.subscribe(render); render(); return () => { stop(); for (const button of [...buttons, ...noteButtons]) button.onclick = null; host.replaceChildren(); };
}
