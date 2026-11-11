import type { HostProjectTools } from "./project.ts";
import { actionTarget } from "./actions-panel.ts";
export function projectActions(tools: HostProjectTools) {
    const s = tools.state.getSnapshot(), unavailable = !s.available || s.disconnected || s.pending;
    return [
        { label: "Register provider review command", invoke: tools.register, disabled: unavailable || s.registered },
        { label: "Unregister provider review command", invoke: tools.unregister, disabled: unavailable || !s.registered },
        { label: "Request provider review edits", invoke: tools.requestEdits, disabled: unavailable || !s.registered || s.reconnectRequired },
        { label: "Request provider workspace status", invoke: tools.requestStatus, disabled: unavailable || s.reconnectRequired },
        { label: "Cancel workspace provider request", invoke: tools.cancel, disabled: !s.pending },
        ...(tools.usesLsp ? [{ label: "Apply captured provider edits", invoke: () => tools.confirmReview(s.review?.token ?? null), disabled: !s.review?.canApply },
            { label: "Decline captured provider edits", invoke: () => tools.declineReview(s.review?.token ?? null), disabled: !s.review },
            { label: "Previous provider edits", invoke: () => tools.previousReviewPage(), disabled: !s.review || s.review.page === 0 },
            { label: "Next provider edits", invoke: () => tools.nextReviewPage(), disabled: !s.review || (s.review.page + 1) * 64 >= s.review.count }] : []),
        { label: "Disconnect workspace provider", invoke: tools.disconnect, disabled: !s.connected && !s.pending },
        { label: "Reconnect workspace provider", invoke: tools.reconnect, disabled: !s.disconnected && !s.reconnectRequired && s.status !== "failed" }
    ] as const;
}
export function mountProjectPanel(host: HTMLElement, tools: HostProjectTools): () => void {
    const owner = host.ownerDocument, heading = owner.createElement("h2"), status = owner.createElement("output"), controls = owner.createElement("div"), changed = owner.createElement("ul"), description = owner.createElement("p");
    heading.textContent = "Workspace provider"; status.setAttribute("aria-label", "Workspace provider status");
    const previewTitle = owner.createElement("p"), preview = owner.createElement("ol"); previewTitle.setAttribute("aria-label", "Provider edit review"); preview.setAttribute("aria-label", "Captured provider edits");
    const buttons = projectActions(tools).map(action => { const button = owner.createElement("button"); button.textContent = action.label; button.onclick = action.invoke; controls.append(button); return button; });
    description.textContent = "Last applied provider edits"; changed.setAttribute("aria-label", "Provider changed resources");
    host.replaceChildren(heading, status, controls, ...(tools.usesLsp ? [previewTitle, preview] : []), description, changed); let previous: ReturnType<HostProjectTools["state"]["getSnapshot"]>["changes"] | undefined, previousReview: unknown;
    const render = () => {
        const state = tools.state.getSnapshot(); status.textContent = state.message; for (const [i, action] of projectActions(tools).entries()) buttons[i]!.disabled = action.disabled;
        for (const [i, action] of projectActions(tools).entries()) buttons[i]!.onclick = action.invoke;
        previewTitle.hidden = !state.review; previewTitle.textContent = state.review?.label ?? "";
        if (previousReview !== state.review) { previousReview = state.review; preview.start = (state.review?.page ?? 0) * 64 + 1; preview.replaceChildren(...state.review?.notes.map(note => { const li = owner.createElement("li"), pre = owner.createElement("pre"); pre.textContent = actionTarget(note); li.append(pre); return li; }) ?? []); }
        if (previous !== state.changes) { previous = state.changes; changed.replaceChildren(...state.changes.map(c => { const item = owner.createElement("li"), button = owner.createElement("button");
            button.textContent = `Open provider changes in ${c.title}`; button.onclick = () => tools.openChanged(c.document); item.append(button); return item; })); }
        for (const button of changed.querySelectorAll("button")) button.disabled = state.pending;
        description.hidden = !state.changes.length;
    };
    const stop = tools.state.subscribe(render); render(); return () => { stop(); host.replaceChildren(); };
}
