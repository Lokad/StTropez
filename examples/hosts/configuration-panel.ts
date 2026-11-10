import type { HostController } from "./controller.ts";
import type { ConfigurationSave } from "./configuration.ts";

export function configurationActions(save: ConfigurationSave) {
    return formActions(save, "configuration");
}
type SaveControls = Pick<ConfigurationSave, "canSave" | "canReview" | "canSaveReviewed" | "save" | "finish" | "fail" | "externalWrite" | "review" | "saveReviewed">
    & { capture: () => unknown | null; debug: () => Readonly<{ disposed: boolean }> };
export function formActions(save: SaveControls, noun: string) {
    const captured = save.capture() !== null;
    return [
        { label: `Save ${noun}`, invoke: save.save, disabled: !save.canSave() },
        { label: `Finish ${noun} save`, invoke: save.finish, disabled: !captured },
        { label: `Fail ${noun} save`, invoke: save.fail, disabled: !captured },
        { label: `Simulate external ${noun} change`, invoke: () => save.externalWrite(), disabled: save.debug().disposed },
        { label: `Review remote ${noun}`, invoke: save.review, disabled: !save.canReview() },
        { label: `Save reviewed ${noun}`, invoke: save.saveReviewed, disabled: !save.canSaveReviewed() },
    ];
}

type SaveKey = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "repeat" | "defaultPrevented" | "preventDefault" | "stopPropagation">
    & { isComposing?: boolean; nativeEvent?: Pick<KeyboardEvent, "isComposing"> };

/** Scope Save to the host's configuration controls; source commands keep their own target. */
export function formSaveKey(event: SaveKey, save: Readonly<{ save: () => void }>): void {
    if (event.defaultPrevented || (!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "s") return;
    event.preventDefault(); event.stopPropagation();
    if (!event.repeat && !event.isComposing && !event.nativeEvent?.isComposing) save.save();
}

export function mountConfigurationPanel(host: HTMLElement, controller: HostController): () => void {
    const save = controller.configurationSave, owner = host.ownerDocument, listeners = new AbortController();
    const title = owner.createElement("h2"), status = owner.createElement("output"), nav = owner.createElement("div"), preview = owner.createElement("pre");
    title.textContent = "Configuration save"; status.setAttribute("aria-label", "Configuration save status"); status.setAttribute("aria-live", "polite");
    const buttons = configurationActions(save).map(action => { const button = owner.createElement("button"); button.textContent = action.label;
        button.addEventListener("click", action.invoke, { signal: listeners.signal }); nav.append(button); return button; });
    host.addEventListener("keydown", event => formSaveKey(event, save), { signal: listeners.signal });
    host.replaceChildren(title, status, nav, preview);
    const render = () => { status.textContent = save.statusText(); const actions = configurationActions(save);
        buttons.forEach((button, i) => { button.disabled = actions[i]!.disabled; }); const state = save.state.getSnapshot(); preview.hidden = state.preview === null; preview.textContent = state.preview ?? ""; };
    const stops = [save.state.subscribe(render), controller.connection.subscribe(render)]; render();
    return () => { stops.forEach(stop => stop()); listeners.abort(); host.replaceChildren(); };
}
