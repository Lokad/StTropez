import type { DocumentId, SaveReceipt, SaveResponse, SaveSubmission, SaveTicket, Workspace } from "../../src/index.ts";

export type SavePort = Readonly<{ save: (submission: SaveSubmission) => Promise<SaveResponse> }>;
export type SaveOutcome = Readonly<{ kind: "saved"; receipt: SaveReceipt } | { kind: "conflict"; serverVersion: string } | { kind: "failed" }>;

/** The host serializes writes per resource while the workspace owns each captured ticket. */
export class HostSaveQueue {
    private readonly workspace: Workspace;
    private readonly onError: (error: unknown) => void;
    private readonly saves = new Map<DocumentId, Promise<void>>();
    constructor(workspace: Workspace, onError: (error: unknown) => void = () => {}) {
        this.workspace = workspace; this.onError = onError;
    }
    /** Execute an explicitly captured ticket; server preconditions are captured at serialized submission. */
    save(ticket: SaveTicket, port: SavePort): Promise<SaveOutcome> {
        if (!this.workspace.resolveResource(ticket.target)) throw new Error("Save ticket belongs to another workspace or a released resource.");
        const previous = this.saves.get(ticket.target.id) ?? Promise.resolve();
        const result = previous.then(async (): Promise<SaveOutcome> => {
            try {
                return await ticket.run(submission => port.save(submission));
            } catch (error) {
                try { this.onError(error); } catch { /* Reporting does not lose ownership or the committed baseline. */ }
                return { kind: "failed" };
            }
        });
        const tail = result.then(() => {});
        this.saves.set(ticket.target.id, tail);
        void tail.then(() => { if (this.saves.get(ticket.target.id) === tail) this.saves.delete(ticket.target.id); });
        return result;
    }
}
