import type { HostDraftRecovery } from "./draft-recovery.ts";

export function draftActions(draft: HostDraftRecovery) {
    const s = draft.state.getSnapshot();
    return [
        { label: "Keep recovery draft", invoke: () => draft.prepare("keep"), disabled: s.busy },
        { label: "Restore source draft", invoke: () => draft.prepare("source"), disabled: s.busy || !s.valid },
        { label: "Restore configuration draft", invoke: () => draft.prepare("configuration"), disabled: s.busy || !s.valid },
        { label: "Restore transfer draft", invoke: () => draft.prepare("transfer"), disabled: s.busy || !s.valid || !s.hasTransfer },
        { label: "Restore loaded-source draft", invoke: () => draft.prepare("loaded"), disabled: s.busy || !s.valid || !s.hasLoaded },
        { label: "Inspect stored draft", invoke: draft.inspect, disabled: s.busy || !s.valid },
        { label: "Discard stored draft", invoke: () => draft.prepare("discard"), disabled: s.busy || !s.present },
        { label: "Retry draft storage", invoke: draft.reload, disabled: s.busy },
        { label: "Confirm draft action", invoke: draft.confirm, disabled: s.busy || s.confirmation === null },
        { label: "Cancel draft action", invoke: draft.cancel, disabled: s.busy || s.confirmation === null },
    ] as const;
}
export function mountDraftPanel(host: HTMLElement, draft: HostDraftRecovery): () => void {
    const owner = host.ownerDocument, title = owner.createElement("h2"), status = owner.createElement("output"), progress = owner.createElement("progress"), protection = owner.createElement("p"), preview = owner.createElement("pre"), nav = owner.createElement("div"), listeners = new AbortController();
    title.textContent = "Draft recovery"; status.setAttribute("aria-label", "Draft recovery status");
    const buttons = draftActions(draft).map(action => { const b = owner.createElement("button"); b.textContent = action.label; b.addEventListener("click", action.invoke, { signal: listeners.signal }); nav.append(b); return b; });
    progress.setAttribute("aria-label", "Draft storage progress"); host.replaceChildren(title, status, progress, protection, nav, preview);
    const render = () => { const s = draft.state.getSnapshot(); status.textContent = s.message; progress.hidden = !s.busy; protection.textContent = s.unprotected ? "Current inputs need a recovery checkpoint before leaving." : "Checkpoint copies do not save or run inputs.";
        const actions = draftActions(draft); buttons.forEach((b, i) => { b.disabled = actions[i]!.disabled; }); preview.hidden = s.preview === null; preview.textContent = s.preview ?? ""; };
    const stop = draft.state.subscribe(render); render(); return () => { stop(); listeners.abort(); host.replaceChildren(); };
}
