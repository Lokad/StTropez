import type { HostDocumentColors, ColorEditNote, ColorNote, DocumentColorsSnapshot } from "./document-colors.ts";
import { renderPanelButton } from "./panel-actions.ts";
type DocumentColorsPanelTools = Pick<HostDocumentColors, "discover" | "cancel" | "previousPage" | "nextPage" | "disconnect" | "reconnect" | "bindList" | "bindValue" | "setValue" | "preview" | "openChanged">;
function documentColorActions(tools: DocumentColorsPanelTools, s: DocumentColorsSnapshot) { return [
    { label: "Discover document colors", invoke: tools.discover, disabled: !s.available || s.disconnected || s.pending },
    { label: "Dismiss document colors", invoke: tools.cancel, disabled: s.view === null },
    { label: "Previous document colors", invoke: tools.previousPage, disabled: !s.page || s.pending },
    { label: "Next document colors", invoke: tools.nextPage, disabled: (s.page + 1) * 64 >= s.count || s.pending },
    { label: "Disconnect color provider", invoke: tools.disconnect, disabled: !s.connected && !s.pending },
    { label: "Reconnect color provider", invoke: tools.reconnect, disabled: !s.disconnected && s.status !== "failed" }
]; }
export const documentColorDescription = "Literal fixture: hex3/4/6/8 and legacy RGB/RGBA numeric or percentage values, including strings/comments. Wider CSS and language syntax are not parsed. Inspect a reference, edit the host value, preview all presentation edits and confirm explicitly. Hex choices appear only for byte-representable channels. F6 discovers/focuses the list.";
export const documentColorLabel = (color: ColorNote) => `Inspect ${color.label} at ${color.line}:${color.column}`;
export const colorEditLabel = (at: ColorEditNote) => `${at.title} · ${at.resource} · ${at.document} @ revision ${at.revision} · [${at.from},${at.to})\nInsert ${JSON.stringify(at.insert)}\nContext: ${at.context}`;
/** One snapshot supplies the displayed reference and the complete confirmation identity. */
export function documentColorsPanelModel(tools: DocumentColorsPanelTools, s: DocumentColorsSnapshot) {
    return {
        title: "Document colors", description: documentColorDescription, status: { label: "Document color status", text: s.message },
        actions: documentColorActions(tools, s),
        results: { label: "Document color results", bind: tools.bindList, disabled: s.pending, isSelected: (ordinal: number) => s.selected === ordinal,
            retentionKey: () => s.colors,
            items: () => s.colors.map(color => ({ key: color.from, ordinal: color.ordinal, label: documentColorLabel(color), css: color.css,
                invoke: color.inspect } as const)) },
        value: { label: "Proposed color ", value: s.value, maxLength: 96, bind: tools.bindValue, css: s.css ?? "transparent", change: (value: string) => tools.setValue(value) },
        preview: { label: "Preview color presentations", disabled: !s.canPreview || s.pending, invoke: tools.preview },
        presentation: { label: "Color presentation ", value: s.presentation, disabled: !s.choices.length || s.pending,
            retentionKey: () => JSON.stringify(s.choices), items: () => s.choices, change: (id: string) => s.choices.find(choice => choice.id === id)?.select() },
        apply: { label: "Apply captured color", reviewKey: s.reviewKey, disabled: !s.canApply || s.pending, invoke: s.apply ?? (() => false) },
        edits: { label: "Proposed color edits", retentionKey: () => JSON.stringify(s.edits), items: () => s.edits.map(colorEditLabel) },
        changed: { visible: s.changed !== null, label: s.changed ? `Open color changes in ${s.changed.title}` : "Open color changes", disabled: s.pending || s.view !== null,
            invoke: () => { if (s.changed) tools.openChanged(s.changed.document); } },
    } as const;
}
export function mountDocumentColorsPanel(host: HTMLElement, tools: HostDocumentColors): () => void {
    const initial = documentColorsPanelModel(tools, tools.state.getSnapshot());
    const owner = host.ownerDocument, heading = owner.createElement("h2"), description = owner.createElement("p"), status = owner.createElement("output"), controls = owner.createElement("div"), list = owner.createElement("ul"), label = owner.createElement("label"), value = owner.createElement("input"), swatch = owner.createElement("span"), preview = owner.createElement("button"), presentationLabel = owner.createElement("label"), presentation = owner.createElement("select"), edits = owner.createElement("ol"), changed = owner.createElement("button");
    host.setAttribute("aria-label", initial.title); heading.textContent = initial.title; description.textContent = initial.description; status.setAttribute("aria-label", initial.status.label); list.tabIndex = -1; list.setAttribute("aria-label", initial.results.label); initial.results.bind(list);
    value.type = "text"; value.maxLength = initial.value.maxLength; value.oninput = () => initial.value.change(value.value); label.append(initial.value.label, value); initial.value.bind(value); swatch.className = "host-color-swatch"; swatch.setAttribute("aria-hidden", "true"); preview.textContent = initial.preview.label; preview.onclick = initial.preview.invoke;
    let apply = owner.createElement("button");
    presentationLabel.append(initial.presentation.label, presentation); edits.setAttribute("aria-label", initial.edits.label);
    const buttons = initial.actions.map(action => { const button = owner.createElement("button"); button.textContent = action.label; controls.append(button); return button; });
    host.replaceChildren(heading, description, status, controls, list, label, swatch, preview, presentationLabel, apply, edits, changed); let choiceKey = "", editsKey = ""; let listKey: readonly ColorNote[] | undefined, resultButtons: { ordinal: number; button: HTMLButtonElement }[] = [];
    const render = () => {
        const model = documentColorsPanelModel(tools, tools.state.getSnapshot()); status.textContent = model.status.text; for (const [i, action] of model.actions.entries()) { buttons[i]!.disabled = action.disabled; buttons[i]!.onclick = action.invoke; }
        const nextList = model.results.retentionKey(); if (nextList !== listKey) { listKey = nextList; resultButtons = []; list.replaceChildren(...model.results.items().map(color => { const li = owner.createElement("li"), mark = owner.createElement("span"), button = owner.createElement("button"); mark.className = "host-color-swatch"; mark.style.backgroundColor = color.css; mark.setAttribute("aria-hidden", "true"); button.textContent = color.label; button.onclick = color.invoke; resultButtons.push({ ordinal: color.ordinal, button }); li.append(mark, button); return li; })); }
        for (const { ordinal, button } of resultButtons) { button.disabled = model.results.disabled; button.setAttribute("aria-pressed", String(model.results.isSelected(ordinal))); }
        if (value.value !== model.value.value) value.value = model.value.value; swatch.style.backgroundColor = model.value.css; preview.disabled = model.preview.disabled;
        const nextChoices = model.presentation.retentionKey(); if (nextChoices !== choiceKey) { choiceKey = nextChoices; presentation.replaceChildren(...model.presentation.items().map(c => { const option = owner.createElement("option"); option.value = c.id; option.textContent = c.label; return option; })); }
        presentation.onchange = () => model.presentation.change(presentation.value); presentation.disabled = model.presentation.disabled; presentation.value = model.presentation.value;
        apply = renderPanelButton(apply, model.apply);
        const nextEdits = model.edits.retentionKey(); if (nextEdits !== editsKey) { editsKey = nextEdits; edits.replaceChildren(...model.edits.items().map(text => { const li = owner.createElement("li"), pre = owner.createElement("pre"); pre.textContent = text; li.append(pre); return li; })); }
        changed.hidden = !model.changed.visible; changed.disabled = model.changed.disabled; changed.textContent = model.changed.label; changed.onclick = model.changed.invoke;
    };
    const stop = tools.state.subscribe(render); render(); return () => { stop(); initial.results.bind(null); initial.value.bind(null); host.replaceChildren(); };
}
