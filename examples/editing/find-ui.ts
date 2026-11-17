import { createFindController, createRegexFindBackend } from "../../src/browser/index.ts";
import type { TextEditor } from "../../src/browser/index.ts";
import type { TabId, Workspace } from "../../src/index.ts";
import type { EditingPresentation } from "../shared/language/presentation.ts";

export function mountFindUI(workspace: Workspace, tab: TabId, editor: TextEditor, presentation: EditingPresentation) {
    const owner = editor.element.ownerDocument;
    const find = createFindController(workspace, tab, editor, { regularExpression: createRegexFindBackend({ clock: owner.defaultView!,
        createWorker: () => new Worker("/regex-worker.js", { type: "module" }) }) }), listeners = new AbortController();
    const query = owner.getElementById("find-query") as HTMLInputElement, replacement = owner.getElementById("replacement") as HTMLInputElement;
    const wholeWord = owner.getElementById("find-whole-word") as HTMLInputElement;
    const matchCase = owner.getElementById("find-match-case") as HTMLInputElement;
    const regularExpression = owner.getElementById("find-regex") as HTMLInputElement;
    const controls = ["find-next", "find-previous", "replace-current", "replace-all"].map(id => owner.getElementById(id) as HTMLButtonElement);
    const render = () => {
        const state = find.state.getSnapshot(), changed = presentation.search?.revision !== state.revision || presentation.search.version !== state.matchesVersion;
        presentation.search = { revision: state.revision, version: state.matchesVersion, matchesIn: (from, to) => find.matchesIn(from, to, state) };
        owner.getElementById("find-status")!.textContent = state.message || (state.status === "searching" ? `Searching… ${state.count} matches` : `${state.count} matches · ${state.status}`);
        for (const control of controls) control.disabled = !state.count || !(state.status === "ready" || control.id !== "replace-all" && state.status === "searching" && state.retained);
        wholeWord.checked = state.wholeWord; matchCase.checked = state.matchCase; regularExpression.checked = state.regularExpression;
        if (changed) editor.viewport.invalidate();
    };
    query.addEventListener("input", () => find.setQuery(query.value), { signal: listeners.signal });
    const optionsChanged = () => find.setOptions({ wholeWord: wholeWord.checked, matchCase: matchCase.checked, regularExpression: regularExpression.checked });
    wholeWord.addEventListener("change", optionsChanged, { signal: listeners.signal });
    matchCase.addEventListener("change", optionsChanged, { signal: listeners.signal });
    regularExpression.addEventListener("change", optionsChanged, { signal: listeners.signal });
    for (const field of [query, replacement]) field.addEventListener("keydown", event => {
        if (event.key === "Escape") { event.preventDefault(); find.cancel(); editor.focus(); }
        else if (event.key === "Enter" || event.key === "F3") { event.preventDefault();
            if (field === replacement && event.key === "Enter") find.replaceCurrent(replacement.value); else find.next(event.shiftKey ? -1 : 1);
        }
    }, { signal: listeners.signal });
    const on = (id: string, action: () => void) => owner.getElementById(id)!.addEventListener("click", action, { signal: listeners.signal });
    on("find-next", () => find.next()); on("find-previous", () => find.next(-1)); on("replace-current", () => find.replaceCurrent(replacement.value));
    on("replace-all", () => find.replaceAll(replacement.value)); on("find-cancel", find.cancel);
    editor.element.addEventListener("keydown", event => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && ["f", "h"].includes(event.key.toLowerCase())) {
            event.preventDefault(); if (find.state.getSnapshot().status === "cancelled") find.setQuery(query.value);
            const field = event.key.toLowerCase() === "h" ? replacement : query; field.focus(); field.select();
        } else if (event.key === "F3") { event.preventDefault(); find.next(event.shiftKey ? -1 : 1); }
    }, { signal: listeners.signal });
    const unsubscribe = find.state.subscribe(render); render();
    return { find, destroy: () => { listeners.abort(); unsubscribe(); find.destroy(); presentation.search = undefined; } };
}
