import { builtinKeyPriority, type EditorCommand } from "./command-registry.ts";
import type { TextEditor } from "./text-editor.ts";

type Action = Pick<EditorCommand, "enabled" | "run">;
export type FindCommandOptions = Readonly<{
    open: (replace: boolean) => void;
    navigate: (direction: 1 | -1) => boolean | void;
    queryFocused: () => boolean;
    replaceCurrent?: Action;
    replaceAll?: Action;
    insertLineBreak?: Action;
    close?: Action;
}>;

/** Bind the shared Find shortcuts to one pane and the host fields that act on it. */
export function bindFindCommands(editor: TextEditor, options: FindCommandOptions) {
    editor.signal.throwIfAborted();
    const handles: { dispose(): void }[] = [];
    const { text } = editor.strings;
    const keys = builtinKeyPriority;
    function dispose() {
        editor.signal.removeEventListener("abort", dispose);
        for (const handle of handles.splice(0)) handle.dispose();
    }
    function bind(id: string, label: string, key: string, action: Action | undefined, priority: number, repeat = false) {
        if (action) handles.push(editor.commands.register({ ...action, id: "find." + id, label, owner: "editor", category: text("Find") },
            { keys: [key], shared: true, priority, repeat }));
    }
    try {
        bind("open", "Find", "Mod+f", { run: () => options.open(false) }, keys.editor, true);
        bind("replace", "Find and replace", "Mod+h", { run: () => options.open(true) }, keys.editor, true);
        for (const [id, direction, shortcut, enter, label] of [
            ["next", 1, "F3", "Enter", "Next match"], ["previous", -1, "Shift+F3", "Shift+Enter", "Previous match"],
        ] as const) {
            bind(id, label, shortcut, { run: () => options.navigate(direction) }, keys.editor, true);
            bind("query." + id, "Select " + id + " match", enter,
                { enabled: options.queryFocused, run: () => { editor.commands.run("find." + id); } }, keys.field);
        }
        bind("replaceCurrent", "Replace current match", "Enter", options.replaceCurrent, keys.replacement);
        bind("replaceAll", "Replace all matches", "Ctrl+Alt+Enter", options.replaceAll, keys.editor);
        bind("insertLineBreak", "Insert a line break in Find or Replace", "Mod+Enter", options.insertLineBreak, keys.field);
        bind("close", "Close Find", "Escape", options.close, keys.editor);
        editor.signal.addEventListener("abort", dispose, { once: true });
    } catch (error) { dispose(); throw error; }
    return { dispose };
}
