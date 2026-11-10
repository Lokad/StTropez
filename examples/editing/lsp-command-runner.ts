import type { DocumentId, DocumentSnapshot, Workspace } from "../../src/index.ts";
import { RpcError, decodeLspApplyEdit } from "../../src/protocol/index.ts";
import type { JsonValue, LspApplyEdit, LspApplyEditResult, LspCommandCall, LspDocument, LspRequestContext, LspSession } from "../../src/protocol/index.ts";
import { captureLspProject, updateLspProject } from "./lsp-project.ts";

export type LspCommandScope = Readonly<{ snapshots: () => readonly DocumentSnapshot[]; isCurrent: () => boolean;
    prepare?: () => void; review: (request: LspApplyEdit, context: LspRequestContext) => Promise<LspApplyEditResult> }>;
export type LspCommandReceipt = Readonly<{ value: JsonValue; decision: LspApplyEditResult | undefined }>;

/** One confirmed command per session. The host owns decisions and every document mutation. */
export function createLspCommandRunner(workspace: Workspace, session: LspSession, documents: Map<string, LspDocument>, uri: (id: DocumentId) => string, notify: () => void) {
    type Active = { scope: LspCommandScope; allowEdits: boolean; epoch: number; generation: number; call?: LspCommandCall<JsonValue>; decision?: LspApplyEditResult };
    const invalidations = new Set<() => void>(); let disposed = false, incoming = false, active: Active | undefined, received = 0, refused = 0;
    const current = (op: Active) => !disposed && active === op && session.state.getSnapshot().phase === "ready" && session.state.getSnapshot().epoch === op.epoch
        && session.state.getSnapshot().registrationGeneration === op.generation && (op.call?.isCurrent() ?? true);
    const changed = () => { for (const invalid of [...invalidations]) invalid(); notify(); };
    const sync = async (scope: LspCommandScope) => { const snapshots = scope.snapshots();
        updateLspProject(workspace, session, documents, snapshots.map(doc => ({ document: doc.id, revision: doc.revision, length: doc.buffer.length })), new Map(snapshots.map(doc => [doc.id, doc.buffer])), uri); await session.flush(); };
    const stopState = session.state.subscribe(changed), stopApply = session.onRequest("workspace/applyEdit", async (value, context) => {
        received++; const op = active, no = (reason: string) => { refused++; return Object.freeze({ applied: false, failureReason: reason.slice(0, 1024) }); };
        if (!op || !op.allowEdits || incoming || !current(op) || !op.scope.isCurrent()) return no("No available captured edit-review intent.");
        incoming = true;
        try {
            const captures = captureLspProject(session, documents), request = decodeLspApplyEdit(value, target => captures.get(target));
            const isCurrent = () => context.isCurrent() && current(op) && op.scope.isCurrent();
            const capturedContext: LspRequestContext = Object.freeze({ id: context.id, epoch: context.epoch, get cancelled() { return context.cancelled || !current(op); }, isCurrent,
                onCancel: listener => { let done = false; const invalid = () => { if (!done && !isCurrent()) { done = true; queueMicrotask(listener); } };
                    const stopCancel = context.onCancel(invalid); invalidations.add(invalid); invalid(); return () => { done = true; stopCancel(); invalidations.delete(invalid); }; } });
            op.decision = await op.scope.review(request, capturedContext);
            if (op.decision.applied && current(op)) { try { await sync(op.scope); } catch { /* A committed edit is never retried or reported as unapplied. */ } }
            return op.decision;
        } catch (error) { op.decision = no(error instanceof Error ? error.message : "Invalid workspace edit request."); return op.decision; }
        finally { incoming = false; changed(); }
    });
    return Object.freeze({ sync, isCurrent: () => !disposed && (!active || current(active)),
        run: async (command: string, args: readonly JsonValue[], scope: LspCommandScope, allowEdits = true): Promise<LspCommandReceipt> => {
            if (disposed || active || !scope.isCurrent() || !session.commandNames().includes(command)) throw new RpcError(-32801, "Captured command is unavailable or changed.");
            const state = session.state.getSnapshot(), op: Active = { scope, allowEdits, epoch: state.epoch, generation: state.registrationGeneration }; active = op;
            try {
                scope.prepare?.(); await sync(scope);
                if (!current(op) || !scope.isCurrent()) throw new RpcError(-32801, "Captured command intent changed.");
                op.call = session.requestCommand(command, args, 120000); const value = await op.call.result;
                if (!current(op) || !scope.isCurrent()) throw new RpcError(-32801, "Captured command intent changed.");
                return Object.freeze({ value, decision: op.decision });
            } finally { op.call?.cancel(); if (active === op) active = undefined; changed(); }
        },
        snapshot: () => Object.freeze({ received, refused }),
        dispose: () => { if (disposed) return; disposed = true; stopState(); stopApply(); active?.call?.cancel(); changed(); invalidations.clear(); } });
}
