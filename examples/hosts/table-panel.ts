import type { HostTablePaste } from "./table-paste.ts";

/** Ordinary host UI; the controller owns all paste state and lifecycle. */
export function mountTablePastePanel(host: HTMLElement, tools: HostTablePaste): () => void {
    const owner = host.ownerDocument, listeners = new AbortController(), label = owner.createElement("label"), enabled = owner.createElement("input");
    const output = owner.createElement("output"), cancel = owner.createElement("button"), progress = owner.createElement("progress"); enabled.type = "checkbox"; label.append(enabled, "Paste tables as CSV");
    progress.setAttribute("aria-label", "Table conversion progress");
    output.setAttribute("aria-label", "Table paste status"); output.setAttribute("aria-live", "polite"); cancel.textContent = "Cancel table paste";
    enabled.addEventListener("change", () => tools.setEnabled(enabled.checked), { signal: listeners.signal }); cancel.addEventListener("click", tools.cancel, { signal: listeners.signal });
    host.append(label, output, progress, cancel);
    const render = () => { const s = tools.state.getSnapshot(); enabled.checked = s.enabled; enabled.disabled = !s.available;
        if (output.textContent !== s.message) output.textContent = s.message;
        if (cancel.disabled !== (s.status !== "converting")) cancel.disabled = s.status !== "converting";
        if (progress.hidden !== (s.status !== "converting")) progress.hidden = s.status !== "converting"; };
    const stop = tools.state.subscribe(render); render(); return () => { listeners.abort(); stop(); host.replaceChildren(); };
}
