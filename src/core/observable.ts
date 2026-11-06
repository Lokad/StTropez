/** Read compatibility only; commands remain explicit and synchronous. */
export type Observable<T> = Readonly<{ getSnapshot: () => T; subscribe: (listener: () => void) => () => void }>;

/** All stores publish before delivery. Reentrant writes are rejected, so a delivery sees one commit. */
export class NotificationScope {
    private delivering = false;
    private subscriptions = 0;
    private readonly onListenerError: (error: unknown) => void;
    constructor(onListenerError: (error: unknown) => void) { this.onListenerError = onListenerError; }
    assertWritable(): void {
        if (this.delivering) throw new Error("Reentrant mutation during notification; queue the command in the host.");
    }
    subscriptionChanged(delta: number): void { this.subscriptions += delta; }
    subscriptionCount(): number { return this.subscriptions; }
    deliver(stores: readonly Store<unknown>[]): void {
        const listeners = stores.flatMap(store => store.listeners());
        this.delivering = true;
        try {
            for (const listener of listeners) {
                try { listener(); } catch (error) {
                    try { this.onListenerError(error); } catch { /* Error reporters cannot interrupt delivery. */ }
                }
            }
        } finally { this.delivering = false; }
    }
}

/** Internal publication primitive, not a host reactive library. */
export class Store<T> {
    private readonly subscriptions = new Set<() => void>();
    private value: T;
    private readonly scope: NotificationScope | undefined;
    readonly observable: Observable<T>;
    constructor(value: T, scope?: NotificationScope) {
        this.value = value; this.scope = scope;
        this.observable = Object.freeze({ getSnapshot: () => this.value, subscribe: (listener: () => void) => {
            const subscription = () => listener();
            this.subscriptions.add(subscription);
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
    listeners(): readonly (() => void)[] { return [...this.subscriptions]; }
}
