import { usesAppleShortcuts } from "./host-shortcuts.ts";

const keyLabels = new Map([
    ["code:bracketleft", "["], ["code:bracketright", "]"], ["code:backslash", "\\"], ["code:keya", "A"], ["code:space", "Space"],
    ["arrowup", "↑"], ["arrowdown", "↓"], ["arrowleft", "←"], ["arrowright", "→"],
]);

export function shortcutHint(keys: readonly string[], apple = usesAppleShortcuts()): string {
    return keys.map(sequence => sequence.replace(/[^+\s]+/g, key => {
        if (key.toLowerCase() === "mod") return apple ? "Cmd" : "Ctrl";
        if (apple && key.toLowerCase() === "meta") return "Cmd";
        return keyLabels.get(key.toLowerCase()) ?? (key.length === 1 ? key.toUpperCase() : key);
    })).join(" or ");
}
