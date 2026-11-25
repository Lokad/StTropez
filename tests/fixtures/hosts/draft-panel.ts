import type { HostDraftRecovery, DraftSnapshot } from "./draft-recovery.ts";

type DraftCommands = Pick<HostDraftRecovery, "prepare" | "inspect" | "reload" | "confirm" | "cancel">;
/** Rendering uses one snapshot; decision callbacks retain the displayed confirmation token. */
export function draftPanelModel(draft: DraftCommands, state: DraftSnapshot) {
    return { title: "Draft recovery", status: { label: "Draft recovery status", text: state.message },
        progress: { label: "Draft storage progress", hidden: !state.busy },
        protection: state.unprotected ? "Current inputs need a recovery checkpoint before leaving." : "Checkpoint copies do not save or run inputs.",
        preview: { hidden: state.preview === null, text: state.preview ?? "" }, actions: [
        { label: "Keep recovery draft", invoke: () => draft.prepare("keep"), disabled: state.busy },
        { label: "Restore source draft", invoke: () => draft.prepare("source"), disabled: state.busy || !state.valid },
        { label: "Restore configuration draft", invoke: () => draft.prepare("configuration"), disabled: state.busy || !state.valid },
        { label: "Restore transfer draft", invoke: () => draft.prepare("transfer"), disabled: state.busy || !state.valid || !state.hasTransfer },
        { label: "Restore loaded-source draft", invoke: () => draft.prepare("loaded"), disabled: state.busy || !state.valid || !state.hasLoaded },
        { label: "Inspect stored draft", invoke: draft.inspect, disabled: state.busy || !state.valid },
        { label: "Discard stored draft", invoke: () => draft.prepare("discard"), disabled: state.busy || !state.present },
        { label: "Retry draft storage", invoke: draft.reload, disabled: state.busy },
        { label: "Confirm draft action", invoke: () => draft.confirm(state.confirmationToken), disabled: state.busy || state.confirmationToken === null },
        { label: "Cancel draft action", invoke: () => draft.cancel(state.confirmationToken), disabled: state.busy || state.confirmationToken === null },
    ] } as const;
}
export function mountDraftPanel(host: HTMLElement, draft: HostDraftRecovery): () => void {
    const owner = host.ownerDocument, title = owner.createElement("h2"), status = owner.createElement("output"), progress = owner.createElement("progress"), protection = owner.createElement("p"), preview = owner.createElement("pre"), nav = owner.createElement("div");
    const initial = draftPanelModel(draft, draft.state.getSnapshot());
    host.setAttribute("aria-label", initial.title); title.textContent = initial.title; status.setAttribute("aria-label", initial.status.label);
    const buttons = initial.actions.map(action => { const b = owner.createElement("button"); b.textContent = action.label; nav.append(b); return b; });
    progress.setAttribute("aria-label", initial.progress.label); host.replaceChildren(title, status, progress, protection, nav, preview);
    const render = () => { const model = draftPanelModel(draft, draft.state.getSnapshot());
        status.textContent = model.status.text; progress.hidden = model.progress.hidden; protection.textContent = model.protection;
        buttons.forEach((b, i) => { b.disabled = model.actions[i]!.disabled; b.onclick = model.actions[i]!.invoke; }); preview.hidden = model.preview.hidden; preview.textContent = model.preview.text; };
    const stop = draft.state.subscribe(render); render(); return () => { stop(); buttons.forEach(b => { b.onclick = null; }); host.replaceChildren(); };
}
