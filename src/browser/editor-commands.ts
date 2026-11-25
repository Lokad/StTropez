import type { EditingCommand } from "../core/language-edits.ts";
import { commandKey, historyKey, type CaretDirection, type KeyBinding, type ViewCommand, type DeletionCommand } from "./editing-keys.ts";
import type { TextEditorCommand } from "./text-editor.ts";

type Shortcut = readonly [keys: string, command: TextEditorCommand];
type Shortcuts = readonly string[];
type Movement = CaretDirection | `word-${"backward" | "forward"}` | `to-${"line" | "document"}-${"start" | "end"}`;
const edits = {
    "move-line-up": ["Alt+ArrowUp"],
    "move-line-down": ["Alt+ArrowDown"],
    "copy-line-up": ["Alt+Shift+ArrowUp"],
    "copy-line-down": ["Alt+Shift+ArrowDown"],
    "insert-line-above": ["Mod+Shift+Enter"],
    "insert-line-below": ["Mod+Enter"],
    "delete-lines": ["Mod+Shift+k"],
    "indent": ["Tab"],
    "indent-lines": ["Mod+]"],
    "outdent": ["Shift+Tab", "Mod+["],
    "line-comment": ["Mod+/"],
    "add-line-comment": ["Mod+k Mod+c"],
    "remove-line-comment": ["Mod+k Mod+u"],
    "block-comment": ["Alt+Shift+a"],
    "newline": ["Enter", "Shift+Enter"],
} satisfies Record<EditingCommand, Shortcuts>;

const definitions = {
    ...edits,
    "select-all": ["Mod+a"],
    "go-to-line": ["Mod+g"],
    "select-line": ["Mod+l"],
    "jump-to-bracket": ["Mod+Shift+\\"],
    "add-caret-above": ["Mod+Alt+ArrowUp"],
    "add-caret-below": ["Mod+Alt+ArrowDown"],
    "undo-caret": ["Mod+u"],
    "select-next-occurrence": ["Mod+d"],
    "select-all-occurrences": ["Mod+Shift+l"],
    "scroll-line-up": ["Ctrl+ArrowUp"],
    "scroll-line-down": ["Ctrl+ArrowDown"],
    "scroll-page-up": ["Alt+PageUp"],
    "scroll-page-down": ["Alt+PageDown"],
    "delete-word-backward": [],
    "delete-word-forward": [],
    "delete-backward": ["Backspace", "Shift+Backspace"],
    "delete-forward": ["Delete"],
    "undo": ["Mod+z"],
    "redo": ["Mod+Shift+z", "Ctrl+y"],
} satisfies Record<Exclude<TextEditorCommand, `move-${Movement}` | `select-${Movement}`>, Shortcuts>;

const movements = {
    left: ["left", "ArrowLeft"],
    right: ["right", "ArrowRight"],
    up: ["up", "ArrowUp"],
    down: ["down", "ArrowDown"],
    "page-up": ["up a page", "PageUp"],
    "page-down": ["down a page", "PageDown"],
    "to-line-start": ["to start of line", "Home", "Meta+ArrowLeft"],
    "to-line-end": ["to end of line", "End", "Meta+ArrowRight"],
    "to-document-start": ["to start of document", "Mod+Home", "Meta+ArrowUp"],
    "to-document-end": ["to end of document", "Mod+End", "Meta+ArrowDown"],
    "word-backward": ["to previous word", "Ctrl+ArrowLeft", "Alt+ArrowLeft"],
    "word-forward": ["to next word", "Ctrl+ArrowRight", "Alt+ArrowRight"],
} satisfies Record<Movement, [label: string, keys: string, appleKeys?: string]>;

const captions: Partial<Record<TextEditorCommand, string>> = {
    "line-comment": "Toggle line comment",
    "block-comment": "Toggle block comment",
    "jump-to-bracket": "Go to matching bracket",
    "undo-caret": "Undo caret change",
    "delete-word-backward": "Delete previous word",
    "delete-word-forward": "Delete next word",
};

const labels = new Map<TextEditorCommand, string>();
const common: Shortcut[] = [];
const apple: Shortcut[] = [["Alt+Shift+Code:KeyA", "block-comment"]];
for (const id of Object.keys(definitions) as (keyof typeof definitions)[]) {
    labels.set(id, captions[id] ?? id[0]!.toUpperCase() + id.slice(1).replaceAll("-", " "));
    for (const key of definitions[id]) common.push([key, id]);
}
for (const direction of Object.keys(movements) as Movement[]) {
    const [label, keys, appleKeys] = movements[direction];
    const move = `move-${direction}` as const;
    const select = `select-${direction}` as const;
    labels.set(move, "Move " + label);
    labels.set(select, "Select " + label);
    const bind = (rows: Shortcut[], key: string) => {
        rows.push([key, move], [key.replace(/[^+]+$/, "Shift+$&"), select]);
    };
    bind(common, keys);
    if (appleKeys) bind(apple, appleKeys);
}
for (const [key, id] of [["Backspace", "delete-word-backward"], ["Delete", "delete-word-forward"]] as const) {
    common.push(["Ctrl+" + key, id], ["Ctrl+Shift+" + key, id]);
    apple.push(["Alt+" + key, id], ["Alt+Shift+" + key, id]);
}

export const editorCommandLabels: ReadonlyMap<TextEditorCommand, string> = labels;
const appleShortcuts = [...common, ...apple];
for (const row of appleShortcuts) Object.freeze(row);
/** Complete base-editor bindings. Feature controllers register their own shortcuts on attachment. */
export const defaultEditorShortcuts = Object.freeze({
    standard: Object.freeze(common),
    apple: Object.freeze(appleShortcuts),
});
export function editCommand(id: string): id is EditingCommand { return Object.hasOwn(edits, id); }
export function editorKeyCommand(id: string, key: string): KeyBinding | undefined {
    if (id === "undo" || id === "redo") return historyKey(id);
    if (editCommand(id)) {
        const tab = key === "Tab" && (id === "indent" || id === "outdent");
        return { command: { kind: "language", command: id }, edit: true, text: id === "newline" ? "\n" : tab ? "\t" : "", fallback: id === "newline" };
    }
    if (labels.has(id as TextEditorCommand)) return commandKey(id as ViewCommand | DeletionCommand);
}
