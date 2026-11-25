import { isSaveKey } from "../../../examples/shared/host-shortcuts.ts";
import type { HostController, Connection } from "./controller.ts";
import type { ResourceSnapshot, SnapshotValue } from "../../../src/index.ts";
import { configurationValidation } from "./configuration.ts";
import type { FormSave, FormSavePresentation } from "./form-save.ts";

type SaveControls<T extends SnapshotValue> = Pick<FormSave<T>, "save" | "finish" | "fail" | "externalWrite" | "review" | "saveReviewed">;
export function formSavePanelModel<T extends SnapshotValue>(save: SaveControls<T>, state: FormSavePresentation<T>, statusLabel = `${state.title} save status`) {
    const noun = state.noun, captured = !state.disposed && state.capture !== null;
    return { title: `${state.title} save`, status: { label: statusLabel, text: state.status },
        preview: { hidden: state.preview === null, text: state.preview ?? "" }, actions: [
        { label: `Save ${noun}`, invoke: save.save, disabled: !state.canSave },
        { label: `Finish ${noun} save`, invoke: () => save.finish(state.capture), disabled: !captured },
        { label: `Fail ${noun} save`, invoke: () => save.fail(state.capture), disabled: !captured },
        { label: `Simulate external ${noun} change`, invoke: () => save.externalWrite(), disabled: state.disposed },
        { label: `Review remote ${noun}`, invoke: save.review, disabled: !state.canReview },
        { label: `Save reviewed ${noun}`, invoke: () => save.saveReviewed(state.review), disabled: !state.canSaveReviewed },
    ] } as const;
}

export function configurationFormModel(controller: Pick<HostController, "setPath">, state: ResourceSnapshot<Connection>) {
    const validation = state.state === "ready" ? configurationValidation(state.value()) : null;
    return { available: state.state === "ready", status: state.state, validation: validation ?? "", field: {
        label: "Configuration path", value: state.state === "ready" ? state.value().path : "",
        readOnly: state.state !== "ready" || !state.metadata.capabilities.edit.includes("human") || state.metadata.editLock !== null,
        invalid: validation !== null, change: controller.setPath,
    } } as const;
}

type SaveKey = KeyboardEvent | (Pick<KeyboardEvent, "defaultPrevented" | "preventDefault" | "stopPropagation"> & { nativeEvent: KeyboardEvent });

/** Scope Save to the host's configuration controls; source commands keep their own target. */
export function formSaveKey(event: SaveKey, save: Readonly<{ save: () => void }>): void {
    const key = "nativeEvent" in event ? event.nativeEvent : event;
    if (event.defaultPrevented || !isSaveKey(key)) return;
    event.preventDefault(); event.stopPropagation();
    if (!key.repeat) save.save();
}

export function mountConfigurationPanel(host: HTMLElement, controller: HostController): () => void {
    const save = controller.configurationSave, owner = host.ownerDocument, listeners = new AbortController();
    const title = owner.createElement("h2"), status = owner.createElement("output"), nav = owner.createElement("div"), preview = owner.createElement("pre");
    const initial = formSavePanelModel(save, save.presentation.getSnapshot());
    host.setAttribute("aria-label", initial.title); title.textContent = initial.title; status.setAttribute("aria-label", initial.status.label);
    const buttons = initial.actions.map(action => { const button = owner.createElement("button"); button.textContent = action.label; nav.append(button); return button; });
    host.addEventListener("keydown", event => formSaveKey(event, save), { signal: listeners.signal });
    host.replaceChildren(title, status, nav, preview);
    const render = () => { const model = formSavePanelModel(save, save.presentation.getSnapshot()); status.textContent = model.status.text;
        buttons.forEach((button, i) => { button.disabled = model.actions[i]!.disabled; button.onclick = model.actions[i]!.invoke; });
        preview.hidden = model.preview.hidden; preview.textContent = model.preview.text; };
    const stop = save.presentation.subscribe(render); render();
    return () => { stop(); listeners.abort(); buttons.forEach(button => { button.onclick = null; }); host.replaceChildren(); };
}
