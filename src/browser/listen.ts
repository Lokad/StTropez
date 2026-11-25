type Events = HTMLElementEventMap & DocumentEventMap & WindowEventMap;

/** Register DOM listeners that end together when the owner aborts. */
export function listenUntil(signal: AbortSignal) {
    const defaults = { signal };
    return <K extends string>(target: EventTarget | null | undefined, type: K,
        listener: (event: K extends keyof Events ? Events[K] : Event) => void,
        options?: Omit<AddEventListenerOptions, "signal">) => {
        target?.addEventListener(type, listener as EventListener, options ? { ...options, signal } : defaults);
    };
}

/** Run a cleanup once when its signal aborts. */
export function onAbort(signal: AbortSignal | undefined, cleanup: () => void): void {
    signal?.addEventListener("abort", cleanup, { once: true });
}
