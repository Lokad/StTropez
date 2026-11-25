import type { HostController } from "./controller.ts";
import type { ViewBindings } from "./bindings.ts";
import type { VariantReviewSnapshot } from "./variants.ts";

export function variantPanelModel(variants: Pick<HostController["variants"], "review" | "keepDraft" | "finishNext" | "failNext" | "cancel">,
    bindings: Pick<ViewBindings, "beginDiscard" | "finishDiscard" | "cancelDiscard">,
    state: VariantReviewSnapshot, reference: ReturnType<HostController["comparisonReference"]["getSnapshot"]>) {
    const selected = state.requested ?? state.selected;
    const pinned = selected !== null && !state.choices.some(choice => choice.id === selected.id && choice.version === selected.version);
    return {
        label: "Review version", empty: "Choose a version",
        choices: state.choices.map(choice => ({ key: choice.id, label: `${choice.label} · ${choice.version}` })),
        captured: { key: "__captured", hidden: !pinned, label: pinned ? `Captured ${selected.label} · ${selected.version}` : "" },
        value: pinned ? "__captured" : selected?.id ?? "",
        choose: (id: string) => { if (state.choices.some(choice => choice.id === id)) variants.review(id); },
        status: { label: "Version review status", text: `${state.message} Reference: ${reference.baseline.version}.` },
        actions: [
            { label: "Keep draft version", invoke: variants.keepDraft, disabled: false },
            { label: "Finish version load", invoke: variants.finishNext, disabled: state.pending === 0 },
            { label: "Fail version load", invoke: variants.failNext, disabled: state.pending === 0 },
            { label: "Cancel version load", invoke: variants.cancel, disabled: state.pending === 0 },
            { label: "Discard reviewed changes", invoke: bindings.beginDiscard, disabled: false },
            { label: "Confirm reviewed discard", invoke: bindings.finishDiscard, disabled: false },
            { label: "Cancel reviewed discard", invoke: bindings.cancelDiscard, disabled: false },
        ],
    };
}

export function mountVariantPanel(host: HTMLElement, controller: HostController, bindings: ViewBindings): () => void {
    const owner = host.ownerDocument, listeners = new AbortController(), label = owner.createElement("label"), select = owner.createElement("select"), status = owner.createElement("output");
    const read = () => variantPanelModel(controller.variants, bindings, controller.variants.state.getSnapshot(), controller.comparisonReference.getSnapshot());
    let model = read();
    const empty = owner.createElement("option"), captured = owner.createElement("option"); empty.value = ""; empty.textContent = model.empty;
    captured.value = model.captured.key; captured.disabled = true; select.append(empty, captured);
    select.setAttribute("aria-label", model.label); label.textContent = `${model.label} `; label.append(select);
    status.setAttribute("aria-label", model.status.label); host.append(label, status);
    select.addEventListener("change", () => model.choose(select.value), { signal: listeners.signal });
    const buttons = model.actions.map((action, index) => { const button = owner.createElement("button"); button.type = "button"; button.textContent = action.label;
        button.addEventListener("click", () => model.actions[index]!.invoke(), { signal: listeners.signal }); host.append(button); return button; });
    const nodes = new Map<string, HTMLOptionElement>();
    const render = () => {
        model = read(); const ids = new Set(model.choices.map(choice => choice.key));
        for (const [id, node] of nodes) if (!ids.has(id)) { node.remove(); nodes.delete(id); }
        model.choices.forEach((choice, index) => {
            let node = nodes.get(choice.key); if (!node) { node = owner.createElement("option"); node.value = choice.key; nodes.set(choice.key, node); }
            if (node.textContent !== choice.label) node.textContent = choice.label;
            if (select.options[index + 2] !== node) select.insertBefore(node, select.options[index + 2] ?? null);
        });
        captured.hidden = model.captured.hidden; captured.textContent = model.captured.label;
        select.value = model.value;
        if (status.textContent !== model.status.text) status.textContent = model.status.text;
        buttons.forEach((button, index) => { button.disabled = model.actions[index]!.disabled; });
    };
    const stops = [controller.variants.state.subscribe(render), controller.comparisonReference.subscribe(render)]; render();
    return () => { listeners.abort(); stops.forEach(stop => stop()); nodes.clear(); host.replaceChildren(); };
}
