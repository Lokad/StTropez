import type { HostDocumentColors, ColorEditNote, ColorNote } from "./document-colors.ts";
export function documentColorActions(tools: HostDocumentColors) { const s = tools.state.getSnapshot(); return [
    { label: "Discover document colors", invoke: tools.discover, disabled: !s.available || s.disconnected || s.pending },
    { label: "Dismiss document colors", invoke: tools.cancel, disabled: s.token === null },
    { label: "Previous document colors", invoke: tools.previousPage, disabled: !s.page || s.pending },
    { label: "Next document colors", invoke: tools.nextPage, disabled: (s.page + 1) * 64 >= s.count || s.pending },
    { label: "Disconnect color provider", invoke: tools.disconnect, disabled: !s.connected && !s.pending },
    { label: "Reconnect color provider", invoke: tools.reconnect, disabled: !s.disconnected && s.status !== "failed" }
]; }
export const documentColorDescription = "Literal fixture: hex3/4/6/8 and legacy RGB/RGBA numeric or percentage values, including strings/comments. Wider CSS and language syntax are not parsed. Inspect a reference, edit the host value, preview all presentation edits and confirm explicitly. Hex choices appear only for byte-representable channels. F6 discovers/focuses the list.";
export const documentColorLabel = (color: ColorNote) => `Inspect ${color.label} at ${color.line}:${color.column}`;
export const colorEditLabel = (at: ColorEditNote) => `${at.title} · ${at.resource} · ${at.document} @ revision ${at.revision} · [${at.from},${at.to})\nInsert ${JSON.stringify(at.insert)}\nContext: ${at.context}`;
export function mountDocumentColorsPanel(host: HTMLElement, tools: HostDocumentColors): () => void {
    const owner = host.ownerDocument, heading = owner.createElement("h2"), description = owner.createElement("p"), status = owner.createElement("output"), controls = owner.createElement("div"), list = owner.createElement("ul"), label = owner.createElement("label"), value = owner.createElement("input"), swatch = owner.createElement("span"), preview = owner.createElement("button"), presentationLabel = owner.createElement("label"), presentation = owner.createElement("select"), apply = owner.createElement("button"), edits = owner.createElement("ol"), changed = owner.createElement("button");
    heading.textContent = "Document colors"; description.textContent = documentColorDescription; status.setAttribute("aria-label", "Document color status"); status.setAttribute("aria-live", "polite"); list.tabIndex = -1; list.setAttribute("aria-label", "Document color results"); tools.bindList(list);
    value.type = "text"; value.maxLength = 96; value.oninput = () => tools.setValue(value.value); label.append("Proposed color ", value); tools.bindValue(value); swatch.className = "host-color-swatch"; swatch.setAttribute("aria-hidden", "true"); preview.textContent = "Preview color presentations"; preview.onclick = tools.preview;
    presentationLabel.append("Color presentation ", presentation); presentation.onchange = () => tools.setPresentation(presentation.value); apply.textContent = "Apply captured color"; edits.setAttribute("aria-label", "Proposed color edits"); changed.onclick = tools.openChanged;
    const buttons = documentColorActions(tools).map(action => { const button = owner.createElement("button"); button.textContent = action.label; controls.append(button); return button; });
    host.replaceChildren(heading, description, status, controls, list, label, swatch, preview, presentationLabel, apply, edits, changed); let choiceKey = "", editsKey = "", listKey = "";
    const render = () => {
        const s = tools.state.getSnapshot(); status.textContent = s.message; for (const [i, action] of documentColorActions(tools).entries()) { buttons[i]!.disabled = action.disabled; buttons[i]!.onclick = action.invoke; }
        const nextList = JSON.stringify([s.token, s.page, s.selected, s.pending, s.colors]); if (nextList !== listKey) { listKey = nextList; list.replaceChildren(...s.colors.map(color => { const li = owner.createElement("li"), mark = owner.createElement("span"), button = owner.createElement("button"), token = s.token; mark.className = "host-color-swatch"; mark.style.backgroundColor = color.css; mark.setAttribute("aria-hidden", "true"); button.textContent = documentColorLabel(color); button.setAttribute("aria-pressed", String(s.selected === color.ordinal)); button.disabled = s.pending; button.onclick = () => tools.inspect(token, color.ordinal); li.append(mark, button); return li; })); }
        if (value.value !== s.value) value.value = s.value; swatch.style.backgroundColor = s.css ?? "transparent"; preview.disabled = !s.canPreview || s.pending;
        const nextChoices = JSON.stringify(s.choices); if (nextChoices !== choiceKey) { choiceKey = nextChoices; presentation.replaceChildren(...s.choices.map(c => { const option = owner.createElement("option"); option.value = c.id; option.textContent = c.label; return option; })); }
        presentation.disabled = !s.choices.length || s.pending; presentation.value = s.presentation; apply.disabled = !s.canApply || s.pending; apply.onclick = () => tools.apply(s.token, s.previewToken, s.presentation);
        const nextEdits = JSON.stringify(s.edits); if (nextEdits !== editsKey) { editsKey = nextEdits; edits.replaceChildren(...s.edits.map(at => { const li = owner.createElement("li"), pre = owner.createElement("pre"); pre.textContent = colorEditLabel(at); li.append(pre); return li; })); }
        changed.hidden = !s.changed; changed.disabled = s.pending || s.token !== null; changed.textContent = s.changed ? `Open color changes in ${s.changed.title}` : "Open color changes";
    };
    const stop = tools.state.subscribe(render); render(); return () => { stop(); tools.bindList(null); tools.bindValue(null); host.replaceChildren(); };
}
