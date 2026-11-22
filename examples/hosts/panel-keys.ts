import type { TextEditor } from "../../src/browser/index.ts";

/** Forward shared shortcuts to the panel's current owner, including after a view replacement. */
export function createPanelKeyBinding<T extends HTMLElement>(owner: () => TextEditor | undefined) {
    let element: T | null = null, disposed = false;
    const keydown = (event: KeyboardEvent) => {
        if (owner()?.keymap.handle(event)) event.stopPropagation();
    };
    function bind(next: T | null) {
        if (disposed || next === element) return;
        element?.removeEventListener("keydown", keydown);
        element = next;
        element?.addEventListener("keydown", keydown);
    }
    return { get element() { return element; }, bind, dispose() { bind(null); disposed = true; } };
}
