import { renderPanelActions } from "./panel-actions.ts";
import type { HostProjectTools, ProjectSnapshot } from "./project.ts";
import { actionTarget } from "./actions-panel.ts";
type ProjectPanelTools = Pick<HostProjectTools, "register" | "unregister" | "requestEdits" | "requestStatus" | "cancel" | "disconnect" | "reconnect" | "openChanged">;

/** Captured decisions and lazy bounded lists shared by both host renderers. */
export function projectPanelModel(tools: ProjectPanelTools, s: ProjectSnapshot) {
    const unavailable = !s.available || s.disconnected || s.pending, review = s.review, reviewKey = review?.key;
    return {
        title: "Workspace provider", status: { label: "Workspace provider status", text: s.message },
        actions: [
            { label: "Register provider review command", invoke: tools.register, disabled: unavailable || s.registered },
            { label: "Unregister provider review command", invoke: tools.unregister, disabled: unavailable || !s.registered },
            { label: "Request provider review edits", invoke: tools.requestEdits, disabled: unavailable || !s.registered || s.reconnectRequired },
            { label: "Request provider workspace status", invoke: tools.requestStatus, disabled: unavailable || s.reconnectRequired },
            { label: "Cancel workspace provider request", invoke: tools.cancel, disabled: !s.pending },
            { label: "Apply captured provider edits", reviewKey, invoke: () => review?.apply(), disabled: !review?.canApply },
            { label: "Decline captured provider edits", reviewKey, invoke: () => review?.decline(), disabled: !review },
            { label: "Previous provider edits", reviewKey, invoke: () => review?.previousPage(), disabled: !review || review.page === 0 },
            { label: "Next provider edits", reviewKey, invoke: () => review?.nextPage(), disabled: !review || (review.page + 1) * 64 >= review.count },
            { label: "Disconnect workspace provider", invoke: tools.disconnect, disabled: !s.connected && !s.pending },
            { label: "Reconnect workspace provider", invoke: tools.reconnect, disabled: !s.disconnected && !s.reconnectRequired && s.status !== "failed" }
        ],
        review: { enabled: true, visible: review !== null, key: review?.key, identity: review, titleLabel: "Provider edit review", title: review?.label ?? "",
            label: "Captured provider edits", start: (review?.page ?? 0) * 64 + 1, items: () => review?.notes.map(actionTarget) ?? [] },
        changes: { label: "Provider changed resources", description: "Last applied provider edits", visible: s.changes.length > 0, disabled: s.pending,
            identity: s.changes, items: () => s.changes.map(change => ({ key: change.document, label: `Open provider changes in ${change.title}`,
                invoke: () => tools.openChanged(change.document) } as const)) },
    } as const;
}
export function mountProjectPanel(host: HTMLElement, tools: HostProjectTools): () => void {
    const initial = projectPanelModel(tools, tools.state.getSnapshot());
    const owner = host.ownerDocument, heading = owner.createElement("h2"), status = owner.createElement("output"), controls = owner.createElement("div"), changed = owner.createElement("ul"), description = owner.createElement("p");
    host.setAttribute("aria-label", initial.title); heading.textContent = initial.title; status.setAttribute("aria-label", initial.status.label);
    const previewTitle = owner.createElement("p"), preview = owner.createElement("ol"); previewTitle.setAttribute("aria-label", initial.review.titleLabel); preview.setAttribute("aria-label", initial.review.label);
    description.textContent = initial.changes.description; changed.setAttribute("aria-label", initial.changes.label);
    host.replaceChildren(heading, status, controls, ...(initial.review.enabled ? [previewTitle, preview] : []), description, changed); let previous: ProjectSnapshot["changes"] | undefined, previousReview: unknown;
    const render = () => {
        const model = projectPanelModel(tools, tools.state.getSnapshot()); status.textContent = model.status.text;
        renderPanelActions(controls, model.actions);
        previewTitle.hidden = !model.review.visible; previewTitle.textContent = model.review.title;
        if (previousReview !== model.review.identity) { previousReview = model.review.identity; preview.start = model.review.start; preview.replaceChildren(...model.review.items().map(text => { const li = owner.createElement("li"), pre = owner.createElement("pre"); pre.textContent = text; li.append(pre); return li; })); }
        if (previous !== model.changes.identity) { previous = model.changes.identity; changed.replaceChildren(...model.changes.items().map(change => { const item = owner.createElement("li"), button = owner.createElement("button");
            button.textContent = change.label; button.onclick = change.invoke; item.append(button); return item; })); }
        for (const button of changed.querySelectorAll("button")) button.disabled = model.changes.disabled;
        description.hidden = !model.changes.visible;
    };
    const stop = tools.state.subscribe(render); render(); return () => { stop(); host.replaceChildren(); };
}
