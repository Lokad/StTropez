import type { ResourceHandle, ResourceId, ResourceKey, ResourceTarget, SaveReceipt, SaveSubmission, SaveTicket, Workspace } from "./workspace.ts";
import { snapshotValue } from "./values.ts";
import type { Immutable, SnapshotValue } from "./values.ts";

export type SaveResponse<T> = Readonly<{ kind: "saved"; serverVersion: string; canonical?: T } | { kind: "conflict"; serverVersion: string }>;
export type SavePort<T, S extends SaveSubmission<T> = SaveSubmission<T>> = Readonly<{ save: (submission: S) => Promise<SaveResponse<T>> }>;
export type SaveOutcome<T, R extends SaveReceipt<T> = SaveReceipt<T>> = Readonly<{ kind: "saved"; receipt: R } | { kind: "conflict"; serverVersion: string } | { kind: "failed" }>;
export type CapturedResource<T> = Readonly<{ target: ResourceTarget; key: ResourceKey; revision: number; value: Immutable<T>; serverVersion: string | null }>;
export type RunSubmission<S, C, P> = Readonly<{ source: CapturedResource<S>; configuration: CapturedResource<C>; settings: Immutable<P> }>;
export type RunPort<S, C, P, R> = Readonly<{ run: (submission: RunSubmission<S, C, P>) => Promise<R> }>;

/** Host-injected command orchestration. No networking, storage, navigation or execution policy. */
export class WorkspaceCommands {
    private readonly workspace: Workspace;
    private readonly onError: (error: unknown) => void;
    private readonly saves = new Map<ResourceId, Promise<void>>();
    constructor(workspace: Workspace, onError: (error: unknown) => void = () => {}) {
        this.workspace = workspace; this.onError = onError;
    }
    /** Execute an explicitly captured ticket; server preconditions are captured at serialized submission. */
    save<T extends SnapshotValue, S extends SaveSubmission<T>, R extends SaveReceipt<T>>(ticket: SaveTicket<T, S, R>, port: SavePort<T, S>): Promise<SaveOutcome<T, R>> {
        if (!this.workspace.resolveResource(ticket.target)) throw new Error("Save ticket belongs to another workspace or a released resource.");
        const previous = this.saves.get(ticket.target.id) ?? Promise.resolve();
        const result = previous.then(async (): Promise<SaveOutcome<T, R>> => {
            try {
                const response = await port.save(ticket.start());
                if (response.kind === "conflict") {
                    if (typeof response.serverVersion !== "string") throw new TypeError("Conflict requires a server version.");
                    ticket.conflict(); return { kind: "conflict", serverVersion: response.serverVersion };
                }
                if (response.kind !== "saved") throw new TypeError("Unknown save response.");
                return { kind: "saved", receipt: ticket.accept(response) };
            } catch (error) {
                ticket.fail();
                try { this.onError(error); } catch { /* Reporting does not lose ownership or the committed baseline. */ }
                return { kind: "failed" };
            } finally { ticket.finish(); }
        });
        const tail = result.then(() => {});
        this.saves.set(ticket.target.id, tail);
        void tail.then(() => { if (this.saves.get(ticket.target.id) === tail) this.saves.delete(ticket.target.id); });
        return result;
    }
    /** Host chooses save-before-run policy. Running itself captures immutable inputs and never saves. */
    async run<S extends SnapshotValue, C extends SnapshotValue, P extends SnapshotValue, R>(
        source: ResourceHandle<S>, configuration: ResourceHandle<C>, settings: P, port: RunPort<S, C, P, R>): Promise<R> {
        const capture = <T extends SnapshotValue>(handle: ResourceHandle<T>): CapturedResource<T> => {
            // Validate workspace association, not only the local ID.
            if (this.workspace.resource(handle.id) !== handle) throw new Error("Run resource belongs to another workspace.");
            const state = handle.getSnapshot();
            if (state.state !== "ready" || !state.metadata.capabilities.run) throw new Error("Resource is not ready or cannot run.");
            return Object.freeze({ target: this.workspace.captureResource(handle.id), key: state.metadata.key,
                revision: state.revision, value: state.value(), serverVersion: state.metadata.serverVersion });
        };
        const submission = Object.freeze({ source: capture(source), configuration: capture(configuration), settings: snapshotValue(settings) });
        const leases = [this.workspace.acquire(source.id), this.workspace.acquire(configuration.id)];
        try { return await port.run(submission); }
        catch (error) { try { this.onError(error); } catch { /* Preserve command failure. */ } throw error; }
        finally { leases.forEach(lease => lease.release()); }
    }
}
