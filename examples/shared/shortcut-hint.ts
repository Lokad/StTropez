const keyLabels = new Map([
    ["code:bracketleft", "["], ["code:bracketright", "]"], ["code:backslash", "\\"], ["code:keya", "A"], ["code:space", "Space"],
    ["arrowup", "↑"], ["arrowdown", "↓"], ["arrowleft", "←"], ["arrowright", "→"],
]);

export function shortcutHint(keys: readonly string[], apple = /Mac|iPhone|iPad|iPod/.test(navigator.platform)): string {
    const alternate = apple ? /\bCtrl(?=\+)/gi : /\bMeta(?=\+)/gi;
    const preferred = apple ? "Meta" : "Ctrl";
    return keys.filter(sequence => {
        const twin = sequence.replace(alternate, preferred);
        return twin === sequence || !keys.includes(twin);
    }).map(sequence => sequence.replace(/[^+\s]+/g, key => {
        if (apple && key.toLowerCase() === "meta") return "Cmd";
        return keyLabels.get(key.toLowerCase()) ?? (key.length === 1 ? key.toUpperCase() : key);
    })).join(" or ");
}
