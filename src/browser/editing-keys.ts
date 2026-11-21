import type { EditingCommand } from "../core/language-edits.ts";

export type KeyStroke = Readonly<Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">>;
type KeyCommand = Readonly<{ kind: "history"; direction: "undo" | "redo" }>
    | Readonly<{ kind: "select-all" }>
    | Readonly<{ kind: "horizontal"; key: "ArrowLeft" | "ArrowRight" | "Home" | "End"; extend: boolean; document: boolean }>
    | Readonly<{ kind: "vertical"; direction: -1 | 1; page: boolean; extend: boolean }>
    | Readonly<{ kind: "word"; direction: -1 | 1; deleting: boolean; extend: boolean }>
    | Readonly<{ kind: "delete"; direction: -1 | 1 }>
    | Readonly<{ kind: "language"; command: EditingCommand | Readonly<{ character: string }> }>;
export type KeyBinding = Readonly<{ command: KeyCommand; text: string; edit: boolean; fallback: boolean }>;
type EditingKey = KeyBinding | "escape" | "tab-escape" | "prevent-navigation" | "comment-prefix" | undefined;
const navigationKeys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]);
const bind = (command: KeyCommand, edit = false, text = "", fallback = false): KeyBinding => ({ command, edit, text, fallback });

/** Shared interpretation for immediate execution and captured queued intent; no view/lifecycle authority. */
export function classifyEditingKey(event: KeyStroke, apple: boolean, escaped: boolean, paired: (key: string) => boolean, commentChord = false): EditingKey {
    const command = (event.ctrlKey || event.metaKey) && !event.altKey, key = event.key.toLowerCase(), extend = event.shiftKey;
    const horizontal = (key: "ArrowLeft" | "ArrowRight" | "Home" | "End", document = false) => bind({ kind: "horizontal", key, extend, document });
    if (command && !extend && commentChord && (key === "c" || key === "u"))
        return bind({ kind: "language", command: key === "c" ? "add-line-comment" : "remove-line-comment" }, true);
    if (command && !extend && key === "k") return "comment-prefix";
    if (command && extend && key === "k") return bind({ kind: "language", command: "delete-lines" }, true);
    if (command && event.key === "Enter") return bind({ kind: "language", command: extend ? "insert-line-above" : "insert-line-below" }, true);
    if (command && !extend && (key === "]" || key === "[")) return bind({ kind: "language", command: key === "]" ? "indent-lines" : "outdent" }, true);
    if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        const up = event.key === "ArrowUp";
        return bind({ kind: "language", command: extend ? (up ? "copy-line-up" : "copy-line-down") : (up ? "move-line-up" : "move-line-down") }, true);
    }
    if (command && (key === "z" || event.ctrlKey && key === "y")) return bind({ kind: "history", direction: extend || key === "y" ? "redo" : "undo" }, true);
    if (command && key === "a") return bind({ kind: "select-all" });
    if (command && (event.key === "Home" || event.key === "End")) return horizontal(event.key, true);
    if (apple && event.metaKey && !event.ctrlKey && !event.altKey) {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") return horizontal(event.key === "ArrowLeft" ? "Home" : "End");
        if (event.key === "ArrowUp" || event.key === "ArrowDown") return horizontal(event.key === "ArrowUp" ? "Home" : "End", true);
    }
    if (event.key === "Escape") return "escape";
    if (event.key === "Tab" && escaped) return "tab-escape";
    const word = !event.metaKey && (event.ctrlKey && !event.altKey || apple && event.altKey && !event.ctrlKey);
    if (word && ["ArrowLeft", "ArrowRight", "Backspace", "Delete"].includes(event.key)) {
        const deleting = event.key === "Backspace" || event.key === "Delete";
        return bind({ kind: "word", direction: event.key === "ArrowLeft" || event.key === "Backspace" ? -1 : 1, deleting, extend }, deleting);
    }
    if (!command && !event.altKey) {
        switch (event.key) {
            case "ArrowLeft": case "ArrowRight": case "Home": case "End": return horizontal(event.key);
            case "ArrowUp": case "ArrowDown": case "PageUp": case "PageDown":
                return bind({ kind: "vertical", direction: event.key === "ArrowUp" || event.key === "PageUp" ? -1 : 1, page: event.key.startsWith("Page"), extend });
            case "Backspace": case "Delete": return bind({ kind: "delete", direction: event.key === "Backspace" ? -1 : 1 }, true);
            case "Tab": return bind({ kind: "language", command: extend ? "outdent" : "indent" }, true, "\t");
            case "Enter": return bind({ kind: "language", command: "newline" }, true, "\n", true);
        }
        if (paired(event.key)) return bind({ kind: "language", command: { character: event.key } }, true, event.key, true);
    }
    if (command && key === "/") return bind({ kind: "language", command: "line-comment" }, true);
    if (!event.ctrlKey && !event.metaKey && extend && event.altKey && key === "a") return bind({ kind: "language", command: "block-comment" }, true);
    if (command && navigationKeys.has(event.key)) return "prevent-navigation";
    return;
}
