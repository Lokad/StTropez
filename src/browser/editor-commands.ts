import type { EditingCommand } from "../core/language-edits.ts";
import type { EditorKeymap } from "./command-registry.ts";
import { commandKey, historyKey, type KeyBinding, type ViewCommand, type WordDeletion } from "./editing-keys.ts";

const paneCommands = {
    "select-all": "Select all", "go-to-line": "Go to line", "select-line": "Select line", "jump-to-bracket": "Go to matching bracket",
    "add-caret-above": "Add caret above", "add-caret-below": "Add caret below", "undo-caret": "Undo caret change",
    "select-next-occurrence": "Select next occurrence", "select-all-occurrences": "Select all occurrences",
    "scroll-line-up": "Scroll line up", "scroll-line-down": "Scroll line down", "scroll-page-up": "Scroll page up", "scroll-page-down": "Scroll page down",
    "move-to-line-start": "Move to start of line", "move-to-line-end": "Move to end of line",
    "select-to-line-start": "Select to start of line", "select-to-line-end": "Select to end of line",
    "move-to-document-start": "Move to start of document", "move-to-document-end": "Move to end of document",
    "select-to-document-start": "Select to start of document", "select-to-document-end": "Select to end of document",
    "move-word-backward": "Move to previous word", "move-word-forward": "Move to next word",
    "select-word-backward": "Select to previous word", "select-word-forward": "Select to next word",
    "delete-word-backward": "Delete previous word", "delete-word-forward": "Delete next word",
} satisfies Record<ViewCommand | WordDeletion, string>;
const edits = {
    "move-line-up": "Move line up", "move-line-down": "Move line down", "copy-line-up": "Copy line up", "copy-line-down": "Copy line down",
    "insert-line-above": "Insert line above", "insert-line-below": "Insert line below", "delete-lines": "Delete lines",
    indent: "Indent", "indent-lines": "Indent lines", outdent: "Outdent", "line-comment": "Toggle line comment",
    "add-line-comment": "Add line comment", "remove-line-comment": "Remove line comment", "block-comment": "Toggle block comment", newline: "Newline",
} satisfies Record<EditingCommand, string>;

export const editorCommandLabels = Object.freeze({ undo: "Undo", redo: "Redo", ...paneCommands, ...edits });
export function editCommand(id: string): id is EditingCommand { return Object.hasOwn(edits, id); }
export function editorKeyCommand(id: string): KeyBinding | undefined {
    if (id === "undo" || id === "redo") return historyKey(id);
    if (editCommand(id)) return { command: { kind: "language", command: id }, edit: true, text: "", fallback: false };
    if (Object.hasOwn(paneCommands, id)) return commandKey(id as keyof typeof paneCommands);
    return;
}

const defaults: readonly (readonly [string, keyof typeof editorCommandLabels])[] = [
    ["Mod+z", "undo"], ["Mod+Shift+z", "redo"], ["Ctrl+y", "redo"], ["Mod+a", "select-all"],
    ["Mod+k Mod+c", "add-line-comment"], ["Mod+k Mod+u", "remove-line-comment"], ["Mod+u", "undo-caret"],
    ["Mod+Alt+ArrowUp", "add-caret-above"], ["Mod+Alt+ArrowDown", "add-caret-below"], ["Mod+Shift+k", "delete-lines"],
    ["Mod+Enter", "insert-line-below"], ["Mod+Shift+Enter", "insert-line-above"], ["Mod+]", "indent-lines"], ["Mod+[", "outdent"],
    ["Alt+ArrowUp", "move-line-up"], ["Alt+ArrowDown", "move-line-down"], ["Alt+Shift+ArrowUp", "copy-line-up"], ["Alt+Shift+ArrowDown", "copy-line-down"],
    ["Mod+l", "select-line"], ["Mod+d", "select-next-occurrence"], ["Mod+g", "go-to-line"], ["Mod+Shift+l", "select-all-occurrences"],
    ["Mod+Shift+\\", "jump-to-bracket"], ["Mod+Shift+|", "jump-to-bracket"], ["Alt+PageUp", "scroll-page-up"], ["Alt+PageDown", "scroll-page-down"],
    ["Mod+/", "line-comment"], ["Mod+Shift+/", "line-comment"], ["Alt+Shift+a", "block-comment"],
];
export function bindEditorDefaults(keymap: EditorKeymap, apple: boolean): void {
    function boundary(modifiers: string, key: string, to: "line-start" | "line-end" | "document-start" | "document-end") {
        keymap.bind(modifiers + key, `move-to-${to}`);
        keymap.bind(modifiers + "Shift+" + key, `select-to-${to}`);
    }
    boundary("", "Home", "line-start"); boundary("", "End", "line-end");
    for (const modifiers of ["Ctrl+", "Meta+", "Ctrl+Meta+"]) {
        boundary(modifiers, "Home", "document-start"); boundary(modifiers, "End", "document-end");
    }
    if (apple) {
        boundary("Meta+", "ArrowLeft", "line-start"); boundary("Meta+", "ArrowRight", "line-end");
        boundary("Meta+", "ArrowUp", "document-start"); boundary("Meta+", "ArrowDown", "document-end");
    }
    for (const modifier of apple ? ["Ctrl+", "Alt+"] : ["Ctrl+"]) {
        keymap.bind(modifier + "ArrowLeft", "move-word-backward"); keymap.bind(modifier + "ArrowRight", "move-word-forward");
        keymap.bind(modifier + "Shift+ArrowLeft", "select-word-backward"); keymap.bind(modifier + "Shift+ArrowRight", "select-word-forward");
        for (const prefix of [modifier, modifier + "Shift+"]) {
            keymap.bind(prefix + "Backspace", "delete-word-backward"); keymap.bind(prefix + "Delete", "delete-word-forward");
        }
    }
    for (const [keys, command] of defaults) {
        if (keys.includes("Mod+")) {
            for (const modifier of ["Ctrl+", "Meta+"]) keymap.bind(keys.replaceAll("Mod+", modifier), command);
        } else keymap.bind(keys, command);
    }
    for (const modifier of apple ? ["Ctrl"] : ["Ctrl", "Meta"]) {
        keymap.bind(modifier + "+ArrowUp", "scroll-line-up"); keymap.bind(modifier + "+ArrowDown", "scroll-line-down");
    }
}
