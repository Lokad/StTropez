import { CleanupScope } from "../../../examples/shared/cleanup-scope.ts";
import type { HostController } from "./controller.ts";
import type { ViewBindings } from "./bindings.ts";

type HostOwners = Readonly<{ controller: Pick<HostController, "startBackground" | "recover" | "dispose">;
    bindings: Pick<ViewBindings, "dispose">;
    mount: () => void; unmount: () => void; reportError?: (error: unknown) => void }>;

/** Host startup, recovery and final ownership. Fixture installation never starts the application. */
export class HostLifecycle {
    private readonly owners: HostOwners;
    private readonly page: EventTarget;
    private readonly recoveryButton: EventTarget;
    private readonly events = new AbortController();
    private readonly fixtures = new CleanupScope();
    private readonly cleanup = new CleanupScope();
    private readonly pending: Promise<unknown>[] = [];
    private started = false;
    private stopped = false;
    private disposal: Promise<void> | undefined;
    constructor(page: EventTarget, recoveryButton: EventTarget, owners: HostOwners) {
        this.page = page; this.recoveryButton = recoveryButton; this.owners = owners;
        // Start cleanup in reverse order: listeners, views, bindings, resources, commands.
        this.cleanup.defer(() => { this.pending.push(owners.controller.dispose()); });
        this.cleanup.defer(this.fixtures.dispose);
        this.cleanup.defer(() => owners.bindings.dispose());
        this.cleanup.defer(() => owners.unmount());
        this.cleanup.defer(() => this.events.abort());
    }
    get disposed(): boolean { return this.stopped; }
    private reportError(error: unknown): void {
        if (this.owners.reportError) this.owners.reportError(error); else console.error(error);
    }
    /** Start after view bindings; final disposal also waits for deferred resource release. */
    onDispose(cleanup: () => void | Promise<void>): void {
        if (this.stopped) throw new Error("Host is disposed.");
        this.fixtures.defer(() => { const pending = cleanup(); if (pending) this.pending.push(pending); });
    }
    start(): void {
        if (this.stopped) throw new Error("Host is disposed.");
        if (this.started) return; this.started = true;
        try {
            this.recoveryButton.addEventListener("click", this.recover, { signal: this.events.signal });
            // A cached page can return. Keep both its state and this listener for a later final hide.
            this.page.addEventListener("pagehide", event => {
                if (!(event as PageTransitionEvent).persisted) void this.dispose().catch(error => this.reportError(error));
            }, { signal: this.events.signal });
            this.owners.controller.startBackground(); this.mount();
        } catch (error) {
            void this.dispose().catch(cleanupError => this.reportError(new AggregateError([error, cleanupError], "Host startup and cleanup failed.")));
            throw error;
        }
    }
    readonly mount = (): void => {
        if (!this.started || this.stopped) throw new Error("Host is not active.");
        this.owners.mount();
    };
    readonly unmount = (): void => { if (!this.stopped) this.owners.unmount(); };
    readonly recover = (): void => {
        if (!this.started || this.stopped) throw new Error("Host is not active.");
        this.owners.controller.recover(); this.mount();
    };
    readonly dispose = (): Promise<void> => {
        if (this.disposal) return this.disposal; this.stopped = true;
        let resolve!: () => void, reject!: (error: unknown) => void;
        // Publish completion before synchronous cleanup, so reentrant disposal observes the same task.
        this.disposal = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
        const errors: unknown[] = [];
        try { this.cleanup.dispose(); } catch (error) { errors.push(error); }
        void Promise.allSettled(this.pending).then(results => {
            for (const result of results) if (result.status === "rejected") errors.push(result.reason);
            if (errors.length === 1) reject(errors[0]);
            else if (errors.length) reject(new AggregateError(errors, "Host cleanup failed."));
            else resolve();
        });
        return this.disposal;
    };
}
