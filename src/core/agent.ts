import type { TextEdit } from "./changes.ts";
import type { CapturedResource } from "./commands.ts";
import { snapshotValue } from "./values.ts";
import type { Immutable, SnapshotValue } from "./values.ts";
import { Store } from "./observable.ts";
import type { NotificationScope, Observable } from "./observable.ts";
import type { ChangeResult, EditLease, Operation, ResourceLease, ResourceTarget, SaveReceipt, SaveReview, SaveSubmission, SaveTicket, TextResourceHandle, Workspace } from "./workspace.ts";

export type AgentAssociation = Readonly<{ id: string; generation: number }>;
export type ProposalTarget = Readonly<{ association: AgentAssociation; id: string; revision: number; generation: number }>;
export type ProposalGuard = Readonly<{ target: ResourceTarget; association: AgentAssociation; documentRevision: number; generation: number }>;
export type Proposal = Readonly<{ target: ProposalTarget; baseDocumentRevision: number; documentRevision: number }>;
export type ProposedEdits = Readonly<{ id: string; revision: number; edits: readonly TextEdit[] }>;
export type AcknowledgementState = Readonly<{ id: string; proposal: ProposalTarget;
    submittedRevision: number; serverVersion: string; status: "pending" | "sending" | "failed" }>;
export type AgentSnapshot = Readonly<{
    association: AgentAssociation | null;
    request: Readonly<{ id: string; documentRevision: number }> | null;
    proposal: Proposal | null;
    proposalGeneration: number;
    acknowledgements: readonly AcknowledgementState[];
    lastResult: "none" | "proposed" | "interrupted" | "failed" | "stale";
}>;
export type AgentInput<T> = Readonly<{ id: string; association: AgentAssociation;
    source: CapturedResource<string>; context: Immutable<T> }>;
export type AgentRequest<T extends SnapshotValue> = Operation & Readonly<{
    input: AgentInput<T>; accept: (proposal: ProposedEdits) => AgentChangeResult; fail: () => void;
}>;
export type AgentChangeResult = ChangeResult | Readonly<{ applied: false; reason: "stale-proposal" | "stale-association" }>;
export type AgentSaveSubmission = SaveSubmission<string> & Readonly<{ proposal: ProposalTarget | null }>;
export type AgentSaveReceipt = SaveReceipt<string> & Readonly<{ submission: AgentSaveSubmission; acknowledgementId: string | null }>;
export type AgentSaveTicket = SaveTicket<string, AgentSaveSubmission, AgentSaveReceipt>;
export type AcknowledgementSubmission = Readonly<{ id: string; target: ResourceTarget; proposal: ProposalTarget; receipt: AgentSaveReceipt }>;
export type AcknowledgementTicket = Readonly<{ submission: AcknowledgementSubmission;
    accept: () => Readonly<{ accepted: boolean; retired: boolean }>; fail: () => void; finish: () => void }>;
export type AcknowledgementPort = Readonly<{ acknowledge: (submission: AcknowledgementSubmission) => Promise<void> }>;
export interface AgentReview extends Observable<AgentSnapshot> {
    associate(id: string): AgentAssociation;
    interrupt(): void;
    detach(): void;
    beginRequest<T extends SnapshotValue>(context: T): AgentRequest<T>;
    captureProposal(): ProposalGuard;
    offer(guard: ProposalGuard, proposal: ProposedEdits): AgentChangeResult;
    captureSave(review?: SaveReview): AgentSaveTicket;
    beginAcknowledgement(id: string): AcknowledgementTicket;
    acknowledge(id: string, port: AcknowledgementPort, onError?: (error: unknown) => void): Promise<Readonly<{ kind: "acknowledged"; retired: boolean } | { kind: "failed" }>>;
}

const emptyAgentState: AgentSnapshot = Object.freeze({ association: null, request: null, proposal: null, proposalGeneration: 0,
    acknowledgements: Object.freeze([]), lastResult: "none" });
