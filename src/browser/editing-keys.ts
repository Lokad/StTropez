import type { EditingCommand } from "../core/language-edits.ts";

export type KeyStroke = Readonly<Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">>;
type Boundary = "line-start" | "line-end" | "document-start" | "document-end";
export type CaretDirection = "left" | "right" | "up" | "down" | "page-up" | "page-down";
export type ViewCommand = "select-all" | "select-line" | "jump-to-bracket" | "add-caret-above" | "add-caret-below" | "undo-caret"
    | `move-${CaretDirection}` | `select-${CaretDirection}`
    | `move-to-${Boundary}` | `select-to-${Boundary}`
    | "move-word-backward" | "move-word-forward" | "select-word-backward" | "select-word-forward"
    | "select-next-occurrence" | "select-all-occurrences" | "go-to-line" | "scroll-line-up" | "scroll-line-down" | "scroll-page-up" | "scroll-page-down";
export type DeletionCommand = "delete-backward" | "delete-forward" | "delete-word-backward" | "delete-word-forward";
export function isDeletionCommand(id: string): id is DeletionCommand {
    return id === "delete-backward" || id === "delete-forward" || id === "delete-word-backward" || id === "delete-word-forward";
}
export function nativeDeletion(type: string): DeletionCommand | undefined {
    switch (type) {
        case "deleteContentBackward": return "delete-backward";
        case "deleteContentForward": return "delete-forward";
        case "deleteWordBackward": return "delete-word-backward";
        case "deleteWordForward": return "delete-word-forward";
    }
}
type KeyCommand = Readonly<{ kind: "history"; direction: "undo" | "redo" }>
    | Readonly<{ kind: "command"; command: ViewCommand | DeletionCommand }>
    | Readonly<{ kind: "language"; command: EditingCommand | Readonly<{ character: string }> }>;
export type KeyBinding = Readonly<{ command: KeyCommand; text: string; edit: boolean; fallback: boolean }>;
type EditingKey = KeyBinding | "escape" | "prevent-native" | undefined;
const navigationKeys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]);
const bind = (command: KeyCommand, edit = false, text = "", fallback = false): KeyBinding => ({ command, edit, text, fallback });

export const historyKey = (direction: "undo" | "redo"): KeyBinding => bind({ kind: "history", direction }, true);
export const commandKey = (command: ViewCommand | DeletionCommand): KeyBinding => bind({ kind: "command", command }, isDeletionCommand(command));

/** Shared interpretation for immediate execution and captured queued intent; no view/lifecycle authority. */
export function classifyEditingKey(event: KeyStroke, apple: boolean, paired: (key: string) => boolean): EditingKey {
    const command = (event.ctrlKey || event.metaKey) && !event.altKey;
    if (event.key === "Escape") return "escape";
    const word = !event.metaKey && (event.ctrlKey && !event.altKey || apple && event.altKey && !event.ctrlKey);
    // After unbinding a word shortcut, keep the browser from moving or deleting in the input projection.
    if (word && ["ArrowLeft", "ArrowRight", "Backspace", "Delete"].includes(event.key)) return "prevent-native";
    if (!command && !event.altKey) {
        if (navigationKeys.has(event.key) || ["Enter", "Backspace", "Delete"].includes(event.key)) return "prevent-native";
        if (paired(event.key)) return bind({ kind: "language", command: { character: event.key } }, true, event.key, true);
    }
    if (command && navigationKeys.has(event.key)) return "prevent-native";
    return;
}
