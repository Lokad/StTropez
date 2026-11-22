export function isPrimaryShortcut(event: KeyboardEvent): boolean {
    return event.cancelable && !event.defaultPrevented && !event.isComposing && event.keyCode !== 229
        && !event.getModifierState("AltGraph") && event.ctrlKey !== event.metaKey && !event.altKey;
}

export function isSaveKey(event: KeyboardEvent): boolean {
    return isPrimaryShortcut(event) && !event.shiftKey && event.key.toLowerCase() === "s";
}
