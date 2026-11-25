import type { EditingCommand } from "../core/language-edits.ts";
import { commandKey, historyKey, type CaretDirection, type DeletionCommand, type KeyBinding, type ViewCommand } from "./editing-keys.ts";

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
    "move-left": "Move left", "move-right": "Move right", "move-up": "Move up", "move-down": "Move down",
    "select-left": "Select left", "select-right": "Select right", "select-up": "Select up", "select-down": "Select down",
    "move-page-up": "Move up a page", "move-page-down": "Move down a page",
    "select-page-up": "Select up a page", "select-page-down": "Select down a page",
    "delete-backward": "Delete backward", "delete-forward": "Delete forward",
} satisfies Record<ViewCommand | DeletionCommand, string>;
const edits = {
    "move-line-up": "Move line up", "move-line-down": "Move line down", "copy-line-up": "Copy line up", "copy-line-down": "Copy line down",
    "insert-line-above": "Insert line above", "insert-line-below": "Insert line below", "delete-lines": "Delete lines",
    indent: "Indent", "indent-lines": "Indent lines", outdent: "Outdent", "line-comment": "Toggle line comment",
    "add-line-comment": "Add line comment", "remove-line-comment": "Remove line comment", "block-comment": "Toggle block comment", newline: "Newline",
} satisfies Record<EditingCommand, string>;

export const editorCommandLabels = Object.freeze({ undo: "Undo", redo: "Redo", ...paneCommands, ...edits });
export function editCommand(id: string): id is EditingCommand { return Object.hasOwn(edits, id); }
export function editorKeyCommand(id: string, key: string): KeyBinding | undefined {
    if (id === "undo" || id === "redo") return historyKey(id);
    if (editCommand(id)) {
        const tab = key === "Tab" && (id === "indent" || id === "outdent");
        return { command: { kind: "language", command: id }, edit: true, text: id === "newline" ? "\n" : tab ? "\t" : "", fallback: id === "newline" };
    }
    if (Object.hasOwn(paneCommands, id)) return commandKey(id as keyof typeof paneCommands);
    return;
}

type Shortcut = readonly [keys: string, command: keyof typeof editorCommandLabels];
const common: readonly Shortcut[] = [
    ["Backspace", "delete-backward"], ["Shift+Backspace", "delete-backward"], ["Delete", "delete-forward"],
    ["Ctrl+ArrowUp", "scroll-line-up"], ["Ctrl+ArrowDown", "scroll-line-down"],
    ["Tab", "indent"], ["Shift+Tab", "outdent"], ["Enter", "newline"], ["Shift+Enter", "newline"],
    ["Mod+z", "undo"], ["Mod+Shift+z", "redo"], ["Ctrl+y", "redo"], ["Mod+a", "select-all"],
    ["Mod+k Mod+c", "add-line-comment"], ["Mod+k Mod+u", "remove-line-comment"], ["Mod+u", "undo-caret"],
    ["Mod+Alt+ArrowUp", "add-caret-above"], ["Mod+Alt+ArrowDown", "add-caret-below"], ["Mod+Shift+k", "delete-lines"],
    ["Mod+Enter", "insert-line-below"], ["Mod+Shift+Enter", "insert-line-above"], ["Mod+]", "indent-lines"], ["Mod+[", "outdent"],
    ["Alt+ArrowUp", "move-line-up"], ["Alt+ArrowDown", "move-line-down"], ["Alt+Shift+ArrowUp", "copy-line-up"], ["Alt+Shift+ArrowDown", "copy-line-down"],
    ["Mod+l", "select-line"], ["Mod+d", "select-next-occurrence"], ["Mod+g", "go-to-line"], ["Mod+Shift+l", "select-all-occurrences"],
    ["Mod+Shift+\\", "jump-to-bracket"], ["Alt+PageUp", "scroll-page-up"], ["Alt+PageDown", "scroll-page-down"],
    ["Mod+/", "line-comment"], ["Alt+Shift+a", "block-comment"],
];
type Movement = CaretDirection | `word-${"backward" | "forward"}` | `to-${"line" | "document"}-${"start" | "end"}`;

function shortcuts(apple: boolean): readonly Shortcut[] {
    const rows = [...common];
    function movement(modifier: string, key: string, direction: Movement) {
        rows.push([modifier + key, `move-${direction}`], [modifier + "Shift+" + key, `select-${direction}`]);
    }
    for (const [key, direction] of [
        ["ArrowLeft", "left"], ["ArrowRight", "right"], ["ArrowUp", "up"], ["ArrowDown", "down"],
        ["PageUp", "page-up"], ["PageDown", "page-down"],
    ] as const) movement("", key, direction);
    for (const [key, end] of [["Home", "start"], ["End", "end"]] as const) {
        movement("", key, `to-line-${end}`);
        movement("Mod+", key, `to-document-${end}`);
    }
    if (apple) {
        rows.push(["Alt+Shift+Code:KeyA", "block-comment"]);
        movement("Meta+", "ArrowLeft", "to-line-start");
        movement("Meta+", "ArrowRight", "to-line-end");
        movement("Meta+", "ArrowUp", "to-document-start");
        movement("Meta+", "ArrowDown", "to-document-end");
    }
    for (const modifier of apple ? ["Ctrl+", "Alt+"] : ["Ctrl+"]) {
        movement(modifier, "ArrowLeft", "word-backward");
        movement(modifier, "ArrowRight", "word-forward");
        for (const prefix of [modifier, modifier + "Shift+"]) {
            rows.push([prefix + "Backspace", "delete-word-backward"], [prefix + "Delete", "delete-word-forward"]);
        }
    }
    return Object.freeze(rows.map(row => Object.freeze(row)));
}

/** Complete base-editor bindings. Feature controllers register their own shortcuts on attachment. */
export const defaultEditorShortcuts = Object.freeze({ standard: shortcuts(false), apple: shortcuts(true) });
