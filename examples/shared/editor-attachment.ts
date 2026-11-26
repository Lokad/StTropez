import { captureViewRequest, type TextEditor } from "../../src/browser/index.ts";
import { CleanupScope } from "./cleanup-scope.ts";

/** A pending host command belongs to one mounted editor and expires when composition starts. */
export function captureEditorCommand(editor: TextEditor, editOrigin?: "human") {
    const source = captureViewRequest(editor, {
        ...(editOrigin && { editOrigin }),
        available: () => {
            const activity = editor.activity(), state = editor.getSnapshot();
            return editor.element.isConnected && !state.disabled
                && !activity.disposed && activity.input === "idle"
                && (!editOrigin || state.readOnlyReason === null);
        },
    });
    if (source) editor.onEditIntent(kind => { if (kind === "compositionstart") source.cancel(); }, source.signal);
    return source;
}

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

/** A failed mount and either teardown order release the same pane and controller. */
export function attachPanelSession<S extends { editor: TextEditor }>(
    sessions: Map<S, () => void>, session: S,
    bind: (signal: AbortSignal, register: ReturnType<typeof scopedCommands>) => void, retire?: () => void,
    dispose?: () => void,
) {
    const scope = new CleanupScope(), events = new AbortController();
    if (dispose) scope.defer(dispose);
    if (retire) scope.defer(retire);
    scope.defer(() => { sessions.delete(session); events.abort(); });
    sessions.set(session, scope.dispose);
    try {
        bind(events.signal, scopedCommands(session.editor, events.signal));
        return detachWithEditor(session.editor, events.signal, scope.dispose);
    } catch (error) { return scope.rollback(error); }
}
