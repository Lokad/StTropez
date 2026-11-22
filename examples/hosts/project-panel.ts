import { changedFiles, createChangedFileList, formatEditNote } from "./edit-review.ts";
import { createToolPanel } from "./tool-panel.ts";
import type { HostProjectTools, ProjectSnapshot } from "./project.ts";
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
        review: { visible: review !== null, identity: review, titleLabel: "Provider edit review", title: review?.label ?? "",
            label: "Captured provider edits", start: (review?.page ?? 0) * 64 + 1, items: () => review?.notes.map(formatEditNote) ?? [] },
        changes: changedFiles("Provider changed resources", "Open provider changes in ", s.changes, s.pending, id => tools.openChanged(id)),
        changesDescription: s.changes.length ? "Last applied provider edits" : "",
    } as const;
}
export function mountProjectPanel(host: HTMLElement, tools: HostProjectTools): () => void {
    const { owner, initial, controls, mount } = createToolPanel(host, tools.state, state => projectPanelModel(tools, state));
    const changed = createChangedFileList(owner, initial.changes.label), description = owner.createElement("p");
    const previewTitle = owner.createElement("p"), preview = owner.createElement("ol"); previewTitle.setAttribute("aria-label", initial.review.titleLabel); preview.setAttribute("aria-label", initial.review.label);
    let previousReview: ProjectSnapshot["review"] | undefined;
    return mount([controls, previewTitle, preview, description, changed.element], model => {
        previewTitle.hidden = !model.review.visible; previewTitle.textContent = model.review.title;
        if (previousReview !== model.review.identity) { previousReview = model.review.identity; preview.start = model.review.start; preview.replaceChildren(...model.review.items().map(text => { const li = owner.createElement("li"), pre = owner.createElement("pre"); pre.textContent = text; li.append(pre); return li; })); }
        description.hidden = !model.changesDescription; description.textContent = model.changesDescription;
        changed.render(model.changes);
    });
}
