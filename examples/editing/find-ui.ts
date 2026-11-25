import { createFindController, createRegexFindBackend } from "../../src/browser/index.ts";
import type { TextEditor } from "../../src/browser/index.ts";
import { bindFindCommands } from "../shared/find-commands.ts";
import { findStatus } from "../shared/find-status.ts";
import { scopedCommands } from "../shared/editor-attachment.ts";

export function mountFindUI(editor: TextEditor) {
    const owner = editor.element.ownerDocument;
    const find = createFindController(editor, { regularExpressionBackend: createRegexFindBackend({ clock: owner.defaultView!,
        createWorker: () => new Worker("/regex-worker.js", { type: "module" }) }) }), listeners = new AbortController();
    const query = owner.getElementById("find-query") as HTMLInputElement, replacement = owner.getElementById("replacement") as HTMLInputElement;
    const wholeWord = owner.getElementById("find-whole-word") as HTMLInputElement;
    const matchCase = owner.getElementById("find-match-case") as HTMLInputElement;
    const regularExpression = owner.getElementById("find-regex") as HTMLInputElement;
    const controls = ["find-next", "find-previous", "replace-current", "replace-all"].map(id => owner.getElementById(id) as HTMLButtonElement);
    const render = () => {
        const state = find.getSnapshot();
        owner.getElementById("find-status")!.textContent = findStatus(state);
        for (const control of controls) control.disabled = !state.count || !(state.status === "ready" || control.id !== "replace-all" && state.status === "searching" && state.retained);
        wholeWord.checked = state.wholeWord; matchCase.checked = state.matchCase; regularExpression.checked = state.regularExpression;
    };
    query.addEventListener("input", () => find.setQuery(query.value), { signal: listeners.signal });
    const optionsChanged = () => find.setFlags({ wholeWord: wholeWord.checked, matchCase: matchCase.checked, regularExpression: regularExpression.checked });
    wholeWord.addEventListener("change", optionsChanged, { signal: listeners.signal });
    matchCase.addEventListener("change", optionsChanged, { signal: listeners.signal });
    regularExpression.addEventListener("change", optionsChanged, { signal: listeners.signal });
    const resume = () => {
        const state = find.getSnapshot();
        if (state.status === "cancelled") find.setQuery(state.query);
    };
    const navigate = (direction: 1 | -1) => {
        if (!find.getSnapshot().query) return false;
        resume(); find.next(direction, { whenReady: true }); return true;
    };
    const register = scopedCommands(editor, listeners.signal);
    bindFindCommands(register, replace => {
        resume(); const field = replace ? replacement : query; field.focus(); field.select();
    }, navigate, () => owner.activeElement === query);
    const panel = query.closest("section")!;
    register({ id: "find.dismiss", label: "Dismiss Find", enabled: () => panel.contains(owner.activeElement),
        run: () => { find.cancel(); editor.focus(); } }, { keys: ["Escape"], shared: true, repeat: false });
    register({ id: "find.replaceCurrent", label: "Replace match", enabled: () => owner.activeElement === replacement,
        run: () => { find.replaceCurrent(replacement.value); } }, { keys: ["Enter", "Shift+Enter"], shared: true, priority: 41, repeat: false });
    panel.addEventListener("keydown", event => { editor.keymap.handle(event); }, { signal: listeners.signal });
    const on = (id: string, action: () => void) => owner.getElementById(id)!.addEventListener("click", action, { signal: listeners.signal });
    on("find-next", () => navigate(1)); on("find-previous", () => navigate(-1)); on("replace-current", () => find.replaceCurrent(replacement.value));
    on("replace-all", () => find.replaceAll(replacement.value, { focusEditor: true })); on("find-cancel", find.cancel);
    const unsubscribe = find.subscribe(render); render();
    return { find, dispose: () => { listeners.abort(); unsubscribe(); find.dispose(); } };
}
