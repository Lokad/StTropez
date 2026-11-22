function available(event: KeyboardEvent): boolean {
    return event.cancelable && !event.defaultPrevented && !event.isComposing && event.keyCode !== 229
        && !event.getModifierState("AltGraph") && !event.altKey;
}

export function isUnmodifiedShortcut(event: KeyboardEvent): boolean {
    return available(event) && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

export function isPrimaryShortcut(event: KeyboardEvent): boolean {
    return available(event) && event.ctrlKey !== event.metaKey;
}

export function isSaveKey(event: KeyboardEvent): boolean {
    return isPrimaryShortcut(event) && !event.shiftKey && event.key.toLowerCase() === "s";
}
