import type { DocumentSnapshot } from "../core/workspace.ts";
import { jsonSnapshot, RpcError } from "./json-rpc.ts";
import type { JsonValue } from "./json-rpc.ts";
import { decodeLspApplyEdit, lspApplyEditUris } from "./lsp-features.ts";
import { createLspTargets } from "./lsp-targets.ts";
import type { LspApplyEdit, LspApplyEditResult } from "./lsp-features.ts";
import type { LspCommandCall, LspRequestContext } from "./lsp-session.ts";
import type { LspWorkspaceScope } from "./lsp-workspace.ts";
import type { LspCommand } from "./lsp-command-value.ts";

export type LspCommandScope = Readonly<{ snapshots: () => readonly DocumentSnapshot[]; isCurrent: () => boolean;
    prepare?: () => void; review: (request: LspApplyEdit, context: LspRequestContext) => Promise<LspApplyEditResult> }>;
export type LspCommandReceipt = Readonly<{ value: JsonValue; decision: LspApplyEditResult | undefined }>;
export type LspHostCommandContext = Readonly<{ snapshots: () => readonly DocumentSnapshot[]; isCurrent: () => boolean;
    onCancel: (listener: () => void) => () => void;
    /** LSP ApplyWorkspaceEditParams, validated through the same captured edit policy as server requests. */
    applyEdit: (request: unknown) => Promise<LspApplyEditResult> }>;
export type LspCommandRoute = Readonly<{ kind: "server"; isCurrent?: () => boolean } | { kind: "host"; isCurrent?: () => boolean;
    run: (invocation: LspCommand, context: LspHostCommandContext) => JsonValue | Promise<JsonValue> }>;
/** Called once for each captured invocation. Null denies it; no policy retains advertised server commands. */
export type LspCommandPolicy = (invocation: LspCommand) => LspCommandRoute | null;

