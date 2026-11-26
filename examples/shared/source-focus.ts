import type { TextEditor } from "../../src/browser/index.ts";
import { attachPanelSession } from "./editor-attachment.ts";

/** A panel can sit below the editor. Bring the destination pane back onto the page. */
export function focusSource(editor: TextEditor) {
    editor.element.scrollIntoView({ block: "nearest", inline: "nearest" });
    editor.focus();
}

export function focusSourceCaret(editor: TextEditor) {
    editor.viewport.revealOffset(editor.view.getSnapshot().selection.head);
    focusSource(editor);
}

/** A panel or gutter control inside the editor can receive focus without activating the source. */
export function onSourceFocus(editor: TextEditor, signal: AbortSignal, activate: () => void): void {
    const check = () => {
        if (editor.getSnapshot().focused) activate();
    };
    editor.element.addEventListener("focusin", check, { signal });
    if (!signal.aborted) check();
}

export type PlainPane = { id: string; editor: TextEditor; controller: undefined };

/** Focusing plain text clears the panel's last language source. */
export function attachPlainPane<S extends { editor: TextEditor }>(
    sessions: Map<S | PlainPane, () => void>,
    id: string,
    editor: TextEditor,
    activate: () => void
) {
    return attachPanelSession<S | PlainPane>(sessions, { id, editor, controller: undefined }, (signal) =>
        onSourceFocus(editor, signal, activate)
    );
}
