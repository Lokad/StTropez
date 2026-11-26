import { completionFeedback } from "../../../examples/shared/language/completion-feedback.ts";
import type { HostLanguageTools } from "./language.ts";
type LanguageSnapshot = ReturnType<HostLanguageTools["state"]["getSnapshot"]>;
type LanguagePanelTools = Pick<HostLanguageTools, "state" | "toolsRef" | "keyFromTools" | "disconnect" | "reconnect" | "foldSelection" | "expandFolds" | "focusEditor">;
const capturedCommand = (tools: Pick<LanguagePanelTools, "state">, state: LanguageSnapshot, invoke: () => void) => () => {
    if (tools.state.getSnapshot() === state) invoke();
};

function languageActions(tools: LanguagePanelTools, state: LanguageSnapshot): readonly Readonly<{
    label: string; invoke: () => void; disabled: boolean;
}>[] {
    const available = state.view !== null;
    return [
        { label: "Disconnect provider", invoke: tools.disconnect, disabled: !state.provider?.connected },
        { label: "Reconnect provider", invoke: tools.reconnect, disabled: !available || state.readOnlyReference },
        { label: "Fold selected lines", invoke: tools.foldSelection, disabled: !available },
        { label: "Expand all folds", invoke: tools.expandFolds, disabled: !state.folds?.index.collapsedCount },
        { label: "Return to source", invoke: tools.focusEditor, disabled: !available }
    ] as const;
}
function foldText(state: LanguageSnapshot): string {
    const count = state.folds?.index.collapsedCount ?? 0;
    return state.foldMessage || `${count} folded ${count === 1 ? "region" : "regions"}.`;
}
/** Rendering only observes the supplied snapshot; result activation checks that it is still current. */
export function languagePanelModel(tools: LanguagePanelTools, state: LanguageSnapshot) {
    return {
        label: "Language and find tools", title: "Language and find", bind: tools.toolsRef, key: tools.keyFromTools,
        help: "Ctrl+Space requests completion; Alt+Enter replaces it. Ctrl+F finds, Ctrl+H replaces, F3 moves to the next match, and Escape returns to source. Ctrl+S saves the working source.",
        status: { label: "Language status", text: state.readOnlyReference ? "Search in the read-only reference. Replacement is unavailable." : state.provider ? completionFeedback(state.provider)
            : (state.providerError !== null ? `Language provider unavailable: ${state.providerError} Local editing and Find remain available. Use Reconnect provider to retry.` : "Focus a source view to use language actions.") },
        diagnosticStatus: { label: "Diagnostic status", text: state.provider?.diagnosticsPending ? "Diagnostics pending analysis." : "" },
        diagnostics: { label: "Source diagnostics", items: () => (state.provider?.diagnostics ?? []).map((diagnostic, index) => ({ key: `${diagnostic.from}:${diagnostic.to}:${index}`,
            label: `${diagnostic.from}: ${diagnostic.message}`, invoke: capturedCommand(tools, state, diagnostic.select) } as const)) },
        uncertain: { label: "Unversioned diagnostics", items: () => state.provider?.unversionedDiagnostics ?? [] },
        folds: { label: "Fold status", text: foldText(state) }, actions: languageActions(tools, state),
    } as const;
}

/** Plain host's own controls; editor descendants are mounted by ViewBindings. */
export function mountLanguagePanel(host: HTMLElement, tools: HostLanguageTools): () => void {
    const initial = languagePanelModel(tools, tools.state.getSnapshot()), owner = host.ownerDocument, listeners = new AbortController();
    initial.bind(host); host.setAttribute("aria-label", initial.label); host.addEventListener("keydown", initial.key, { signal: listeners.signal });
    const heading = owner.createElement("h2"), help = owner.createElement("p"), status = owner.createElement("output"), diagnosticStatus = owner.createElement("output"), foldStatus = owner.createElement("output");
    heading.textContent = initial.title; help.textContent = initial.help;
    for (const [element, model] of [[status, initial.status], [diagnosticStatus, initial.diagnosticStatus], [foldStatus, initial.folds]] as const) element.setAttribute("aria-label", model.label);
    const diagnostics = owner.createElement("ul"), uncertain = owner.createElement("ul"), nav = owner.createElement("div");
    diagnostics.setAttribute("aria-label", initial.diagnostics.label); uncertain.setAttribute("aria-label", initial.uncertain.label);
    diagnostics.addEventListener("pointerdown", event => event.preventDefault(), { signal: listeners.signal });
    const find = owner.createElement("div");
    tools.findRef(find);
    const buttons = initial.actions.map(action => {
        const button = owner.createElement("button"); button.textContent = action.label; nav.append(button);
        return button;
    });
    host.append(heading, help, status, diagnosticStatus, diagnostics, uncertain, find, foldStatus, nav);
    const setText = (element: HTMLElement, text: string) => { if (element.textContent !== text) element.textContent = text; };
    let diagnosticButtons: HTMLButtonElement[] = [];
    const render = () => {
        const state = tools.state.getSnapshot();
        const model = languagePanelModel(tools, state);
        find.hidden = state.view === null;
        for (const [element, value] of [[status, model.status], [diagnosticStatus, model.diagnosticStatus], [foldStatus, model.folds]] as const) setText(element, value.text);
        const messages = model.uncertain.items();
        if (uncertain.childElementCount !== messages.length || messages.some((message, index) => uncertain.children.item(index)?.textContent !== message)) {
            uncertain.replaceChildren(...messages.map(message => { const item = owner.createElement("li"); item.textContent = message; return item; }));
        }
        const currentDiagnostics = model.diagnostics.items();
        if (diagnostics.childElementCount !== currentDiagnostics.length || currentDiagnostics.some((row, index) => diagnostics.children.item(index)?.textContent !== row.label)) {
            for (const button of diagnosticButtons) button.onclick = null; diagnosticButtons = [];
            diagnostics.replaceChildren(...currentDiagnostics.map(row => { const item = owner.createElement("li"), button = owner.createElement("button"); button.textContent = row.label; diagnosticButtons.push(button); item.append(button); return item; }));
        }
        // Retaining a row must still renew its captured activation snapshot.
        for (const [index, row] of currentDiagnostics.entries()) diagnosticButtons[index]!.onclick = row.invoke;
        for (const [index, action] of model.actions.entries()) { const button = buttons[index]!; button.onclick = action.invoke; if (button.disabled !== action.disabled) button.disabled = action.disabled; }
    };
    const unsubscribe = tools.state.subscribe(render); render();
    return () => { unsubscribe(); listeners.abort(); for (const button of [...buttons, ...diagnosticButtons]) button.onclick = null; tools.findRef(null); initial.bind(null); host.replaceChildren(); };
}
