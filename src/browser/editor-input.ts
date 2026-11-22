import type { TextEditor } from "./text-editor.ts";

/** Native event adapters capture the owned input once when they attach. */
export function editorInput(editor: TextEditor): HTMLTextAreaElement {
    const input = editor.element.querySelector<HTMLTextAreaElement>(":scope > textarea.st-input-context");
    if (!input) throw new Error("The editor input is unavailable.");
    return input;
}
