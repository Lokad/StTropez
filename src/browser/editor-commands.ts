import type { EditingCommand } from "../core/language-edits.ts";
import { commandKey, historyKey, type CaretDirection, type KeyBinding, type ViewCommand, type DeletionCommand } from "./editing-keys.ts";
import type { TextEditorCommand } from "./text-editor.ts";

type Shortcut = readonly [keys: string, command: TextEditorCommand];
type Definition = readonly [label: string, ...keys: string[]];
type Movement = CaretDirection | `word-${"backward" | "forward"}` | `to-${"line" | "document"}-${"start" | "end"}`;
const edits = {
    "move-line-up": ["Move line up", "Alt+ArrowUp"],
    "move-line-down": ["Move line down", "Alt+ArrowDown"],
    "copy-line-up": ["Copy line up", "Alt+Shift+ArrowUp"],
    "copy-line-down": ["Copy line down", "Alt+Shift+ArrowDown"],
    "insert-line-above": ["Insert line above", "Mod+Shift+Enter"],
    "insert-line-below": ["Insert line below", "Mod+Enter"],
    "delete-lines": ["Delete lines", "Mod+Shift+k"],
    "indent": ["Indent", "Tab"],
    "indent-lines": ["Indent lines", "Mod+]"],
    "outdent": ["Outdent", "Shift+Tab", "Mod+["],
    "line-comment": ["Toggle line comment", "Mod+/"],
    "add-line-comment": ["Add line comment", "Mod+k Mod+c"],
    "remove-line-comment": ["Remove line comment", "Mod+k Mod+u"],
    "block-comment": ["Toggle block comment", "Alt+Shift+a"],
    "newline": ["Newline", "Enter", "Shift+Enter"],
} satisfies Record<EditingCommand, Definition>;

const definitions = {
    ...edits,
    "select-all": ["Select all", "Mod+a"],
    "go-to-line": ["Go to line", "Mod+g"],
    "select-line": ["Select line", "Mod+l"],
    "jump-to-bracket": ["Go to matching bracket", "Mod+Shift+\\"],
    "add-caret-above": ["Add caret above", "Mod+Alt+ArrowUp"],
    "add-caret-below": ["Add caret below", "Mod+Alt+ArrowDown"],
    "undo-caret": ["Undo caret change", "Mod+u"],
    "select-next-occurrence": ["Select next occurrence", "Mod+d"],
    "select-all-occurrences": ["Select all occurrences", "Mod+Shift+l"],
    "scroll-line-up": ["Scroll line up", "Ctrl+ArrowUp"],
    "scroll-line-down": ["Scroll line down", "Ctrl+ArrowDown"],
    "scroll-page-up": ["Scroll page up", "Alt+PageUp"],
    "scroll-page-down": ["Scroll page down", "Alt+PageDown"],
    "delete-word-backward": ["Delete previous word"],
    "delete-word-forward": ["Delete next word"],
    "delete-backward": ["Delete backward", "Backspace", "Shift+Backspace"],
    "delete-forward": ["Delete forward", "Delete"],
    "undo": ["Undo", "Mod+z"],
    "redo": ["Redo", "Mod+Shift+z", "Ctrl+y"],
} satisfies Record<Exclude<TextEditorCommand, `move-${Movement}` | `select-${Movement}`>, Definition>;

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

const labels = new Map<TextEditorCommand, string>();
const common: Shortcut[] = [];
const apple: Shortcut[] = [["Alt+Shift+Code:KeyA", "block-comment"]];
for (const id of Object.keys(definitions) as (keyof typeof definitions)[]) {
    const [label, ...keys] = definitions[id];
    labels.set(id, label);
    for (const key of keys) common.push([key, id]);
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
const standard = Object.freeze(common.map(row => Object.freeze(row)));
/** Complete base-editor bindings. Feature controllers register their own shortcuts on attachment. */
export const defaultEditorShortcuts = Object.freeze({
    standard,
    apple: Object.freeze([...standard, ...apple.map(row => Object.freeze(row))]),
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
