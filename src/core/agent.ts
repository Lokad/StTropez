import type { TextEdit } from "./changes.ts";
import type { CapturedResource } from "./commands.ts";
import type { Immutable, SnapshotValue } from "./values.ts";
import type { ChangeResult, Operation, ResourceTarget, SaveReceipt } from "./workspace.ts";

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
    input: AgentInput<T>; accept: (proposal: ProposedEdits) => ChangeResult; fail: () => void;
}>;
export type AcknowledgementSubmission = Readonly<{ id: string; target: ResourceTarget; proposal: ProposalTarget; receipt: SaveReceipt<string> }>;
export type AcknowledgementTicket = Readonly<{ submission: AcknowledgementSubmission;
    accept: () => Readonly<{ accepted: boolean; retired: boolean }>; fail: () => void; finish: () => void }>;

export const emptyAgentState: AgentSnapshot = Object.freeze({ association: null, request: null, proposal: null, proposalGeneration: 0,
    acknowledgements: Object.freeze([]), lastResult: "none" });
export function sameProposal(a: ProposalTarget, b: ProposalTarget): boolean {
    return a.id === b.id && a.revision === b.revision && a.generation === b.generation && a.association.id === b.association.id
        && a.association.generation === b.association.generation;
}
