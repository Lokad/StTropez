/** Read compatibility only; commands remain explicit and synchronous. */
export type Observable<T> = Readonly<{ getSnapshot: () => T; subscribe: (listener: () => void) => () => void }>;
type Deliveries = Map<() => void, (error: unknown) => void>;
export type AfterDelivery = (work: () => void) => void;
// Browsers and headless hosts both provide a console without importing platform types.
declare const console: { error: (error: unknown) => void };
const queueFollowUp = Symbol("subscription follow-up");
const maxFollowUpsPerChain = 256;
type FollowUpChain = { scheduled: number; reported: boolean };

function reportError(report: (error: unknown) => void, error: unknown): void {
    try { report(error); } catch { /* Error reporters cannot interrupt delivery. */ }
}
function deliver(work: () => void, report: (error: unknown) => void): void {
    try { work(); } catch (error) { reportError(report, error); }
}

/** All stores publish before delivery. Each callback runs once per publication; reentrant writes are rejected. */
export class NotificationScope {
    private readonly delivery: { depth: number; batches: number; pending: Deliveries; following: (() => void)[]; draining: boolean; activeChain: FollowUpChain | undefined };
    private subscriptions = 0;
    private readonly onListenerError: (error: unknown) => void;
    constructor(onListenerError?: (error: unknown) => void, parent?: NotificationScope) {
        this.onListenerError = onListenerError ?? parent?.onListenerError ?? (error => console.error(error));
        this.delivery = parent?.delivery ?? { depth: 0, batches: 0, pending: new Map(), following: [], draining: false, activeChain: undefined };
    }
    assertWritable(): void {
        if (this.delivery.depth) throw new Error("Reentrant mutation during a read-only callback.");
    }
    read<T>(action: () => T): T {
        this.delivery.depth++;
        try { return action(); } finally { this.delivery.depth--; }
    }
    subscriptionChanged(delta: number): void { this.subscriptions += delta; }
    subscriptionCount(): number { return this.subscriptions; }
    [queueFollowUp](work: () => void): void {
        const state = this.delivery, chain = state.activeChain ?? { scheduled: 0, reported: false };
        if (chain.scheduled === maxFollowUpsPerChain) {
            if (!chain.reported) {
                chain.reported = true;
                reportError(this.onListenerError, new RangeError(`Document change follow-up chain exceeded ${maxFollowUpsPerChain} callbacks.`));
            }
            return;
        }
        chain.scheduled++;
        state.following.push(() => {
            state.activeChain = chain;
            deliver(work, this.onListenerError);
        });
    }
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
    /** Single-store status publication may nest during delivery; commands own write guards. */
    publish<T>(store: Store<T>, value: T): void {
        const changed = new Set<Store<unknown>>(); store.set(value, changed); this.deliver([...changed]);
    }
    deliver(stores: readonly Store<unknown>[]): void {
        // Capture all callbacks before delivery: subscription changes affect later publications.
        const listeners: Deliveries = this.delivery.batches ? this.delivery.pending : new Map();
        for (const store of stores) store.collect(listeners, this.onListenerError);
        if (!this.delivery.batches) this.notify(listeners);
    }
    private notify(listeners: Deliveries): void {
        this.delivery.depth++;
        try {
            for (const [listener, report] of listeners) deliver(listener, report);
        } finally { this.delivery.depth--; }
        const state = this.delivery;
        if (state.depth || state.draining || !state.following.length) return;
        state.draining = true;
        // Finish the initiating command, including its receipt and view cleanup, before
        // a follow-up can edit the same resource or dispose the initiating attachment.
        void Promise.resolve().then(() => {
            try { for (const work of state.following) work(); }
            finally { state.activeChain = undefined; state.following.length = 0; state.draining = false; }
        });
    }
}

/** Internal publication primitive, not a host reactive library. */
export class Store<T> {
    private readonly subscriptions = new Map<object, () => void>();
    private changes?: Set<() => () => void>;
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
    clearSnapshotListeners(): void {
        this.scope?.subscriptionChanged(-this.subscriptions.size);
        this.subscriptions.clear();
    }
    get(): T { return this.value; }
    set(value: T, changed: Set<Store<unknown>>): void {
        if (Object.is(value, this.value)) return;
        this.value = value;
        changed.add(this);
    }
    subscribeChanges(listener: (value: T, afterDelivery: AfterDelivery) => void): () => void {
        const scope = this.scope;
        if (!scope) throw new Error("Change listeners require a notification scope.");
        const registrations = this.changes ??= new Set();
        const capture = () => {
            const value = this.value;
            return () => {
                if (!registrations.has(capture)) return;
                let delivering = true;
                try { listener(value, work => {
                    if (!delivering) throw new Error("A follow-up must be requested by the active listener.");
                    scope[queueFollowUp](() => { if (registrations.has(capture)) work(); });
                }); } finally { delivering = false; }
            };
        };
        registrations.add(capture); scope.subscriptionChanged(1);
        return () => { if (registrations.delete(capture)) scope.subscriptionChanged(-1); };
    }
    collect(listeners: Deliveries, report: (error: unknown) => void): void {
        for (const listener of this.subscriptions.values()) if (!listeners.has(listener)) listeners.set(listener, report);
        // A batch can coalesce snapshot reads but each change keeps its own payload.
        if (this.changes) for (const capture of this.changes) listeners.set(capture(), report);
    }
}
