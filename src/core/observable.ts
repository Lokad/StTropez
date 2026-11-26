/** Queue work from the active listener for after the synchronous command and its notifications. */
export type AfterDelivery = (work: () => void) => void;
export type ObservableListener = (afterDelivery: AfterDelivery) => void;
export type Observable<T> = Readonly<{ getSnapshot: () => T; subscribe: (listener: ObservableListener) => () => void }>;
type Registration = { active: boolean };
type Deliveries = Map<ObservableListener, { scope: NotificationScope; registrations: Registration[] }>;
// Browsers and headless hosts both provide a console without importing platform types.
declare const console: { error: (error: unknown) => void };
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
    readonly #delivery: { depth: number; batches: number; pending: Deliveries; following: (() => void)[]; draining: boolean; activeChain: FollowUpChain | undefined };
    #subscriptions = 0;
    readonly #onListenerError: (error: unknown) => void;
    constructor(onListenerError?: (error: unknown) => void, parent?: NotificationScope) {
        this.#onListenerError = onListenerError ?? (parent && parent.#onListenerError) ?? (error => console.error(error));
        this.#delivery = (parent && parent.#delivery) ?? { depth: 0, batches: 0, pending: new Map(), following: [], draining: false, activeChain: undefined };
    }
    assertWritable(): void {
        if (this.#delivery.depth) throw new Error("Reentrant mutation during a read-only callback.");
    }
    read<T>(action: () => T): T {
        this.#delivery.depth++;
        try { return action(); } finally { this.#delivery.depth--; }
    }
    subscriptionChanged(delta: number): void { this.#subscriptions += delta; }
    subscriptionCount(): number { return this.#subscriptions; }
    static #queueFollowUp(scope: NotificationScope, work: () => void): void {
        const state = scope.#delivery, chain = state.activeChain ?? { scheduled: 0, reported: false };
        if (chain.scheduled === maxFollowUpsPerChain) {
            if (!chain.reported) {
                chain.reported = true;
                reportError(scope.#onListenerError, new RangeError(`Notification follow-up chain exceeded ${maxFollowUpsPerChain} callbacks.`));
            }
            return;
        }
        chain.scheduled++;
        state.following.push(() => {
            state.activeChain = chain;
            deliver(work, scope.#onListenerError);
        });
        if (state.draining) return;
        state.draining = true;
        // Also leave the initiating command time to finish its receipt and cleanup.
        void Promise.resolve().then(() => {
            try { for (const next of state.following) next(); }
            finally { state.activeChain = undefined; state.following.length = 0; state.draining = false; }
        });
    }
    /** Defers shared-scope notifications until this synchronous action ends; committed writes are not rolled back. */
    batch<T>(action: () => T): T {
        this.assertWritable(); this.#delivery.batches++;
        try { return action(); }
        finally {
            if (--this.#delivery.batches === 0) {
                const pending = this.#delivery.pending; this.#delivery.pending = new Map();
                this.#notify(pending);
            }
        }
    }
    /** Single-store status publication may nest during delivery; commands own write guards. */
    publish<T>(store: Store<T>, value: T): void {
        const changed = new Set<Store<unknown>>(); store.set(value, changed); this.deliver([...changed]);
    }
    deliver(stores: readonly Store<unknown>[]): void {
        // Capture all callbacks before delivery: subscription changes affect later publications.
        const listeners: Deliveries = this.#delivery.batches ? this.#delivery.pending : new Map();
        for (const store of stores) store.collect(listeners, this);
        if (!this.#delivery.batches) this.#notify(listeners);
    }
    #notify(listeners: Deliveries): void {
        this.#delivery.depth++;
        try {
            for (const [listener, { scope, registrations }] of listeners) {
                let delivering = true;
                try {
                    listener(work => {
                        if (!delivering) throw new Error("A follow-up must be requested by the active listener.");
                        NotificationScope.#queueFollowUp(scope, () => {
                            if (registrations.some(registration => registration.active)) work();
                        });
                    });
                } catch (error) {
                    reportError(scope.#onListenerError, error);
                } finally {
                    delivering = false;
                }
            }
        } finally { this.#delivery.depth--; }
    }
}

/** Internal publication primitive, not a host reactive library. */
export class Store<T> {
    readonly #subscriptions = new Map<Registration, ObservableListener>();
    #changes?: Set<(listeners: Deliveries) => void>;
    #value: T;
    readonly #scope: NotificationScope | undefined;
    readonly observable: Observable<T>;
    constructor(value: T, scope?: NotificationScope) {
        this.#value = value; this.#scope = scope;
        this.observable = Object.freeze({ getSnapshot: () => this.#value, subscribe: (listener: ObservableListener) => {
            // Registrations have independent lifetimes even when they share a callback.
            const subscription = { active: true };
            this.#subscriptions.set(subscription, listener);
            this.#scope?.subscriptionChanged(1);
            return () => {
                subscription.active = false;
                if (this.#subscriptions.delete(subscription)) this.#scope?.subscriptionChanged(-1);
            };
        } });
    }
    clearSnapshotListeners(): void {
        this.#scope?.subscriptionChanged(-this.#subscriptions.size);
        for (const registration of this.#subscriptions.keys()) registration.active = false;
        this.#subscriptions.clear();
    }
    get(): T { return this.#value; }
    set(value: T, changed: Set<Store<unknown>>): void {
        if (Object.is(value, this.#value)) return;
        this.#value = value;
        changed.add(this);
    }
    subscribeChanges(listener: (value: T, afterDelivery: AfterDelivery) => void): () => void {
        const scope = this.#scope;
        if (!scope) throw new Error("Change listeners require a notification scope.");
        const registrations = this.#changes ??= new Set();
        const registration = { active: true };
        const capture = (listeners: Deliveries) => {
            const value = this.#value;
            listeners.set(after => { if (registration.active) listener(value, after); }, { scope, registrations: [registration] });
        };
        registrations.add(capture); scope.subscriptionChanged(1);
        return () => {
            registration.active = false;
            if (registrations.delete(capture)) scope.subscriptionChanged(-1);
        };
    }
    collect(listeners: Deliveries, scope: NotificationScope): void {
        for (const [registration, listener] of this.#subscriptions) {
            const delivery = listeners.get(listener);
            if (!delivery) listeners.set(listener, { scope, registrations: [registration] });
            else if (!delivery.registrations.includes(registration)) delivery.registrations.push(registration);
        }
        // A batch can coalesce snapshot reads but each change keeps its own payload.
        if (this.#changes) for (const capture of this.#changes) capture(listeners);
    }
}
