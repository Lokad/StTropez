import type { HostController } from "./controller.ts";
import type { ViewBindings } from "./bindings.ts";

export function mountVariantPanel(host: HTMLElement, controller: HostController, bindings: ViewBindings): () => void {
    const owner = host.ownerDocument, listeners = new AbortController(), label = owner.createElement("label"), select = owner.createElement("select"), status = owner.createElement("output");
    const empty = owner.createElement("option"), captured = owner.createElement("option"); empty.value = ""; empty.textContent = "Choose a version";
    captured.value = "__captured"; captured.disabled = true; captured.hidden = true; select.append(empty, captured);
    select.setAttribute("aria-label", "Review version"); label.textContent = "Review version "; label.append(select);
    status.setAttribute("aria-label", "Version review status"); status.setAttribute("aria-live", "polite"); host.append(label, status);
    select.addEventListener("change", () => { if (select.value) controller.variants.review(select.value); }, { signal: listeners.signal });
    const actions = [{ label: "Keep draft version", invoke: controller.variants.keepDraft }, { label: "Finish version load", invoke: controller.variants.finishNext },
        { label: "Fail version load", invoke: controller.variants.failNext }, { label: "Cancel version load", invoke: controller.variants.cancel },
        { label: "Discard reviewed changes", invoke: bindings.beginDiscard }, { label: "Confirm reviewed discard", invoke: bindings.finishDiscard }, { label: "Cancel reviewed discard", invoke: bindings.cancelDiscard }];
    const buttons = actions.map(action => { const button = owner.createElement("button"); button.type = "button"; button.textContent = action.label;
        button.addEventListener("click", action.invoke, { signal: listeners.signal }); host.append(button); return button; });
    const nodes = new Map<string, HTMLOptionElement>();
    const render = () => {
        const state = controller.variants.state.getSnapshot(), ids = new Set(state.choices.map(choice => choice.id));
        for (const [id, node] of nodes) if (!ids.has(id)) { node.remove(); nodes.delete(id); }
        state.choices.forEach((choice, index) => {
            let node = nodes.get(choice.id); if (!node) { node = owner.createElement("option"); node.value = choice.id; nodes.set(choice.id, node); }
            const text = `${choice.label} · ${choice.version}`; if (node.textContent !== text) node.textContent = text;
            if (select.options[index + 2] !== node) select.insertBefore(node, select.options[index + 2] ?? null);
        });
        const selected = state.requested ?? state.selected, pinned = selected && !state.choices.some(choice => choice.id === selected.id && choice.version === selected.version);
        captured.hidden = !pinned; captured.textContent = pinned ? `Captured ${selected.label} · ${selected.version}` : "";
        select.value = pinned ? captured.value : selected && ids.has(selected.id) ? selected.id : "";
        const text = `${state.message} Reference: ${controller.comparisonReference.getSnapshot().baseline.version}.`;
        if (status.textContent !== text) status.textContent = text;
        buttons.forEach((button, index) => { button.disabled = index > 0 && index < 4 && state.pending === 0; });
    };
    const unsubscribe = controller.variants.state.subscribe(render); render();
    return () => { listeners.abort(); unsubscribe(); nodes.clear(); host.replaceChildren(); };
}
