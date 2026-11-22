const keyLabels = new Map([
    ["code:bracketleft", "["], ["code:bracketright", "]"], ["code:space", "Space"],
    ["arrowup", "↑"], ["arrowdown", "↓"], ["arrowleft", "←"],
]);

export function shortcutHint(keys: readonly string[]): string {
    return keys.map(sequence => sequence.replace(/[^+\s]+/g, key => keyLabels.get(key.toLowerCase()) ?? key)).join(" or ");
}
