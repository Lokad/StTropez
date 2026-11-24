import { isNonNegativeInteger } from "../core/bounds.ts";
import type { Observable } from "../core/observable.ts";
import type { DocumentSnapshot } from "../core/workspace.ts";
import type { LspDocumentOwner, LspDocumentRequest } from "../protocol/lsp-client.ts";
import type { LspDocumentFeature } from "../protocol/lsp-session.ts";
import { sameDocument, type LspWorkspace } from "../protocol/lsp-workspace.ts";
import type { DecorationLayer, DecorationLayerOptions } from "./decoration-layers.ts";
import type { TextEditor } from "./text-editor.ts";
import type { InlineDecoration } from "./viewport.ts";

type Document = Observable<DocumentSnapshot | undefined>;
type Client<T> = {
    run: (request: LspDocumentRequest) => { result: Promise<{ items: readonly T[]; isCurrent(): boolean }> };
    dispose(): void;
};

/** Panes share a scan for one provider, feature and document. Each keeps its own decoration layer. */
export function documentRangeWatch<T extends { from: number; to: number }>(method: LspDocumentFeature,
    clientFor: (owner: LspDocumentOwner) => Client<T>, decorate: (item: T) => InlineDecoration, layerOptions: DecorationLayerOptions) {
    const scans = new WeakMap<LspWorkspace, WeakMap<Document, ReturnType<typeof scanDocument>>>();

    function scanDocument(document: Document, provider: LspWorkspace) {
        const panes = new Map<DecorationLayer, LspDocumentOwner>();
        let last: DocumentSnapshot | undefined;
        let connection: string | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let pending: { client: Client<T>; layer: DecorationLayer } | undefined;
        let paint: { revision: number; items: readonly T[]; ranges: readonly InlineDecoration[] } | undefined;
        function cancel() {
            clearTimeout(timer);
            const previous = pending;
            pending = undefined;
            if (previous) queueMicrotask(previous.client.dispose);
        }
        function clear() {
            cancel();
            paint = undefined;
            for (const layer of panes.keys()) layer.clear();
        }
        function accept(doc: DocumentSnapshot, items: readonly T[]) {
            if (!sameDocument(document.getSnapshot(), doc)) return;
            cancel();
            const ranges = items.map(decorate);
            paint = { revision: doc.revision, items, ranges };
            for (const layer of panes.keys()) layer.set(doc.revision, ranges);
        }
        async function scan() {
            const doc = document.getSnapshot();
            const pane = panes.entries().next().value;
            if (!doc || !pane || !provider.queryFeatureOptions(method, doc).length) return;
            let client: Client<T> | undefined;
            try {
                client = clientFor(pane[1]);
                pending = { client, layer: pane[0] };
                const reply = await client.run({ document: doc }).result;
                if (pending?.client === client && reply.isCurrent()) {
                    pending = undefined;
                    accept(doc, reply.items);
                }
            } catch {
                if (pending?.client === client) {
                    pending = undefined;
                    clear();
                }
            } finally {
                if (pending?.client === client) pending = undefined;
                client?.dispose();
            }
        }
        function schedule() {
            const doc = document.getSnapshot(), state = provider.getSnapshot();
            const next = `${state.phase}:${state.epoch}:${state.registrationVersion(method)}`;
            if (next === connection && (last === doc || doc && sameDocument(last, doc))) return;
            if (connection !== next || last?.language !== doc?.language || !doc) clear();
            else cancel();
            last = doc;
            connection = next;
            if (doc && state.phase === "ready") timer = setTimeout(scan, 200);
        }
        const stopProvider = provider.subscribe(schedule);
        const stopDocument = document.subscribe(schedule);
        return {
            accept, clear,
            at(offset: number, matches?: (item: T) => boolean) {
                const doc = document.getSnapshot();
                if (!paint || !isNonNegativeInteger(offset) || paint.revision !== doc?.revision || doc.language !== last?.language) return;
                return paint.items.find(item => matches ? item.from === offset && matches(item)
                    : item.from <= offset && offset < item.to);
            },
            add(layer: DecorationLayer, owner: LspDocumentOwner) {
                panes.set(layer, owner);
                if (paint) layer.set(paint.revision, paint.ranges);
                schedule();
            },
            remove(layer: DecorationLayer) {
                panes.delete(layer);
                if (!panes.size) {
                    cancel();
                    stopDocument();
                    stopProvider();
                    scans.get(provider)?.delete(document);
                } else if (pending?.layer === layer) {
                    cancel();
                    timer = setTimeout(scan, 0);
                }
            },
        };
    }

    return function mount(editor: TextEditor, owner: LspDocumentOwner) {
        const { provider } = owner;
        const source = editor.workspace.observeDocument(editor.view.documentId);
        const layer = editor.decorations.add(layerOptions);
        const byDocument = scans.get(provider) ?? new WeakMap<Document, ReturnType<typeof scanDocument>>();
        scans.set(provider, byDocument);
        let group = byDocument.get(source);
        try {
            group ??= scanDocument(source, provider);
            byDocument.set(source, group);
            group.add(layer, owner);
        } catch (error) {
            group?.remove(layer);
            layer.dispose();
            throw error;
        }
        return { at: group.at, accept: group.accept, clear: group.clear, dispose() {
            group.remove(layer);
            layer.dispose();
        } };
    };
}
