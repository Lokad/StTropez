/** Read compatibility only; commands remain explicit and synchronous. */
export type Observable<T> = Readonly<{ getSnapshot: () => T; subscribe: (listener: () => void) => () => void }>;
type Deliveries = Map<() => void, (error: unknown) => void>;

/** All stores publish before delivery. Each callback runs once per publication; reentrant writes are rejected. */
export class NotificationScope {
    private readonly delivery: { depth: number; batches: number; pending: Deliveries };
    private subscriptions = 0;
    private readonly onListenerError: (error: unknown) => void;
    constructor(onListenerError: (error: unknown) => void, parent?: NotificationScope) {
        this.onListenerError = onListenerError; this.delivery = parent?.delivery ?? { depth: 0, batches: 0, pending: new Map() };
    }
    assertWritable(): void {
        if (this.delivery.depth) throw new Error("Reentrant mutation during notification; queue the command in the host.");
    }
    subscriptionChanged(delta: number): void { this.subscriptions += delta; }
    subscriptionCount(): number { return this.subscriptions; }
    /** Defers shared-scope notifications until this synchronous action ends; committed writes are not rolled back. */
    batch<T>(action: () => T): T {
        this.assertWritable(); this.delivery.batches++;
        try { return action(); }
        finally {
            if (--this.delivery.batches === 0) {
                const pending = this.delivery.pending; this.delivery.pending = new Map();
                this.notify(pending);
            }
        }
    }
    deliver(stores: readonly Store<unknown>[]): void {
        // Capture all callbacks before delivery: subscription changes affect later publications.
        const listeners: Deliveries = this.delivery.batches ? this.delivery.pending : new Map();
        for (const store of stores) for (const listener of store.listeners()) {
            if (!listeners.has(listener)) listeners.set(listener, this.onListenerError);
        }
        if (!this.delivery.batches) this.notify(listeners);
    }
    private notify(listeners: Deliveries): void {
        this.delivery.depth++;
        try {
            for (const [listener, report] of listeners) {
                try { listener(); } catch (error) {
                    try { report(error); } catch { /* Error reporters cannot interrupt delivery. */ }
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