/** One confirmed command per session. The host owns decisions and every document mutation. */
export function createLspCommandRunner(session: LspWorkspaceScope, notify: () => void = () => {}) {
    type Active = { scope: LspCommandScope; route: LspCommandRoute; allowEdits: boolean; epoch: number; generation: number; call?: LspCommandCall<JsonValue>; decision?: LspApplyEditResult };
    const invalidations = new Set<() => void>(); let disposed = false, incoming = false, active: Active | undefined, received = 0, refused = 0;
    const current = (op: Active) => !disposed && active === op && session.state.getSnapshot().phase === "ready" && session.state.getSnapshot().epoch === op.epoch
        && session.state.getSnapshot().registrationGeneration === op.generation && (op.route.isCurrent?.() ?? true) && (op.call?.isCurrent() ?? true);
    const changed = () => { for (const invalid of [...invalidations]) invalid(); notify(); };
    const sync = async (scope: LspCommandScope) => { const snapshots = scope.snapshots();
        session.setDocuments(snapshots); await session.flush(); };
    const apply = async (op: Active | undefined, value: unknown, context: LspRequestContext): Promise<LspApplyEditResult> => {
        received++; const no = (reason: string) => { refused++; const decision = Object.freeze({ applied: false, failureReason: reason.slice(0, 1024) });
            if (op && active === op && op.decision?.applied !== false) op.decision = decision; return decision; };
        if (!op || !op.allowEdits || incoming || !current(op) || !op.scope.isCurrent()) return no("No available captured edit-review intent.");
        incoming = true;
        let targets: ReturnType<typeof createLspTargets> | undefined;
        try {
            const captures = session.captureProject();
            const isCurrent = () => context.isCurrent() && current(op) && op.scope.isCurrent();
            const capturedContext: LspRequestContext = Object.freeze({ id: context.id, epoch: context.epoch, get cancelled() { return context.cancelled || !current(op); }, isCurrent,
                onCancel: listener => { let done = false; const invalid = () => { if (!done && !isCurrent()) { done = true; void Promise.resolve().then(listener).catch(session.reportError); } };
                    const stopCancel = context.onCancel(invalid); invalidations.add(invalid); invalid(); return () => { done = true; stopCancel(); invalidations.delete(invalid); }; } });
            targets = createLspTargets(captures, session.resolveTarget, { source: null, reportError: session.reportError,
                isCurrent: capturedContext.isCurrent, onCancel: capturedContext.onCancel });
            await targets.resolve(lspApplyEditUris(value), "edit");
            const request = decodeLspApplyEdit(value, targets.get);
            const decision = await op.scope.review(request, capturedContext);
            if (op.decision?.applied !== false) op.decision = decision;
            if (decision.applied && current(op)) { try { await sync(op.scope); } catch { /* A committed edit is never retried or reported as unapplied. */ } }
            return decision;
        } catch (error) { return no(error instanceof Error ? error.message : "Invalid workspace edit request."); }
        finally { targets?.dispose(); incoming = false; changed(); }
    };
    const stopState = session.state.subscribe(changed), stopApply = session.onRequest("workspace/applyEdit", (value, context) =>
        apply(active?.route.kind === "server" ? active : undefined, value, context));
    const run = async (invocation: LspCommand, scope: LspCommandScope, route: LspCommandRoute, allowEdits: boolean): Promise<LspCommandReceipt> => {
        if (disposed || active || !scope.isCurrent() || !(route.isCurrent?.() ?? true)) throw new RpcError(-32801, "Captured command is unavailable or changed.");
        const argumentsValue = jsonSnapshot(invocation.arguments);
        if (!Array.isArray(argumentsValue) || JSON.stringify(argumentsValue).length > 8192) throw new RangeError("LSP command arguments exceed their limit.");
        const captured = Object.freeze({ ...invocation, arguments: argumentsValue as readonly JsonValue[] }), reservation = session.reserveCommand();
        const state = session.state.getSnapshot(), op: Active = { scope, route, allowEdits, epoch: state.epoch, generation: state.registrationGeneration }; active = op;
        let stopCancel = () => {};
        try {
            scope.prepare?.(); await sync(scope);
            if (!current(op) || !scope.isCurrent() || !reservation.isCurrent()) throw new RpcError(-32801, "Captured command intent changed.");
            let value: JsonValue;
            if (route.kind === "server") {
                op.call = session.requestCommand(captured.command, captured.arguments, 120000, { command: captured.command, arguments: captured.arguments,
                    isCurrent: route.isCurrent ?? (() => true) });
                value = await op.call.result;
            } else {
                const isCurrent = () => current(op) && scope.isCurrent() && reservation.isCurrent();
                const onCancel = (listener: () => void) => {
                    let done = false; const invalid = () => { if (!done && !isCurrent()) { done = true; invalidations.delete(invalid); void Promise.resolve().then(listener).catch(session.reportError); } };
                    invalidations.add(invalid); invalid(); return () => { done = true; invalidations.delete(invalid); };
                };
                const context: LspRequestContext = Object.freeze({ id: "host-command", epoch: op.epoch, get cancelled() { return !isCurrent(); }, isCurrent, onCancel });
                const cancelled = new Promise<never>((_resolve, reject) => { stopCancel = onCancel(() => reject(new RpcError(-32800, "Host command cancelled."))); });
                value = jsonSnapshot(await Promise.race([Promise.resolve().then(() => {
                    if (!isCurrent()) throw new RpcError(-32801, "Captured host command changed.");
                    return route.run(captured, Object.freeze({ snapshots: () => Object.freeze([...scope.snapshots()]), isCurrent, onCancel,
                        applyEdit: request => apply(op, request, context) }));
                }), cancelled]));
            }
            if (!current(op) || !scope.isCurrent()) throw new RpcError(-32801, "Captured command intent changed.");
            return Object.freeze({ value, decision: op.decision });
        } finally { stopCancel(); op.call?.cancel(); reservation.release(); if (active === op) active = undefined; changed(); }
    };
    return Object.freeze({ sync, isCurrent: () => !disposed && (!active || current(active)),
        cancel: () => { const op = active; if (!op) return; op.call?.cancel(); if (active === op) active = undefined; changed(); },
        run: async (command: string, args: readonly JsonValue[], scope: LspCommandScope, allowEdits = true): Promise<LspCommandReceipt> => {
            return run({ title: command, command, arguments: args }, scope, { kind: "server", isCurrent: () => session.commandNames().includes(command) }, allowEdits);
        },
        runAuthorized: (invocation: LspCommand, scope: LspCommandScope, route: LspCommandRoute) => run(invocation, scope, Object.freeze({ ...route }), true),
        snapshot: () => Object.freeze({ received, refused }),
        dispose: () => { if (disposed) return; disposed = true; stopState(); stopApply(); active?.call?.cancel(); changed(); invalidations.clear(); } });
}
