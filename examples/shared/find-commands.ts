import type { TextEditor } from "../../src/browser/index.ts";

/** Find fields and editor panes invoke the same commands on their captured editor. */
export function bindFindCommands(editor: TextEditor, signal: AbortSignal, open: (replace: boolean) => void,
    navigate: (direction: 1 | -1) => void | boolean, queryFocused: () => boolean) {
    const entries = [
        { id: "find.open", label: "Find", keys: ["Ctrl+f", "Meta+f"], run: () => open(false) },
        { id: "find.replace", label: "Find and replace", keys: ["Ctrl+h", "Meta+h"], run: () => open(true) },
        { id: "find.next", label: "Next match", keys: ["F3"], run: () => navigate(1) },
        { id: "find.previous", label: "Previous match", keys: ["Shift+F3"], run: () => navigate(-1) },
    ];
    for (const { id, label, keys, run } of entries) {
        const command = editor.commands.register({ id, label, run });
        signal.addEventListener("abort", command.dispose, { once: true });
        for (const key of keys) editor.keymap.bind(key, id, { shared: true });
    }
    for (const [key, direction, label] of [["Enter", "next", "Select next match"], ["Shift+Enter", "previous", "Select previous match"]] as const) {
        const command = editor.commands.register({ id: "find.query." + direction, label, enabled: queryFocused,
            run: () => { editor.commands.run("find." + direction); } }, { keys: [key], shared: true, priority: 40, repeat: false });
        signal.addEventListener("abort", command.dispose, { once: true });
    }
}
