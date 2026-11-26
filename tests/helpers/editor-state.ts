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
