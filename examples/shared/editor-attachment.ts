import type { TextEditor } from "../../src/browser/index.ts";

/** Use the same teardown when the pane closes before its host feature. */
export function detachWithEditor(editor: TextEditor, signal: AbortSignal, detach: () => void) {
    if (editor.signal.aborted) detach();
    else editor.signal.addEventListener("abort", detach, { once: true, signal });
    return detach;
}

/** Register commands for one host attachment. Either owner can release the shortcuts. */
export function scopedCommands(editor: TextEditor, signal: AbortSignal) {
    return (...args: Parameters<TextEditor["commands"]["register"]>): void => {
        signal.throwIfAborted();
        const command = editor.commands.register(...args);
        signal.addEventListener("abort", command.dispose, { once: true, signal: editor.signal });
    };
}
