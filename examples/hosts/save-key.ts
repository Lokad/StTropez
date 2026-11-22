/** Keyboard shortcut for host fields that have their own Save target. */
export function isSaveKey(event: KeyboardEvent): boolean {
    return event.cancelable && !event.defaultPrevented && !event.isComposing && event.keyCode !== 229
        && !event.getModifierState("AltGraph") && event.ctrlKey !== event.metaKey && !event.altKey && !event.shiftKey
        && event.key.toLowerCase() === "s";
}
