import type { HostActionsTools, ActionNote } from "./code-actions.ts";
export function actionsControls(tools: HostActionsTools) {
    const s = tools.state.getSnapshot();
    return [
        { label: "Preview module action", invoke: tools.request, disabled: !s.available || s.disconnected || s.pending },
        { label: "Apply captured action", invoke: () => tools.apply(s.token), disabled: !s.canApply },
        { label: "Dismiss action preview", invoke: tools.cancel, disabled: s.token === null },
        { label: "Disconnect action provider", invoke: tools.disconnect, disabled: !s.connected && !s.pending },
        { label: "Reconnect action provider", invoke: tools.reconnect, disabled: !s.disconnected && s.status !== "failed" }
    ];
}
export const actionsDescription = "Preview an import of the chosen module into the captured working source. Existing exact import lines disable the action. This local fixture uses its own bounded import policy; it does not resolve symbols, modules or types.";
export const actionTarget = (at: ActionNote): string => `${at.title} · ${at.resource} · ${at.document} @ revision ${at.revision} · [${at.from},${at.to})\nInsert ${JSON.stringify(at.insert)}\nContext: ${at.context}`;
export function mountActionsPanel(host: HTMLElement, tools: HostActionsTools): () => void {
    const owner = host.ownerDocument, heading = owner.createElement("h2"), description = owner.createElement("p"), status = owner.createElement("output"), label = owner.createElement("label"), module = owner.createElement("input"), controls = owner.createElement("div"), title = owner.createElement("p"), edits = owner.createElement("ol"), changed = owner.createElement("button");
    heading.textContent = "Code actions"; description.textContent = actionsDescription; status.setAttribute("aria-label", "Code action status");
    module.type = "text"; module.maxLength = 64; module.value = tools.state.getSnapshot().module; module.oninput = () => tools.setModule(module.value); label.append("Action module ", module); tools.bindModule(module);
    title.setAttribute("aria-label", "Captured action title"); edits.setAttribute("aria-label", "Proposed action edits"); changed.onclick = tools.openChanged;
    const buttons = actionsControls(tools).map(action => { const button = owner.createElement("button"); button.textContent = action.label; controls.append(button); return button; });
    host.replaceChildren(heading, description, status, label, controls, title, edits, changed); let previous: unknown;
    const render = () => { const s = tools.state.getSnapshot(); status.textContent = s.message; if (module.value !== s.module) module.value = s.module; title.textContent = s.title;
        for (const [i, action] of actionsControls(tools).entries()) { buttons[i]!.disabled = action.disabled; buttons[i]!.onclick = action.invoke; }
        if (previous !== s.edits) { previous = s.edits; edits.replaceChildren(...s.edits.map(at => { const li = owner.createElement("li"), pre = owner.createElement("pre"); pre.textContent = actionTarget(at); li.append(pre); return li; })); }
        changed.hidden = !s.changed; changed.disabled = s.token !== null; changed.textContent = s.changed ? `Open action changes in ${s.changed.title}` : "Open action changes";
    };
    const stop = tools.state.subscribe(render); render(); return () => { stop(); tools.bindModule(null); host.replaceChildren(); };
}
