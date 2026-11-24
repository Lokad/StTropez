import { cancelledRequest, staleRequest } from "./wire.ts";
import type { JsonValue } from "./wire.ts";
import type { DocumentSnapshot } from "../core/workspace.ts";
import type { InsertionIndentation } from "../core/insertion-text.ts";
import { createLspClient, lspFeatureHandle, type LspFeatureClient, type LspClientDiagnostics, type LspPositionRequest } from "./lsp-client.ts";
import { decodeLspCompletions, decodeLspResolvedCompletion, rebaseLspCompletion, UnsupportedLspSnippetError } from "./lsp-features.ts";
import type { LspCompletion, LspCompletions, LspCompletionFallback } from "./lsp-features.ts";
import type { LspCall } from "./lsp-session.ts";
import type { LspBindingCapture, LspPrepare, LspWorkspace } from "./lsp-workspace.ts";

export type LspCompletionBatch = LspCompletions & Readonly<{ document: DocumentSnapshot; offset: number;
    isCurrent: () => boolean; isBindingCurrent: () => boolean }>;
export type LspCompletionRequest = LspPositionRequest & Readonly<{
    context?: Readonly<{ triggerKind: 1 | 3; triggerCharacter?: never } | { triggerKind: 2; triggerCharacter: string }>;
    fallback?: LspCompletionFallback | (() => LspCompletionFallback); indentation?: InsertionIndentation;
    /** Keep this client's current batch usable while its replacement is pending. */
    retain?: LspCompletionBatch }>;
export type LspCompletionResolution = Readonly<{ batch: LspCompletionBatch; item: LspCompletion | null; reason: string | null }>;
export type LspCompletionClient = LspFeatureClient<"textDocument/completion", LspCompletionRequest, LspCompletionBatch,
    LspClientDiagnostics & Readonly<{ received: number }>> & Readonly<{
    rebase: (value: LspCompletionBatch, document: DocumentSnapshot) => LspCompletionBatch | undefined;
    resolve: (value: LspCompletionBatch, item: LspCompletion, prepare?: LspPrepare) => LspCall<LspCompletionResolution>;
}>;

type Batch = { binding: LspBindingCapture; value: LspCompletionBatch; requestedAt: number };
const same = (left: DocumentSnapshot | undefined, right: DocumentSnapshot) => !!left && left.id === right.id
    && left.resourceId === right.resourceId && left.revision === right.revision && left.buffer === right.buffer;
const stale = () => staleRequest("LSP completion batch expired.");

