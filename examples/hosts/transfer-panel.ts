import type { ResourceId } from "../../src/index.ts";
import type { HostController } from "./controller.ts";
import { formActions, formSaveKey } from "./configuration-panel.ts";

export function mountTransferPanel(host: HTMLElement, controller: HostController): () => void {
    const owner = host.ownerDocument, listeners = new AbortController(), transfer = controller.transfer, outputs = controller.runResources;
    const title = owner.createElement("h2"), form = owner.createElement("div"), status = owner.createElement("output"), nav = owner.createElement("div"), preview = owner.createElement("pre");
    title.textContent = "Transfer workspace"; status.setAttribute("aria-label", "Transfer save status"); status.setAttribute("aria-live", "polite");
    const fields = ([['destination', 'Transfer destination'], ['batchSize', 'Transfer batch size']] as const).map(([key, name]) => {
        const label = owner.createElement("label"), field = owner.createElement("input"); label.textContent = name; if (key === "batchSize") field.inputMode = "numeric";
        field.addEventListener("input", () => transfer.update(key, field.value), { signal: listeners.signal }); label.append(field); form.append(label); return { key, field }; });
    const buttons = formActions(transfer.save, "transfer settings").map(action => { const b = owner.createElement("button"); b.textContent = action.label; b.addEventListener("click", action.invoke, { signal: listeners.signal }); nav.append(b); return b; });
    form.append(status, nav, preview); form.addEventListener("keydown", e => formSaveKey(e, transfer.save), { signal: listeners.signal });
    const runTitle = owner.createElement("h3"), list = owner.createElement("ul"), inspector = owner.createElement("section"), heading = owner.createElement("h3"), text = owner.createElement("p"), source = owner.createElement("pre"), links = owner.createElement("div"), refresh = owner.createElement("button");
    runTitle.textContent = "Captured Runs and logs"; inspector.setAttribute("aria-label", "Resource inspection"); refresh.textContent = "Refresh resource inspection";
    refresh.addEventListener("click", () => { const id = outputs.state.getSnapshot().selected; if (id) outputs.open(id); }, { signal: listeners.signal }); inspector.append(heading, text, source, links, refresh);
    host.replaceChildren(title, form, runTitle, list, inspector);
    const rows = new Map<ResourceId, { status: HTMLSpanElement; progress: HTMLButtonElement; logs: HTMLSpanElement; entries: Set<ResourceId> }>();
    let selected: ResourceId | null = null;
    const link = (label: string, id: ResourceId) => { const b = owner.createElement("button"); b.textContent = label; b.addEventListener("click", () => outputs.open(id), { signal: listeners.signal }); return b; };
    const render = () => {
        const s = transfer.resource.getSnapshot(), error = transfer.save.validation();
        if (s.state === "ready") for (const { key, field } of fields) { if (field.value !== s.value[key]) field.value = s.value[key]; field.readOnly = !s.metadata.capabilities.edit.includes("human") || s.metadata.editLock !== null; field.setAttribute("aria-invalid", String(error !== null)); }
        status.textContent = transfer.save.statusText(); const actions = formActions(transfer.save, "transfer settings"); buttons.forEach((b, i) => { b.disabled = actions[i]!.disabled; });
        const state = transfer.save.state.getSnapshot(); preview.hidden = state.preview === null; preview.textContent = state.preview ?? "";
        for (const run of outputs.state.getSnapshot().runs) {
            let row = rows.get(run.id); if (!row) {
                const item = owner.createElement("li"), status = owner.createElement("span"), progress = owner.createElement("button"), logs = owner.createElement("span");
                progress.textContent = `Advance Run ${run.number} progress`; progress.addEventListener("click", () => outputs.advance(run.id), { signal: listeners.signal });
                item.append(status, link(`Inspect Run ${run.number}`, run.id), progress, logs); list.append(item); row = { status, progress, logs, entries: new Set() }; rows.set(run.id, row);
            }
            row.status.textContent = `Run ${run.number}: ${run.status}, ${run.progress}% · ${run.id} `; row.progress.disabled = run.status !== "running" || run.progress >= 90;
            run.logs.forEach((id, i) => { if (!row.entries.has(id)) { row.entries.add(id); row.logs.append(link(`Inspect Run ${run.number} log ${i + 1}`, id)); } });
        }
        const value = outputs.inspect(); inspector.hidden = value === null;
        if (value) { heading.textContent = value.title; text.textContent = value.text; source.hidden = value.preview === null; source.textContent = value.preview ?? "";
            if (selected !== value.id) { selected = value.id; links.replaceChildren(...value.links.map(l => link(l.label, l.id))); } }
    };
    const stops = [transfer.resource.subscribe(render), transfer.save.state.subscribe(render), outputs.state.subscribe(render)]; render();
    return () => { stops.forEach(stop => stop()); listeners.abort(); host.replaceChildren(); };
}
