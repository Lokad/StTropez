import type { TextEditor } from "../../src/browser/index.ts";
import type { scopedCommands } from "./editor-attachment.ts";

export function focusResult(list: HTMLElement | null, index: number): void {
    if (!list) return;
    const rows = list.querySelectorAll<HTMLButtonElement>("li > button");
    const target = rows[index];
    (target && !target.disabled ? target : list.querySelector<HTMLButtonElement>("li > button:enabled") ?? list).focus();
}

export function registerResultArrows(register: ReturnType<typeof scopedCommands>, group: string, priority: number, list: () => HTMLElement | null,
    enabled: () => boolean): void {
    for (const [id, label, key, step] of [["previousResult", "Previous result", "ArrowUp", -1], ["nextResult", "Next result", "ArrowDown", 1]] as const) {
        register({ id: group + "." + id, label, enabled, run: () => {
            const root = list(); if (!root) return;
            const rows = [...root.querySelectorAll<HTMLButtonElement>("li > button:enabled")];
            const current = rows.findIndex(row => row === root.ownerDocument.activeElement);
            rows[Math.max(0, Math.min(rows.length - 1, current + step))]?.focus();
        } }, { keys: [key], shared: true, priority });
    }
}

/** Forward shared shortcuts to the panel's current owner, including after a view replacement. */
export function createPanelKeyBinding<T extends HTMLElement>(owner: () => TextEditor | undefined) {
    let element: T | null = null, disposed = false;
    const keydown = (event: KeyboardEvent) => {
        if (owner()?.keymap.handle(event)) event.stopPropagation();
    };
    function bind(next: T | null) {
        if (disposed || next === element) return;
        element?.removeEventListener("keydown", keydown);
        element = next;
        element?.addEventListener("keydown", keydown);
    }
    return {
        get element() { return element; },
        get focused() { return !!element?.matches(":focus-within"); },
        bind, dispose() { bind(null); disposed = true; },
    };
}
