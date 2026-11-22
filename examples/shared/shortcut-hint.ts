const keyLabels = new Map([
    ["code:bracketleft", "["], ["code:bracketright", "]"], ["arrowup", "↑"], ["arrowdown", "↓"],
]);

export function shortcutHint(keys: readonly string[]): string {
    return keys.map(sequence => sequence.replace(/[^+\s]+/g, key => keyLabels.get(key.toLowerCase()) ?? key)).join(" / ");
}
