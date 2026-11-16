import type { ResourceId } from "../../src/index.ts";
import type { HostController } from "./controller.ts";
import type { HostTransfer, TransferSettings } from "./transfers.ts";
import type { FormSavePresentation } from "./form-save.ts";
import type { RunResources, RunResourcesSnapshot } from "./run-resources.ts";
import { formSavePanelModel, formSaveKey } from "./configuration-panel.ts";

export function transferFormModel(transfer: Pick<HostTransfer, "update" | "save">, saved: FormSavePresentation<TransferSettings>) {
    const state = saved.resource;
    const readOnly = state.state !== "ready" || !state.metadata.capabilities.edit.includes("human") || state.metadata.editLock !== null;
    return { title: "Transfer workspace", available: state.state === "ready", status: state.state,
        save: formSavePanelModel(transfer.save, saved, "Transfer save status"),
        fields: ([['destination', 'Transfer destination', 'text'], ['batchSize', 'Transfer batch size', 'numeric']] as const).map(([key, label, inputMode]) => ({
            key, label, inputMode, value: state.state === "ready" ? state.value[key] : "", readOnly, invalid: saved.validation !== null,
            change: (value: string) => transfer.update(key, value),
        })),
    } as const;
}

/** Run/log links and refresh commands retain the displayed resource, never a later selection. */
export function runPanelModel(outputs: Pick<RunResources, "open" | "advance">, state: RunResourcesSnapshot) {
    const inspection = state.inspection;
    const link = (label: string, id: ResourceId) => ({ key: id, label, invoke: () => outputs.open(id) });
    return { title: "Captured Runs and logs", rows: { identity: state.runs, items: () => state.runs.map(run => ({
        key: run.id, status: `Run ${run.number}: ${run.status}, ${run.progress}% · ${run.id} `,
        inspect: link(`Inspect Run ${run.number}`, run.id),
        progress: { label: `Advance Run ${run.number} progress`, disabled: run.status !== "running" || run.progress >= 90, invoke: () => outputs.advance(run.id) },
        logs: () => run.logs.map((id, i) => link(`Inspect Run ${run.number} log ${i + 1}`, id)),
    })) }, inspection: { label: "Resource inspection", key: inspection?.id ?? null, hidden: inspection === null,
        title: inspection?.title ?? "", text: inspection?.text ?? "", preview: { hidden: inspection?.preview == null, text: inspection?.preview ?? "" },
        links: () => inspection?.links.map(item => link(item.label, item.id)) ?? [],
        refresh: { label: "Refresh resource inspection", invoke: () => { if (inspection) outputs.open(inspection.id); } },
    } } as const;
}

export function mountTransferPanel(host: HTMLElement, controller: HostController): () => void {
    const owner = host.ownerDocument, listeners = new AbortController(), transfer = controller.transfer, outputs = controller.runResources;
    const title = owner.createElement("h2"), form = owner.createElement("div"), fieldGroup = owner.createElement("div"), unavailable = owner.createElement("p"), status = owner.createElement("output"), nav = owner.createElement("div"), preview = owner.createElement("pre");
    const initial = transferFormModel(transfer, transfer.save.presentation.getSnapshot()), initialRuns = runPanelModel(outputs, outputs.state.getSnapshot());
    host.setAttribute("aria-label", initial.title); title.textContent = initial.title; status.setAttribute("aria-label", initial.save.status.label);
    const fields = initial.fields.map(model => {
        const label = owner.createElement("label"), field = owner.createElement("input"); label.textContent = model.label; field.inputMode = model.inputMode;
        field.addEventListener("input", () => model.change(field.value), { signal: listeners.signal }); label.append(field); fieldGroup.append(label); return field; });
    const button = (action: Readonly<{ label: string; invoke: () => void }>) => { const result = owner.createElement("button"); result.textContent = action.label; result.onclick = action.invoke; return result; };
    const buttons = initial.save.actions.map(action => { const result = button(action); nav.append(result); return result; });
    form.append(fieldGroup, unavailable, status, nav, preview); form.addEventListener("keydown", e => formSaveKey(e, transfer.save), { signal: listeners.signal });
    const runTitle = owner.createElement("h3"), list = owner.createElement("ul"), inspector = owner.createElement("section"), heading = owner.createElement("h3"), text = owner.createElement("p"), source = owner.createElement("pre"), links = owner.createElement("div"), refresh = button(initialRuns.inspection.refresh);
    runTitle.textContent = initialRuns.title; inspector.setAttribute("aria-label", initialRuns.inspection.label); inspector.append(heading, text, source, links, refresh);
    host.replaceChildren(title, form, runTitle, list, inspector);
    const rows = new Map<ResourceId, { status: HTMLSpanElement; inspect: HTMLButtonElement; progress: HTMLButtonElement; logs: HTMLSpanElement; entries: Map<ResourceId, HTMLButtonElement> }>();
    let previousRows: RunResourcesSnapshot["runs"] | undefined, selected: ResourceId | null | undefined, inspectionLinks: HTMLButtonElement[] = [];
    const renderForm = () => {
        const model = transferFormModel(transfer, transfer.save.presentation.getSnapshot()); fieldGroup.hidden = !model.available; unavailable.hidden = model.available; unavailable.textContent = model.status;
        model.fields.forEach((value, i) => { const field = fields[i]!; if (field.value !== value.value) field.value = value.value; field.readOnly = value.readOnly; field.setAttribute("aria-invalid", String(value.invalid)); });
        status.textContent = model.save.status.text; buttons.forEach((b, i) => { b.disabled = model.save.actions[i]!.disabled; b.onclick = model.save.actions[i]!.invoke; });
        preview.hidden = model.save.preview.hidden; preview.textContent = model.save.preview.text;
    };
    const renderRuns = () => {
        const model = runPanelModel(outputs, outputs.state.getSnapshot());
        if (previousRows !== model.rows.identity) for (const run of model.rows.items()) {
            let row = rows.get(run.key); if (!row) {
                const item = owner.createElement("li"), status = owner.createElement("span"), inspect = button(run.inspect), progress = button(run.progress), logs = owner.createElement("span");
                item.append(status, inspect, progress, logs); list.append(item); row = { status, inspect, progress, logs, entries: new Map() }; rows.set(run.key, row);
            }
            row.status.textContent = run.status; row.progress.disabled = run.progress.disabled;
            for (const log of run.logs()) if (!row.entries.has(log.key)) { const entry = button(log); row.entries.set(log.key, entry); row.logs.append(entry); }
        }
        previousRows = model.rows.identity;
        const value = model.inspection; inspector.hidden = value.hidden; heading.textContent = value.title; text.textContent = value.text;
        source.hidden = value.preview.hidden; source.textContent = value.preview.text; refresh.onclick = value.refresh.invoke;
        if (selected !== value.key) { selected = value.key; inspectionLinks.forEach(link => { link.onclick = null; }); inspectionLinks = value.links().map(button); links.replaceChildren(...inspectionLinks); }
    };
    const stops = [transfer.save.presentation.subscribe(renderForm), outputs.state.subscribe(renderRuns)]; renderForm(); renderRuns();
    return () => { stops.forEach(stop => stop()); listeners.abort();
        for (const row of rows.values()) for (const entry of [row.inspect, row.progress, ...row.entries.values()]) entry.onclick = null;
        for (const entry of [...buttons, refresh, ...inspectionLinks]) entry.onclick = null;
        host.replaceChildren(); };
}
