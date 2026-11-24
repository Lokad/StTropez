import type { HostTablePaste, TablePasteSnapshot } from "./table-paste.ts";

export function tablePastePanelModel(tools: Pick<HostTablePaste, "setEnabled" | "cancel">, state: TablePasteSnapshot) {
    return {
        label: "Table paste tools", enabled: { label: "Paste tables as CSV", checked: state.enabled, change: tools.setEnabled },
        status: { label: "Table paste status", text: state.message }, progress: { label: "Table conversion progress", hidden: state.status !== "converting" },
        cancel: { label: "Cancel table paste", disabled: state.status !== "converting", invoke: tools.cancel },
    } as const;
}

/** Ordinary host UI; the controller owns all paste state and lifecycle. */
export function mountTablePastePanel(host: HTMLElement, tools: HostTablePaste): () => void {
    const initial = tablePastePanelModel(tools, tools.state.getSnapshot());
    const owner = host.ownerDocument, listeners = new AbortController(), label = owner.createElement("label"), enabled = owner.createElement("input");
    const output = owner.createElement("output"), cancel = owner.createElement("button"), progress = owner.createElement("progress"); enabled.type = "checkbox"; label.append(enabled, initial.enabled.label);
    host.setAttribute("aria-label", initial.label); progress.setAttribute("aria-label", initial.progress.label);
    output.setAttribute("aria-label", initial.status.label); cancel.textContent = initial.cancel.label;
    enabled.addEventListener("change", () => initial.enabled.change(enabled.checked), { signal: listeners.signal }); cancel.addEventListener("click", initial.cancel.invoke, { signal: listeners.signal });
    host.append(label, output, progress, cancel);
    const render = () => { const model = tablePastePanelModel(tools, tools.state.getSnapshot()); enabled.checked = model.enabled.checked;
        if (output.textContent !== model.status.text) output.textContent = model.status.text;
        if (cancel.disabled !== model.cancel.disabled) cancel.disabled = model.cancel.disabled;
        if (progress.hidden !== model.progress.hidden) progress.hidden = model.progress.hidden; };
    const stop = tools.state.subscribe(render); render(); return () => { listeners.abort(); stop(); host.replaceChildren(); };
}
