import type { DocumentId, DocumentSnapshot, Workspace } from "../../src/index.ts";
import { LspSession, RpcError, decodeLspApplyEdit } from "../../src/protocol/index.ts";
import type { LspApplyEdit, LspApplyEditResult, LspCommandCall, LspDocument, LspRequestContext, LspSessionOptions } from "../../src/protocol/index.ts";
import type { ProjectCommand } from "../probes/project-commands.ts";
import { captureLspProject, updateLspProject } from "./lsp-project.ts";

export type LspProjectScope = Readonly<{ snapshots: () => readonly DocumentSnapshot[]; isCurrent: () => boolean;
    review: (request: LspApplyEdit, context: LspRequestContext) => Promise<LspApplyEditResult> }>;
export type LspProjectOptions = Readonly<{ connect: LspSessionOptions["connect"]; uri: (id: DocumentId) => string; reviewCommand: string; statusCommand: string;
    beforeRequest?: (session: LspSession, input: ProjectCommand) => Promise<unknown> }>;
export type LspProjectClient = ReturnType<typeof createLspProjectClient>;
export type LspProjectFactory = (clock: Pick<Window, "setTimeout" | "clearTimeout">) => LspProjectClient;

/** One explicit command scope; incoming edit requests can only enter that scope's captured review. */
export function createLspProjectClient(workspace: Workspace, clock: Pick<Window, "setTimeout" | "clearTimeout">, options: LspProjectOptions) {
    type Active = { input: ProjectCommand; scope: LspProjectScope; call?: LspCommandCall<unknown>; epoch: number; generation: number };
    const documents = new Map<string, LspDocument>(), listeners = new Set<() => void>(); let disposed = false, busy = false, incoming = false, active: Active | undefined;
    let created = 0, terminated = 0, received = 0, refused = 0;
    const current = (op: Active) => !disposed && active === op && session.state.getSnapshot().phase === "ready" && session.state.getSnapshot().epoch === op.epoch
        && session.state.getSnapshot().registrationGeneration === op.generation && (op.call?.isCurrent() ?? true);
    const changed = () => { for (const listener of [...listeners]) listener(); };
    const session = new LspSession({ features: ["workspace/executeCommand"], applyEdit: true,
        schedule: (ms, callback) => { const timer = clock.setTimeout(callback, ms); return () => clock.clearTimeout(timer); }, connect: async context => {
            const transport = await options.connect(context); created++; let released = false;
            return { send: transport.send, subscribe: transport.subscribe, dispose: () => { if (released) return; released = true; terminated++; transport.dispose(); } };
        } });
    const stopState = session.state.subscribe(changed);
    let lastOutcome: LspApplyEditResult | undefined;
    const sync = async (scope: LspProjectScope) => {
        const snapshots = scope.snapshots(); updateLspProject(workspace, session, documents, snapshots.map(doc => ({ document: doc.id, revision: doc.revision, length: doc.buffer.length })), new Map(snapshots.map(doc => [doc.id, doc.buffer])), options.uri);
        await session.flush();
    };
    const stopApply = session.onRequest("workspace/applyEdit", async (value, context) => {
        received++; const op = active, no = (reason: string) => { refused++; return Object.freeze({ applied: false, failureReason: reason.slice(0, 1024) }); };
        if (!op || op.input.kind !== "review" || incoming || !current(op) || !op.scope.isCurrent()) return no("No available captured edit-review intent.");
        incoming = true;
        try {
            const captures = captureLspProject(session, documents), request = decodeLspApplyEdit(value, uri => captures.get(uri));
            const isCurrent = () => context.isCurrent() && current(op) && op.scope.isCurrent();
            const capturedContext: LspRequestContext = Object.freeze({ id: context.id, epoch: context.epoch, get cancelled() { return context.cancelled || !current(op); }, isCurrent,
                onCancel: listener => { let done = false; const invalid = () => { if (!done && !isCurrent()) { done = true; queueMicrotask(listener); } };
                    const stopCancel = context.onCancel(invalid), stopChange = session.state.subscribe(invalid); invalid(); return () => { done = true; stopCancel(); stopChange(); }; } });
            lastOutcome = await op.scope.review(request, capturedContext);
            // Once committed, report the actual decision even if acknowledgement/synchronization is lost.
            if (lastOutcome.applied && !disposed && current(op)) { try { await sync(op.scope); } catch { /* The captured host receipt retains any committed edit; never retry it. */ } }
            return lastOutcome;
        } catch (error) { lastOutcome = no(error instanceof Error ? error.message : "Invalid workspace edit request."); return lastOutcome; }
        finally { incoming = false; changed(); }
    });
    return Object.freeze({ subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        run: async (input: ProjectCommand, scope: LspProjectScope) => {
            if (disposed || busy) throw new Error("Workspace provider is unavailable."); busy = true; lastOutcome = undefined;
            try {
                await session.connect(); if (!scope.isCurrent()) throw new RpcError(-32801, "Captured project changed."); await sync(scope);
                if (options.beforeRequest) await options.beforeRequest(session, input); if (!scope.isCurrent()) throw new RpcError(-32801, "Captured project changed.");
                if (input.kind === "register" || input.kind === "unregister") { const registered = session.commandNames().includes(options.reviewCommand); return Object.freeze({ registered, applied: registered === (input.kind === "register"), reason: registered ? "Provider review command registered for this connection." : "Provider review command is not registered." }); }
                const state = session.state.getSnapshot(), op: Active = { input, scope, epoch: state.epoch, generation: state.registrationGeneration }; active = op;
                op.call = session.requestCommand(input.kind === "review" ? options.reviewCommand : options.statusCommand, [], 120000); await op.call.result;
                if (!scope.isCurrent()) throw new RpcError(-32801, "Captured command intent changed.");
                const result = input.kind === "status" ? { applied: true, reason: "Provider workspace status received." } : lastOutcome ?? { applied: false, failureReason: "Provider returned without requesting an edit decision." };
                return Object.freeze({ registered: session.commandNames().includes(options.reviewCommand), applied: result.applied,
                    reason: "reason" in result ? result.reason : result.applied ? "Captured provider edit decision acknowledged." : result.failureReason ?? "Provider edits declined." });
            } finally { active = undefined; busy = false; changed(); }
        },
        isCurrent: () => !disposed && (!active || current(active)),
        faultIdle: () => { if (disposed || busy || session.state.getSnapshot().phase !== "ready") return false; session.disconnect(); return true; },
        snapshot: () => Object.freeze({ connected: session.state.getSnapshot().phase === "ready", busy, disposed, version: "LSP3.17", epoch: session.state.getSnapshot().epoch, registered: session.commandNames().includes(options.reviewCommand), created, terminated, received, refused, protocol: session.snapshotOwnership() }),
        dispose: () => { if (disposed) return; disposed = true; stopState(); stopApply(); listeners.clear(); active?.call?.cancel(); session.dispose(); documents.clear(); } });
}
