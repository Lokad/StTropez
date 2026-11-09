import type { HostLanguageTools } from "./language.ts";

export function languageActions(tools: HostLanguageTools) {
    const state = tools.state.getSnapshot(), available = state.view !== null, offered = state.provider?.offerText != null, found = state.find?.status === "ready" && state.find.count > 0;
    return [
        { label: "Request completion", invoke: tools.request, disabled: !available },
        { label: "Insert completion", invoke: tools.insert, disabled: !offered },
        { label: "Replace completion", invoke: tools.replace, disabled: !offered },
        { label: "Cancel request", invoke: tools.cancel, disabled: !available },
        { label: "Disconnect provider", invoke: tools.disconnect, disabled: !state.provider?.connected },
        { label: "Reconnect provider", invoke: tools.reconnect, disabled: !available },
        { label: "Find next", invoke: tools.next, disabled: !found },
        { label: "Find previous", invoke: tools.previous, disabled: !found },
        { label: "Replace current", invoke: tools.replaceCurrent, disabled: !found },
        { label: "Replace all", invoke: tools.replaceAll, disabled: !found },
        { label: "Cancel find", invoke: tools.cancelFind, disabled: !available },
        { label: "Return to source", invoke: tools.focusEditor, disabled: !available }
    ] as const;
}
export function findText(tools: HostLanguageTools): string {
    const state = tools.state.getSnapshot().find;
    return state ? state.message || `${state.count} matches · ${state.status}` : "Find in the active source view.";
}
export function languageFieldKey(event: KeyboardEvent, tools: HostLanguageTools, replacement: boolean): void {
    if (event.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); tools.cancelFind(); }
    else if (event.key === "Enter" || event.key === "F3") { event.preventDefault();
        if (event.key === "Enter" && replacement) tools.replaceCurrent(); else if (event.shiftKey) tools.previous(); else tools.next(); }
}

/** Plain host's own controls; editor descendants are mounted by ViewBindings. */
export function mountLanguagePanel(host: HTMLElement, tools: HostLanguageTools): () => void {
    const owner = host.ownerDocument, listeners = new AbortController(), heading = owner.createElement("h2"), status = owner.createElement("output");
    heading.textContent = "Language and find"; status.setAttribute("aria-label", "Language status"); status.setAttribute("aria-live", "polite");
    const help = owner.createElement("p"); help.textContent = "Ctrl+Space requests completion; Alt+Enter replaces it. Ctrl+F finds, Ctrl+H replaces, F3 moves to the next match, and Escape returns to source.";
    const choices = owner.createElement("ul"), diagnostics = owner.createElement("ul"), nav = owner.createElement("div"), findStatus = owner.createElement("output");
    choices.setAttribute("role", "listbox"); choices.setAttribute("aria-label", "Completion choices"); diagnostics.setAttribute("aria-label", "Source diagnostics"); findStatus.setAttribute("aria-label", "Find status");
    const fields = ["Find source", "Replacement"].map((name, index) => {
        const label = owner.createElement("label"), field = owner.createElement("input"); label.textContent = name; label.append(field);
        field.addEventListener("input", () => index ? tools.setReplacement(field.value) : tools.setQuery(field.value), { signal: listeners.signal });
        field.addEventListener("keydown", event => languageFieldKey(event, tools, index === 1), { signal: listeners.signal }); return { label, field };
    });
    tools.queryRef(fields[0]!.field); tools.replacementRef(fields[1]!.field);
    const wholeLabel = owner.createElement("label"), wholeWord = owner.createElement("input");
    wholeWord.type = "checkbox"; wholeLabel.append(wholeWord, "Whole word");
    wholeWord.addEventListener("change", () => tools.setWholeWord(wholeWord.checked), { signal: listeners.signal });
    const caseLabel = owner.createElement("label"), matchCase = owner.createElement("input");
    matchCase.type = "checkbox"; caseLabel.append(matchCase, "Match case");
    matchCase.addEventListener("change", () => tools.setMatchCase(matchCase.checked), { signal: listeners.signal });
    const buttons = languageActions(tools).map(action => { const button = owner.createElement("button"); button.textContent = action.label;
        button.addEventListener("click", action.invoke, { signal: listeners.signal }); nav.append(button); return button; });
    host.append(heading, help, status, choices, diagnostics, ...fields.map(f => f.label), wholeLabel, caseLabel, findStatus, nav);
    const setText = (element: HTMLElement, text: string) => { if (element.textContent !== text) element.textContent = text; };
    const render = () => {
        const state = tools.state.getSnapshot(); setText(status, state.provider?.message ?? "Focus a source view to use language actions.");
        const offered = state.provider?.offerText;
        if (offered != null) {
            if (choices.childElementCount !== 1 || choices.firstElementChild?.textContent !== offered) {
                const item = owner.createElement("li"); item.textContent = offered; item.setAttribute("role", "option"); item.setAttribute("aria-selected", "true"); choices.replaceChildren(item);
            }
        } else if (choices.childNodes.length) choices.replaceChildren();
        const currentDiagnostics = state.provider?.diagnostics ?? [];
        if (diagnostics.childElementCount !== currentDiagnostics.length || currentDiagnostics.some((diagnostic, index) => diagnostics.children.item(index)?.textContent !== `${diagnostic.from}: ${diagnostic.message}`)) {
            const items = currentDiagnostics.map((diagnostic, index) => { const item = owner.createElement("li"), button = owner.createElement("button"); button.textContent = `${diagnostic.from}: ${diagnostic.message}`;
                button.onclick = () => tools.selectDiagnostic(index); item.append(button); return item; });
            diagnostics.replaceChildren(...items);
        }
        for (const [index, action] of languageActions(tools).entries()) { const button = buttons[index]!; if (button.disabled !== action.disabled) button.disabled = action.disabled; }
        setText(findStatus, findText(tools));
        if (fields[0]!.field.value !== state.query) fields[0]!.field.value = state.query;
        if (fields[1]!.field.value !== state.replacement) fields[1]!.field.value = state.replacement;
        wholeWord.checked = state.wholeWord; matchCase.checked = state.matchCase;
    };
    const unsubscribe = tools.state.subscribe(render); render();
    return () => { unsubscribe(); listeners.abort(); tools.queryRef(null); tools.replacementRef(null); host.replaceChildren(); };
}