function sameProposal(a: ProposalTarget, b: ProposalTarget): boolean {
    return a.id === b.id && a.revision === b.revision && a.generation === b.generation && a.association.id === b.association.id
        && a.association.generation === b.association.generation;
}

const reviews = new WeakMap<TextResourceHandle, AgentReview>();
/** One stable review owner per text resource. Pending work retains its resource until explicitly settled. */
export function createAgentReview(workspace: Workspace, source: TextResourceHandle): AgentReview {
    if (workspace.resourceForDocument(source.documentId) !== source) throw new Error("Review source belongs to another workspace.");
    let review = reviews.get(source);
    if (!review) { review = new Review(workspace, source); reviews.set(source, review); }
    return review;
}

class Review implements AgentReview {
    private readonly workspace: Workspace;
    private readonly source: TextResourceHandle;
    private readonly target: ResourceTarget;
    private readonly scope: NotificationScope;
    private readonly store: Store<AgentSnapshot>;
    private readonly requestLane = Symbol("agent-request");
    private readonly acknowledgementLane = Symbol("acknowledgement");
    private nextId = 0;
    private request: Readonly<{ operation: Operation; lease: EditLease }> | null = null;
    private proposalLease: ResourceLease | null = null;
    private readonly acknowledgements = new Map<string, { submission: AcknowledgementSubmission; state: AcknowledgementState; lease: ResourceLease }>();
    readonly getSnapshot: () => AgentSnapshot;
    readonly subscribe: Observable<AgentSnapshot>["subscribe"];
    constructor(workspace: Workspace, source: TextResourceHandle) {
        this.workspace = workspace; this.source = source; this.target = workspace.captureResource(source.id);
        this.scope = workspace.createNotificationScope(); this.store = new Store(emptyAgentState, this.scope);
        this.getSnapshot = () => source.getSnapshot().state === "released" ? emptyAgentState : this.store.get();
        this.subscribe = listener => {
            const stopReview = this.store.observable.subscribe(listener), stopSource = source.metadata.subscribe(listener);
            return () => { stopReview(); stopSource(); };
        };
    }
    private publish(state: AgentSnapshot): void {
        const changed = new Set<Store<unknown>>(); this.store.set(Object.freeze(state), changed); this.scope.deliver([...changed]);
    }
    private requireSource(): void {
        if (this.workspace.resolveResource(this.target) !== this.source) throw new Error("Review source was released.");
    }
    associate(id: string): AgentAssociation {
        this.scope.assertWritable(); this.requireSource();
        const review = this.store.get();
        if (this.source.getSnapshot().state !== "ready" || typeof id !== "string" || !id) throw new Error("Expected a ready text resource and association ID.");
        if (review.association) {
            if (review.association.id === id) return review.association;
            throw new Error("Explicitly detach the existing association before taking over.");
        }
        const association = Object.freeze({ id, generation: ++this.nextId });
        this.publish({ ...review, association, lastResult: "none" }); return association;
    }
    interrupt(): void {
        this.scope.batch(() => {
            this.requireSource(); const request = this.request; if (!request) return;
            request.operation.cancel(); request.lease.release(); this.request = null;
            this.publish({ ...this.store.get(), request: null, lastResult: "interrupted" });
        });
    }
    detach(): void {
        this.scope.batch(() => {
            this.interrupt(); this.proposalLease?.release(); this.proposalLease = null;
            const review = this.store.get();
            this.publish({ ...review, association: null, proposal: null, proposalGeneration: review.proposalGeneration + 1 });
        });
    }
    beginRequest<T extends SnapshotValue>(context: T): AgentRequest<T> {
        return this.scope.batch(() => {
            this.requireSource(); const state = this.source.getSnapshot(), review = this.store.get();
            if (state.state !== "ready" || !review.association || review.request || review.proposal || this.acknowledgements.size
                || this.workspace.ownership(this.source.id).saves) throw new Error("Agent request requires an associated resource with settled saves, proposals and acknowledgements.");
            const copiedContext = snapshotValue(context);
            if (state.metadata.editLock || !state.metadata.capabilities.edit.includes("agent")) throw new Error("Agent editing is unavailable.");
            const value = state.value(), operation = this.workspace.beginOperation(this.source.id, this.requestLane);
            const lease = this.workspace.acquireEditLease(this.source.id, review.association.id, "agent");
            const id = `request-${this.source.id}-${++this.nextId}`;
            const input = Object.freeze({ id, association: review.association, context: copiedContext,
                source: Object.freeze({ target: operation.target, key: state.metadata.key, revision: state.revision, value, serverVersion: state.metadata.serverVersion }) });
            this.request = { operation, lease };
            this.publish({ ...review, request: Object.freeze({ id, documentRevision: state.revision }), lastResult: "none" });
            const settle = (result: AgentSnapshot["lastResult"]) => this.scope.batch(() => {
                if (this.request?.operation === operation) {
                    this.request = null; lease.release(); this.publish({ ...this.store.get(), request: null, lastResult: result });
                }
                operation.finish();
            });
            return Object.freeze({ ...operation, input, accept: (proposal: ProposedEdits) => this.scope.batch(() => {
                try {
                    if (!operation.isCurrent() || this.request?.operation !== operation) { settle("stale"); return { applied: false, reason: "stale-association" } as const; }
                    const result = this.applyProposal(input.association, state.revision, review.proposalGeneration, proposal, lease);
                    this.request = null; lease.release();
                    this.publish({ ...this.store.get(), request: null, lastResult: result.applied ? "proposed" : "stale" }); return result;
                } catch (error) { settle("failed"); throw error; }
                finally { operation.finish(); }
            }), fail: () => settle("failed"), finish: () => settle("interrupted"), cancel: () => {
                this.scope.assertWritable(); if (this.request?.operation === operation) this.interrupt(); else operation.cancel();
            } });
        });
    }
    captureProposal(): ProposalGuard {
        this.requireSource(); const state = this.source.getSnapshot(), review = this.store.get();
        if (state.state !== "ready" || !review.association) throw new Error("A ready associated text resource is required.");
        return Object.freeze({ target: this.target, association: review.association, documentRevision: state.revision, generation: review.proposalGeneration });
    }
    offer(guard: ProposalGuard, proposal: ProposedEdits): AgentChangeResult {
        return this.scope.batch(() => {
            if (this.workspace.resolveResource(guard.target) !== this.source) return { applied: false, reason: "missing-resource" };
            return this.applyProposal(guard.association, guard.documentRevision, guard.generation, proposal);
        });
    }
    private applyProposal(association: AgentAssociation, revision: number, generation: number, proposal: ProposedEdits, lease?: EditLease): AgentChangeResult {
        const review = this.store.get();
        if (!review.association || review.association.id !== association.id || review.association.generation !== association.generation) return { applied: false, reason: "stale-association" };
        if (review.proposalGeneration !== generation) return { applied: false, reason: "stale-proposal" };
        if (typeof proposal.id !== "string" || !proposal.id || !Number.isSafeInteger(proposal.revision) || proposal.revision < 1) throw new RangeError("Proposal identity and positive revision are required.");
        if (review.proposal?.target.id === proposal.id && proposal.revision <= review.proposal.target.revision) return { applied: false, reason: "stale-proposal" };
        const result = this.workspace.edit({ documentId: this.source.documentId, expectedRevision: revision, origin: "agent", ...(lease ? { lease } : {}),
            edits: proposal.edits, history: { kind: "proposal" } });
        if (!result.applied) return result;
        this.workspace.sealHistory(this.source.documentId);
        this.proposalLease ??= this.workspace.acquire(this.source.id, { preventReload: true });
        const target = Object.freeze({ association: review.association, id: proposal.id, revision: proposal.revision, generation: generation + 1 });
        this.publish({ ...review, proposal: Object.freeze({ target, baseDocumentRevision: revision, documentRevision: result.revision }),
            proposalGeneration: generation + 1, lastResult: "proposed" }); return result;
    }
    captureSave(review?: SaveReview): AgentSaveTicket {
        this.scope.assertWritable(); this.requireSource();
        const proposal = this.store.get().proposal?.target ?? null, ticket = this.workspace.captureSave(this.source, review);
        let submitted: AgentSaveSubmission | undefined;
        return Object.freeze({ ...ticket, start: () => this.scope.batch(() => {
            submitted = Object.freeze({ ...ticket.start(), proposal }); return submitted;
        }), accept: (response, options) => this.scope.batch(() => {
            if (options?.applyCanonical !== undefined && typeof options.applyCanonical !== "boolean") throw new TypeError("applyCanonical must be a boolean.");
            const current = this.store.get().proposal?.target ?? null;
            const applyCanonical = options?.applyCanonical !== false && (proposal === null ? current === null : current !== null && sameProposal(proposal, current));
            const accepted = ticket.accept(response, { applyCanonical });
            const acknowledgementId = proposal === null ? null : `ack-${accepted.submission.id}`;
            const receipt: AgentSaveReceipt = Object.freeze({ ...accepted, submission: submitted!, acknowledgementId });
            if (acknowledgementId !== null && proposal !== null) {
                const submission = Object.freeze({ id: acknowledgementId, target: this.target, proposal, receipt });
                this.acknowledgements.set(acknowledgementId, { submission, lease: this.workspace.acquire(this.source.id, { preventReload: true }),
                    state: Object.freeze({ id: acknowledgementId, proposal, submittedRevision: receipt.submission.revision, serverVersion: receipt.serverVersion, status: "pending" }) });
                this.syncAcknowledgements();
            }
            return receipt;
        }) });
    }
    private syncAcknowledgements(): void {
        this.publish({ ...this.store.get(), acknowledgements: Object.freeze([...this.acknowledgements.values()].map(entry => entry.state)) });
    }
    beginAcknowledgement(id: string): AcknowledgementTicket {
        return this.scope.batch(() => {
            this.requireSource(); const entry = this.acknowledgements.get(id);
            if (!entry || this.acknowledgements.keys().next().value !== id || entry.state.status === "sending") throw new Error("Acknowledge the earliest pending receipt once at a time.");
            const operation = this.workspace.beginOperation(this.source.id, this.acknowledgementLane);
            entry.state = Object.freeze({ ...entry.state, status: "sending" }); this.syncAcknowledgements();
            let settled = false;
            const fail = () => {
                this.scope.assertWritable();
                if (!settled && operation.isCurrent()) { settled = true; entry.state = Object.freeze({ ...entry.state, status: "failed" }); this.syncAcknowledgements(); }
            };
            return Object.freeze({ submission: entry.submission, accept: () => this.scope.batch(() => {
                if (settled || !operation.isCurrent() || this.acknowledgements.get(id) !== entry) return Object.freeze({ accepted: false, retired: false });
                settled = true; const review = this.store.get(), retired = review.proposal !== null && sameProposal(review.proposal.target, entry.submission.proposal);
                this.acknowledgements.delete(id); entry.lease.release();
                if (retired) {
                    this.proposalLease?.release(); this.proposalLease = null;
                    this.publish({ ...review, proposal: null, proposalGeneration: review.proposalGeneration + 1 });
                }
                this.syncAcknowledgements(); return Object.freeze({ accepted: true, retired });
            }), fail, finish: () => { fail(); operation.finish(); } });
        });
    }
    async acknowledge(id: string, port: AcknowledgementPort, onError: (error: unknown) => void = () => {}): Promise<Readonly<{ kind: "acknowledged"; retired: boolean } | { kind: "failed" }>> {
        const ticket = this.beginAcknowledgement(id);
        try {
            await port.acknowledge(ticket.submission); const result = ticket.accept();
            return result.accepted ? { kind: "acknowledged", retired: result.retired } : { kind: "failed" };
        } catch (error) {
            ticket.fail(); try { onError(error); } catch { /* Receipt remains independently retryable. */ }
            return { kind: "failed" };
        } finally { ticket.finish(); }
    }
}
