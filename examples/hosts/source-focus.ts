import type { TextEditor } from "../../src/browser/index.ts";

/** A panel or gutter control inside the editor can receive focus without activating the source. */
export function onSourceFocus(editor: TextEditor, signal: AbortSignal, activate: () => void): void {
    const check = () => { if (editor.getSnapshot().focused) activate(); };
    editor.element.addEventListener("focusin", check, { signal });
    if (!signal.aborted) check();
}
