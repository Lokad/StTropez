import type { HostDocumentColors, ColorNote, DocumentColorsSnapshot } from "./document-colors.ts";
import { pageActions, renderPanelButton } from "../../../examples/shared/panel-actions.ts";
import { bindChoiceList, createPanelTextField, createToolPanel } from "./tool-panel.ts";
type DocumentColorsPanelTools = Pick<HostDocumentColors, "discover" | "cancel" | "disconnect" | "reconnect" | "bindList" | "bindValue" | "setValue" | "preview" | "openChanged">;
function documentColorActions(tools: DocumentColorsPanelTools, s: DocumentColorsSnapshot) { return [
    { label: "Discover document colors", invoke: tools.discover, disabled: !s.available || s.disconnected || s.pending },
    { label: "Dismiss document colors", invoke: tools.cancel, disabled: s.view === null },
    ...pageActions("document colors", s.paging),
    { label: "Disconnect color provider", invoke: tools.disconnect, disabled: !s.connected && !s.pending },
    { label: "Reconnect color provider", invoke: tools.reconnect, disabled: !s.disconnected && s.status !== "failed" }
]; }
export const documentColorDescription = "Click a swatch or press F6 to choose a color. Enter a value, preview its edits and choose Apply. This example recognizes hex and RGB/RGBA literals, including in strings and comments.";
export const documentColorLabel = (color: ColorNote) => `Inspect ${color.label} at ${color.line}:${color.column}`;
/** One snapshot supplies the displayed reference and the complete confirmation identity. */
export function documentColorsPanelModel(tools: DocumentColorsPanelTools, s: DocumentColorsSnapshot) {
    return {
        title: "Document colors", description: documentColorDescription, status: { label: "Document color status", text: s.message },
        actions: documentColorActions(tools, s),
        results: { label: "Document color results", bind: tools.bindList, disabled: s.pending, isSelected: (ordinal: number) => s.selected === ordinal,
            identity: s.colors,
            items: () => s.colors.map(color => ({ key: color.ordinal, label: documentColorLabel(color), css: color.css,
                invoke: color.inspect } as const)) },
        value: { label: "Proposed color ", value: s.value, maxLength: 96, bind: tools.bindValue, css: s.css ?? "transparent", change: (value: string) => tools.setValue(value) },
        preview: { label: "Preview color presentations", disabled: !s.canPreview || s.pending, invoke: tools.preview },
        presentation: { label: "Color presentation ", value: s.presentation, disabled: !s.choices.length || s.pending,
            choices: s.choices, change: (index: number) => s.choices[index]?.select({ review: true }) },
        apply: { label: "Apply captured color", reviewKey: s.reviewKey, disabled: !s.canApply || s.pending, invoke: () => s.apply?.() },
        edits: { label: "Proposed color edits", items: s.edits },
        changed: { visible: s.changed !== null, reviewKey: s.changed?.document, label: s.changed ? `Open color changes in ${s.changed.title}` : "Open color changes", disabled: s.pending || s.view !== null,
            invoke: () => { if (s.changed) tools.openChanged(s.changed.document); } },
    } as const;
}
export function mountDocumentColorsPanel(host: HTMLElement, tools: HostDocumentColors): () => void {
    const { owner, initial, controls, mount } = createToolPanel(host, tools.state, state => documentColorsPanelModel(tools, state));
    const list = owner.createElement("ul"), value = createPanelTextField(owner, initial.value), swatch = owner.createElement("span"), preview = owner.createElement("button"), presentationLabel = owner.createElement("label"), presentation = owner.createElement("select"), edits = owner.createElement("ol");
    list.tabIndex = -1; initial.results.bind(list);
    const renderColors = bindChoiceList(list, initial.results, color => {
        const mark = owner.createElement("span");
        mark.className = "host-color-swatch"; mark.style.backgroundColor = color.css; mark.setAttribute("aria-hidden", "true");
        return mark;
    });
    swatch.className = "host-color-swatch"; swatch.setAttribute("aria-hidden", "true"); preview.textContent = initial.preview.label; preview.onclick = initial.preview.invoke;
    let apply = owner.createElement("button"), changed = owner.createElement("button");
    presentationLabel.append(initial.presentation.label, presentation); edits.setAttribute("aria-label", initial.edits.label);
    let choices: DocumentColorsSnapshot["choices"] | undefined, notes: readonly string[] | undefined;
    return mount([controls, list, value.label, swatch, preview, presentationLabel, apply, edits, changed], model => {
        renderColors(model.results);
        value.render(model.value.value); swatch.style.backgroundColor = model.value.css; preview.disabled = model.preview.disabled;
        if (choices !== model.presentation.choices) {
            choices = model.presentation.choices;
            presentation.replaceChildren(...choices.map((choice, i) => { const option = owner.createElement("option"); option.value = `provider-${i}`; option.textContent = choice.label; return option; }));
        }
        presentation.onchange = () => model.presentation.change(presentation.selectedIndex); presentation.disabled = model.presentation.disabled; presentation.value = model.presentation.value;
        apply = renderPanelButton(apply, model.apply);
        if (notes !== model.edits.items) { notes = model.edits.items; edits.replaceChildren(...notes.map(text => { const li = owner.createElement("li"), pre = owner.createElement("pre"); pre.textContent = text; li.append(pre); return li; })); }
        changed = renderPanelButton(changed, model.changed); changed.hidden = !model.changed.visible;
    }, () => { initial.results.bind(null); value.dispose(); });
}
