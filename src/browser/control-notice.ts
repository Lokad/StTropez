import { editorElement } from "./editor-element.ts";
import type { TextEditor } from "./text-editor.ts";

const notices = new WeakMap<TextEditor, () => void>();

/** Report a finished action without moving focus or registering key bindings. */
export function showControlNotice(editor: TextEditor, message: string) {
    notices.get(editor)?.();
    if (editor.signal.aborted) return;
    const element = editorElement(editor.element.ownerDocument, "output", "control-notice");
    element.textContent = message;
    editor.element.append(element);
    const win = element.ownerDocument.defaultView!;
    const timer = win.setTimeout(close, 3000);
    function close() {
        win.clearTimeout(timer);
        element.remove();
        editor.signal.removeEventListener("abort", close);
        notices.delete(editor);
    }
    notices.set(editor, close);
    editor.signal.addEventListener("abort", close, { once: true });
}