/** One current choice batch and one request/resolve intent; host view and acceptance policy stay outside. */
export function createLspCompletionClient(provider: LspWorkspace): LspCompletionClient {
    const client = createLspClient(provider, "textDocument/completion"), batches = new WeakMap<LspCompletionBatch, Batch>();
    let active: Batch | undefined, sequence = 0, received = 0, disposed = false;
    let pending: LspCall<unknown> | undefined;
    const cancelPending = () => { sequence++; const old = pending; pending = undefined; old?.cancel(); };
    const current = (batch: Batch) => !disposed && active === batch && same(batch.binding.getSnapshot(), batch.value.document);
    const requireBatch = (value: LspCompletionBatch) => {
        const batch = batches.get(value); if (!batch || !current(batch)) throw stale(); return batch;
    };
    const publish = (binding: LspBindingCapture, document: DocumentSnapshot, offset: number, choices: LspCompletions, requestedAt = offset): LspCompletionBatch => {
        const batch: Batch = { binding, value: undefined!, requestedAt };
        batch.value = Object.freeze({ ...choices, document, offset, isCurrent: () => current(batch),
            isBindingCurrent: () => !disposed && active === batch && !!binding.getSnapshot() });
        batches.set(batch.value, batch); active = batch; return batch.value;
    };
    const own = <T>(call: LspCall<T>): LspCall<T> => {
        const serial = sequence; pending = call; let finished = false;
        const result = call.result.then(value => {
            if (disposed || serial !== sequence) throw cancelledRequest("LSP completion request cancelled.");
            return value;
        }).catch(error => { if (serial === sequence) active = undefined; throw error; }).finally(() => {
            finished = true; if (pending === call) pending = undefined;
        });
        return Object.freeze({ result, cancel: () => { if (!finished && serial === sequence) cancelPending(); } });
    };
    return Object.freeze({ ...lspFeatureHandle(client, {
        cancel: () => { active = undefined; cancelPending(); client.cancel(); },
        dispose: () => { if (disposed) return; disposed = true; active = undefined; cancelPending(); client.dispose(); } }),
        snapshot: () => Object.freeze({ ...client.snapshot(), received }),
        run: (options: LspCompletionRequest): LspCall<LspCompletionBatch> => {
            const { document, offset } = options;
            const context = Object.freeze({ ...(options.context ?? { triggerKind: 1 }) });
            if (context.triggerKind === 2 && (!context.triggerCharacter.length || context.triggerCharacter.length > 8)) throw new TypeError("Invalid completion trigger context.");
            const indentation = options.indentation && Object.freeze({ ...options.indentation }),
                fallback = options.fallback && (typeof options.fallback === "function" ? options.fallback : Object.freeze({ ...options.fallback }));
            if (options.retain) {
                requireBatch(options.retain);
                if (!same(document, options.retain.document) || offset !== options.retain.offset) throw stale();
            } else active = undefined;
            cancelPending();
            const call = client.request(options, "textDocument/completion", capture => ({ position: capture.index.at(offset), context }), value => value.decode(() => {
                received++;
                const binding = client.scope.captureBinding(value.target, "textDocument/completion"), local = binding?.getSnapshot();
                if (!binding || !local || !same(local, document)) throw stale();
                const configuration = client.options(document, "textDocument/completion"),
                    commitCharacters = configuration.flatMap(option => Array.isArray(option.allCommitCharacters) ? option.allCommitCharacters.filter((value): value is string => typeof value === "string") : []);
                const choices = decodeLspCompletions(value.response, value.capture, offset, fallback, {
                    resolve: configuration.some(option => option.resolveProvider === true), commitCharacters, ...(indentation ? { indentation } : {}) });
                const items = Object.freeze(choices.items.map((item, order) => ({ item, order }))
                    .sort((a, b) => a.item.sortText < b.item.sortText ? -1 : a.item.sortText > b.item.sortText ? 1 : a.order - b.order).map(value => value.item));
                return publish(binding, local, offset, Object.freeze({ ...choices, items }));
            }));
            return own(call);
        },
        rebase: (value: LspCompletionBatch, document: DocumentSnapshot): LspCompletionBatch | undefined => {
            const batch = batches.get(value), local = batch?.binding.getSnapshot();
            if (disposed || !batch || active !== batch || !local || !same(local, document) || !local.change || !value.items.length) return;
            // The provider may have omitted choices that didn't match its original query.
            if (value.offset + local.buffer.length - value.document.buffer.length < batch.requestedAt) return;
            const source = Object.freeze({ ...batch.binding.document, revision: local.revision, buffer: local.buffer });
            const items = value.items.map(item => rebaseLspCompletion(item, source, local.change!, value.offset));
            if (!items.every((item): item is LspCompletion => !!item)) return;
            cancelPending();
            return publish(batch.binding, local, items[0]!.offset, Object.freeze({ ...value, items: Object.freeze(items) }), batch.requestedAt);
        },
        resolve: (value: LspCompletionBatch, item: LspCompletion, prepare?: LspPrepare): LspCall<LspCompletionResolution> => {
            const batch = requireBatch(value);
            if (!value.items.includes(item) || !item.resolve) throw new TypeError("Choose a captured unresolved completion.");
            cancelPending();
            const call = client.request({ document: value.document, prepare }, "textDocument/completion", () => {
                if (!current(batch)) throw stale(); return item.resolve as Record<string, JsonValue>;
            }, response => response.decode(() => {
                if (!current(batch)) throw stale();
                let resolved: LspCompletion | null, reason: string | null = null;
                try { resolved = decodeLspResolvedCompletion(response.response, item, response.capture); }
                catch (error) { if (!(error instanceof UnsupportedLspSnippetError)) throw error; resolved = null; reason = error.message; }
                const items = Object.freeze(value.items.flatMap(value => value === item ? resolved ? [resolved] : [] : [value]));
                const omitted = reason ? Object.freeze([...value.omitted, Object.freeze({ label: item.label, reason })]) : value.omitted;
                return Object.freeze({ batch: publish(batch.binding, value.document, value.offset, Object.freeze({ ...value, items, omitted }), batch.requestedAt), item: resolved, reason });
            }), "completionItem/resolve");
            return own(call);
        } });
}
