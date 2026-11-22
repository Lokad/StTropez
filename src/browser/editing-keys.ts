import type { EditingCommand } from "../core/language-edits.ts";

export type KeyStroke = Readonly<Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">>;
type Boundary = "line-start" | "line-end" | "document-start" | "document-end";
export type ViewCommand = "select-all" | "select-line" | "jump-to-bracket" | "add-caret-above" | "add-caret-below" | "undo-caret"
    | `move-to-${Boundary}` | `select-to-${Boundary}`
    | "select-next-occurrence" | "select-all-occurrences" | "go-to-line" | "scroll-line-up" | "scroll-line-down" | "scroll-page-up" | "scroll-page-down";
type KeyCommand = Readonly<{ kind: "history"; direction: "undo" | "redo" }>
    | Readonly<{ kind: "view"; command: ViewCommand }>
    | Readonly<{ kind: "horizontal"; key: "ArrowLeft" | "ArrowRight"; extend: boolean }>
    | Readonly<{ kind: "vertical"; direction: -1 | 1; page: boolean; extend: boolean }>
    | Readonly<{ kind: "word"; direction: -1 | 1; deleting: boolean; extend: boolean }>
    | Readonly<{ kind: "delete"; direction: -1 | 1 }>
    | Readonly<{ kind: "language"; command: EditingCommand | Readonly<{ character: string }> }>;
export type KeyBinding = Readonly<{ command: KeyCommand; text: string; edit: boolean; fallback: boolean }>;
type EditingKey = KeyBinding | "escape" | "tab-escape" | "prevent-navigation" | undefined;
const navigationKeys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]);
const bind = (command: KeyCommand, edit = false, text = "", fallback = false): KeyBinding => ({ command, edit, text, fallback });

export const historyKey = (direction: "undo" | "redo"): KeyBinding => bind({ kind: "history", direction }, true);

/** Shared interpretation for immediate execution and captured queued intent; no view/lifecycle authority. */
export function classifyEditingKey(event: KeyStroke, apple: boolean, escaped: boolean, paired: (key: string) => boolean): EditingKey {
    const command = (event.ctrlKey || event.metaKey) && !event.altKey, extend = event.shiftKey;
    if (event.key === "Escape") return "escape";
    if (event.key === "Tab" && escaped) return "tab-escape";
    const word = !event.metaKey && (event.ctrlKey && !event.altKey || apple && event.altKey && !event.ctrlKey);
    if (word && ["ArrowLeft", "ArrowRight", "Backspace", "Delete"].includes(event.key)) {
        const deleting = event.key === "Backspace" || event.key === "Delete";
        return bind({ kind: "word", direction: event.key === "ArrowLeft" || event.key === "Backspace" ? -1 : 1, deleting, extend }, deleting);
    }
    if (!command && !event.altKey) {
        switch (event.key) {
            case "ArrowLeft": case "ArrowRight": return bind({ kind: "horizontal", key: event.key, extend });
            case "ArrowUp": case "ArrowDown": case "PageUp": case "PageDown":
                return bind({ kind: "vertical", direction: event.key === "ArrowUp" || event.key === "PageUp" ? -1 : 1, page: event.key.startsWith("Page"), extend });
            case "Backspace": case "Delete": return bind({ kind: "delete", direction: event.key === "Backspace" ? -1 : 1 }, true);
            case "Tab": return bind({ kind: "language", command: extend ? "outdent" : "indent" }, true, "\t");
            case "Enter": return bind({ kind: "language", command: "newline" }, true, "\n", true);
        }
        if (paired(event.key)) return bind({ kind: "language", command: { character: event.key } }, true, event.key, true);
    }
    if (command && navigationKeys.has(event.key)) return "prevent-navigation";
    return;
}
