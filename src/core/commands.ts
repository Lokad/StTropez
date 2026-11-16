import type { ResourceHandle, ResourceId, ResourceKey, ResourceTarget, SaveReceipt, SaveReview, SaveSubmission, Workspace } from "./workspace.ts";
import { snapshotValue } from "./values.ts";
import type { Immutable, SnapshotValue } from "./values.ts";
import type { AcknowledgementSubmission } from "./agent.ts";

export type SaveResponse<T> = Readonly<{ kind: "saved"; serverVersion: string; canonical?: T } | { kind: "conflict"; serverVersion: string }>;
export type SavePort<T> = Readonly<{ save: (submission: SaveSubmission<T>) => Promise<SaveResponse<T>> }>;
export type SaveOutcome<T> = Readonly<{ kind: "saved"; receipt: SaveReceipt<T> } | { kind: "conflict"; serverVersion: string } | { kind: "failed" }>;
export type CapturedResource<T> = Readonly<{ target: ResourceTarget; key: ResourceKey; revision: number; value: Immutable<T>; serverVersion: string | null }>;
export type RunSubmission<S, C, P> = Readonly<{ source: CapturedResource<S>; configuration: CapturedResource<C>; settings: Immutable<P> }>;
export type RunPort<S, C, P, R> = Readonly<{ run: (submission: RunSubmission<S, C, P>) => Promise<R> }>;
export type AcknowledgementPort = Readonly<{ acknowledge: (submission: AcknowledgementSubmission) => Promise<void> }>;

/** Host-injected command orchestration. No networking, storage, navigation or execution policy. */
export class WorkspaceCommands {
    private readonly workspace: Workspace;
    private readonly onError: (error: unknown) => void;
    private readonly saves = new Map<ResourceId, Promise<void>>();
    constructor(workspace: Workspace, onError: (error: unknown) => void = () => {}) {
        this.workspace = workspace; this.onError = onError;
    }
    /** Content is captured at invocation, server preconditions at serialized submission. */
    save<T extends SnapshotValue>(resource: ResourceHandle<T>, port: SavePort<T>, review?: SaveReview): Promise<SaveOutcome<T>> {
        const ticket = this.workspace.captureSave(resource, review);
        const previous = this.saves.get(resource.id) ?? Promise.resolve();
        const result = previous.then(async (): Promise<SaveOutcome<T>> => {
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
        this.saves.set(resource.id, tail);
        void tail.then(() => { if (this.saves.get(resource.id) === tail) this.saves.delete(resource.id); });
        return result;
    }
    async acknowledge(resourceId: ResourceId, acknowledgementId: string, port: AcknowledgementPort): Promise<Readonly<{ kind: "acknowledged"; retired: boolean } | { kind: "failed" }>> {
        const ticket = this.workspace.beginAcknowledgement(resourceId, acknowledgementId);
        try {
            await port.acknowledge(ticket.submission);
            const result = ticket.accept();
            return result.accepted ? { kind: "acknowledged", retired: result.retired } : { kind: "failed" };
        } catch (error) {
            ticket.fail(); try { this.onError(error); } catch { /* Receipt remains independently retryable. */ }
            return { kind: "failed" };
        } finally { ticket.finish(); }
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
