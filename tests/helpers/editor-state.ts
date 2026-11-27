import { createCommandRegistry } from "../../src/browser/command-registry.ts";
import { resolveLanguageConfiguration } from "../../src/core/language-edits.ts";
import { type DocumentId, type Workspace } from "../../src/index.ts";
import { NotificationScope, Store } from "../../src/core/observable.ts";
import { resolveControlStrings } from "../../src/browser/control-strings.ts";
import type { TextEditor, TextEditorSnapshot } from "../../src/browser/index.ts";

/** Editor state used by controller tests that run without a DOM. */
export function editorState(initial: Partial<TextEditorSnapshot> = {}) {
    const scope = new NotificationScope(), composition = new EventTarget();
    const state = new Store<TextEditorSnapshot>({ disabled: false, composing: false, focused: false, readOnlyReason: null, ...initial }, scope);
    const onEditIntent: TextEditor["onEditIntent"] = (listener, signal) => {
        const start = () => listener("compositionstart");
        composition.addEventListener("compositionstart", start, signal ? { signal } : {});
        return { dispose() { composition.removeEventListener("compositionstart", start); } };
    };
    return { ...state.observable, strings: resolveControlStrings(), onEditIntent,
        setReadOnly(value: boolean) { scope.publish(state, { ...state.get(), readOnlyReason: value ? "read-only" : null }); },
        startComposition() { composition.dispatchEvent(new Event("compositionstart")); },
    };
}

/** A mounted document view for language requests that do not need layout or native input. */
export function controllerEditor(workspace: Workspace, documentId: DocumentId) {
    const view = workspace.createDocumentView(documentId);
    const input = new EventTarget();
    const clock = Object.assign(new EventTarget(), { performance, clearTimeout });
    const element = Object.assign(new EventTarget(), { isConnected: true, querySelector: () => input,
        ownerDocument: { defaultView: clock } });
    const lifetime = new AbortController();
    const registry = createCommandRegistry(false, () => true, () => () => true, (): TextEditor => editor);
    const editor = {
        ...editorState({ focused: true }), workspace, view, signal: lifetime.signal, element, commands: registry.commands,
        settings: () => ({ language: resolveLanguageConfiguration() }), activity: () => ({ input: "idle" }),
        registerEditTransform: () => () => {}, viewport: { element: new EventTarget(), revealRange() {} },
        decorations: { add: () => ({ clear() {}, dispose() {} }) }, focus() {},
    } as unknown as TextEditor;
    return { editor, dispose() {
        lifetime.abort();
        registry.dispose();
        view.dispose();
    } };
}
