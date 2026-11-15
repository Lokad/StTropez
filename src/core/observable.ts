/** Read compatibility only; commands remain explicit and synchronous. */
export type Observable<T> = Readonly<{ getSnapshot: () => T; subscribe: (listener: () => void) => () => void }>;

/** All stores publish before delivery. Each callback runs once per publication; reentrant writes are rejected. */
export class NotificationScope {
    private readonly delivery: { depth: number };
    private subscriptions = 0;
    private readonly onListenerError: (error: unknown) => void;
    constructor(onListenerError: (error: unknown) => void, parent?: NotificationScope) {
        this.onListenerError = onListenerError; this.delivery = parent?.delivery ?? { depth: 0 };
    }
    assertWritable(): void {
        if (this.delivery.depth) throw new Error("Reentrant mutation during notification; queue the command in the host.");
    }
    subscriptionChanged(delta: number): void { this.subscriptions += delta; }
    subscriptionCount(): number { return this.subscriptions; }
    deliver(stores: readonly Store<unknown>[]): void {
        // Capture all callbacks before delivery: subscription changes affect later publications.
        const listeners = new Set<() => void>();
        for (const store of stores) for (const listener of store.listeners()) listeners.add(listener);
        this.delivery.depth++;
        try {
            for (const listener of listeners) {
                try { listener(); } catch (error) {
                    try { this.onListenerError(error); } catch { /* Error reporters cannot interrupt delivery. */ }
                }
            }
        } finally { this.delivery.depth--; }
    }
}

/** Internal publication primitive, not a host reactive library. */
export class Store<T> {
    private readonly subscriptions = new Map<object, () => void>();
    private value: T;
    private readonly scope: NotificationScope | undefined;
    readonly observable: Observable<T>;
    constructor(value: T, scope?: NotificationScope) {
        this.value = value; this.scope = scope;
        this.observable = Object.freeze({ getSnapshot: () => this.value, subscribe: (listener: () => void) => {
            // Registrations have independent lifetimes even when they share a callback.
            const subscription = {};
            this.subscriptions.set(subscription, listener);
            this.scope?.subscriptionChanged(1);
            return () => { if (this.subscriptions.delete(subscription)) this.scope?.subscriptionChanged(-1); };
        } });
    }
    get(): T { return this.value; }
    set(value: T, changed: Set<Store<unknown>>): void {
        if (Object.is(value, this.value)) return;
        this.value = value;
        changed.add(this);
    }
    listeners(): Iterable<() => void> { return this.subscriptions.values(); }
}
