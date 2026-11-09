import type { HostProjectTools } from "./project.ts";
export function projectActions(tools: HostProjectTools) {
    const s = tools.state.getSnapshot(), unavailable = !s.available || s.disconnected || s.pending;
    return [
        { label: "Register provider review command", invoke: tools.register, disabled: unavailable || s.registered },
        { label: "Unregister provider review command", invoke: tools.unregister, disabled: unavailable || !s.registered },
        { label: "Request provider review edits", invoke: tools.requestEdits, disabled: unavailable || !s.registered },
        { label: "Request provider workspace status", invoke: tools.requestStatus, disabled: unavailable },
        { label: "Cancel workspace provider request", invoke: tools.cancel, disabled: !s.pending },
        { label: "Disconnect workspace provider", invoke: tools.disconnect, disabled: !s.connected && !s.pending },
        { label: "Reconnect workspace provider", invoke: tools.reconnect, disabled: !s.disconnected && s.status !== "failed" }
    ] as const;
}
export function mountProjectPanel(host: HTMLElement, tools: HostProjectTools): () => void {
    const owner = host.ownerDocument, heading = owner.createElement("h2"), status = owner.createElement("output"), controls = owner.createElement("div"), changed = owner.createElement("ul"), description = owner.createElement("p");
    heading.textContent = "Workspace provider"; status.setAttribute("aria-label", "Workspace provider status"); status.setAttribute("aria-live", "polite");
    const buttons = projectActions(tools).map(action => { const button = owner.createElement("button"); button.textContent = action.label; button.onclick = action.invoke; controls.append(button); return button; });
    description.textContent = "Last applied provider edits"; changed.setAttribute("aria-label", "Provider changed resources");
    host.replaceChildren(heading, status, controls, description, changed); let previous: ReturnType<HostProjectTools["state"]["getSnapshot"]>["changes"] | undefined;
    const render = () => {
        const state = tools.state.getSnapshot(); status.textContent = state.message; for (const [i, action] of projectActions(tools).entries()) buttons[i]!.disabled = action.disabled;
        if (previous !== state.changes) { previous = state.changes; changed.replaceChildren(...state.changes.map(c => { const item = owner.createElement("li"), button = owner.createElement("button");
            button.textContent = `Open provider changes in ${c.title}`; button.onclick = () => tools.openChanged(c.document); item.append(button); return item; })); }
        for (const button of changed.querySelectorAll("button")) button.disabled = state.pending;
        description.hidden = !state.changes.length;
    };
    const stop = tools.state.subscribe(render); render(); return () => { stop(); host.replaceChildren(); };
}
