import type { ResourceId, SaveReceipt, SaveSubmission, SaveTicket, SnapshotValue, Workspace } from "../../src/index.ts";

export type SaveResponse<T> = Readonly<{ kind: "saved"; serverVersion: string; canonical?: T } | { kind: "conflict"; serverVersion: string }>;
export type SavePort<T, S extends SaveSubmission<T> = SaveSubmission<T>> = Readonly<{ save: (submission: S) => Promise<SaveResponse<T>> }>;
export type SaveOutcome<T, R extends SaveReceipt<T> = SaveReceipt<T>> = Readonly<{ kind: "saved"; receipt: R } | { kind: "conflict"; serverVersion: string } | { kind: "failed" }>;

/** The host serializes writes per resource while the workspace owns each captured ticket. */
export class HostSaveQueue {
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
                    ticket.conflict(); return { kind: "conflict", serverVersion: response.serverVersion };
                }
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
}
