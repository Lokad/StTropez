import type { TabId, Workspace } from "../../src/index.ts";
import type { TextEditor } from "../../src/browser/index.ts";
import { createProviderController } from "../shared/language/provider-controller.ts";
import type { EditingPresentation } from "../shared/language/presentation.ts";

/** The editing playground renders its own controls around the shared host service. */
export function mountProviderUI(workspace: Workspace, tabId: TabId, editor: TextEditor, presentation: EditingPresentation) {
    const provider = createProviderController(workspace, tabId, editor), owner = editor.element.ownerDocument, listeners = new AbortController();
    const status = owner.getElementById("provider-status")!, choices = owner.getElementById("completion-choices")!, list = owner.getElementById("provider-diagnostics")!;
    const render = () => {
        const state = provider.state.getSnapshot(); status.textContent = state.message; choices.replaceChildren(); list.replaceChildren();
        if (state.offerText !== null) { const item = owner.createElement("li"); item.textContent = state.offerText; item.setAttribute("role", "option"); item.setAttribute("aria-selected", "true"); choices.append(item); }
        state.diagnostics.forEach((diagnostic, index) => { const item = owner.createElement("li"), button = owner.createElement("button");
            button.textContent = `${diagnostic.from}: ${diagnostic.message}`; button.dataset.index = String(index); item.append(button); list.append(item); });
        for (const id of ["completion-insert", "completion-replace"]) (owner.getElementById(id) as HTMLButtonElement).disabled = state.offerText === null;
        const changed = presentation.diagnostics?.revision !== state.diagnosticRevision || presentation.diagnostics.ranges !== state.diagnostics;
        presentation.diagnostics = { revision: state.diagnosticRevision, ranges: state.diagnostics }; if (changed) editor.viewport.invalidate();
    };
    const on = (id: string, action: () => void) => owner.getElementById(id)!.addEventListener("click", action, { signal: listeners.signal });
    on("provider-request", provider.request); on("completion-insert", () => provider.apply("insert")); on("completion-replace", () => provider.apply("replace"));
    on("provider-cancel", provider.cancel); on("provider-disconnect", provider.disconnect); on("provider-reconnect", provider.connect);
    list.addEventListener("click", event => {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-index]"); if (button) provider.selectDiagnostic(Number(button.dataset.index));
    }, { signal: listeners.signal });
    const unsubscribe = provider.state.subscribe(render); render();
    return { ...provider, destroy: () => { unsubscribe(); listeners.abort(); provider.destroy(); presentation.diagnostics = undefined; } };
}
