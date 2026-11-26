import type { TextEditor } from "./text-editor.ts";
import { builtinKeyPriority, type EditorCommands } from "./command-registry.ts";

/** Find fields and editor panes invoke the same commands on their captured editor. */
export function bindFindCommands(register: (...args: Parameters<EditorCommands["register"]>) => void,
    open: (replace: boolean, pane: TextEditor) => void,
    navigate: (direction: 1 | -1, pane: TextEditor) => void | boolean, queryFocused: (pane: TextEditor) => boolean,
    text = (label: string) => label) {
    const entries = [
        { id: "find.open", label: "Find", keys: ["Mod+f"], run: (pane: TextEditor) => open(false, pane) },
        { id: "find.replace", label: "Find and replace", keys: ["Mod+h"], run: (pane: TextEditor) => open(true, pane) },
        { id: "find.next", label: "Next match", keys: ["F3"], run: (pane: TextEditor) => navigate(1, pane) },
        { id: "find.previous", label: "Previous match", keys: ["Shift+F3"], run: (pane: TextEditor) => navigate(-1, pane) },
    ];
    for (const { id, label, keys, run } of entries) {
        register({ id, label: text(label), category: text("Find"), run: (_, pane) => run(pane) }, { keys, shared: true, priority: builtinKeyPriority.editor });
    }
    for (const [key, direction, label] of [["Enter", "next", "Select next match"], ["Shift+Enter", "previous", "Select previous match"]] as const) {
        register({ id: "find.query." + direction, label: text(label), category: text("Find"), enabled: (_, pane) => queryFocused(pane),
            run: (_, pane) => { pane.commands.run("find." + direction); } }, { keys: [key], shared: true, priority: builtinKeyPriority.field, repeat: false });
    }
}
