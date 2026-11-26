import type { Observable, ObservableListener } from "../../src/index.ts";

/** Development host's stand-in for its own cell scheduler, never exported by the package. */
export class HostCell<T> {
    private value: T;
    private queue: Promise<void> = Promise.resolve();
    private readonly listeners = new Set<() => void>();
    readonly observable: Observable<T>;
    constructor(initial: T) {
        this.value = freezeHost(initial);
        this.observable = Object.freeze({
            getSnapshot: () => this.value,
            subscribe: (listener: ObservableListener) => {
                const subscription = () =>
                    listener((work) =>
                        queueMicrotask(() => {
                            if (this.listeners.has(subscription)) work();
                        })
                    );
                this.listeners.add(subscription);
                return () => {
                    this.listeners.delete(subscription);
                };
            }
        });
    }
    set(next: T): void {
        this.value = freezeHost(next);
        for (const listener of [...this.listeners]) listener();
    }
    get(): T {
        return this.value;
    }
    enqueue(next: T): Promise<void> {
        this.queue = this.queue.then(() => {
            this.set(next);
        });
        return this.queue;
    }
    count(): number {
        return this.listeners.size;
    }
}
function freezeHost<T>(value: T): T {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        Object.values(value).forEach(freezeHost);
        Object.freeze(value);
    }
    return value;
}
