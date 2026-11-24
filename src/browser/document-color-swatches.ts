import { isNonNegativeInteger } from "../core/bounds.ts";
import type { Observable } from "../core/observable.ts";
import type { DocumentSnapshot } from "../core/workspace.ts";
import type { LspDocumentOwner } from "../protocol/lsp-client.ts";
import type { LspColor, LspDocumentColor } from "../protocol/lsp-features.ts";
import { colorClient, type LspColorClient } from "../protocol/lsp-language.ts";
import { documentColorMethod } from "../protocol/lsp-methods.ts";
import type { LspWorkspace } from "../protocol/lsp-workspace.ts";
import type { DecorationLayer } from "./decoration-layers.ts";
import type { TextEditor } from "./text-editor.ts";
import type { InlineDecoration } from "./viewport.ts";

type Document = Observable<DocumentSnapshot | undefined>;
type Owner = LspWorkspace | LspDocumentOwner;
const scans = new WeakMap<LspWorkspace, WeakMap<Document, ReturnType<typeof scanDocument>>>();
const css = (c: LspColor) => `rgba(${c.red * 255}, ${c.green * 255}, ${c.blue * 255}, ${c.alpha})`;

function scanDocument(document: Document, provider: LspWorkspace) {
    const panes = new Map<DecorationLayer, Owner>();
    let last: DocumentSnapshot | undefined;
    let connection: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: { client: LspColorClient; layer: DecorationLayer } | undefined;
    let paint: { revision: number; items: readonly LspDocumentColor[]; ranges: readonly InlineDecoration[] } | undefined;
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
    function accept(doc: DocumentSnapshot, items: readonly LspDocumentColor[]) {
        const current = document.getSnapshot();
        if (current?.revision !== doc.revision || current.language !== doc.language || current.buffer !== doc.buffer) return;
        cancel();
        const ranges = items.map(({ from, to, color }) => ({ from, to, className: "st-document-color",
            before: "st-color-swatch", properties: { "--st-swatch-color": css(color) } }));
        paint = { revision: doc.revision, items, ranges };
        for (const layer of panes.keys()) layer.set(doc.revision, ranges);
    }
    async function scan() {
        const doc = document.getSnapshot();
        const pane = panes.entries().next().value;
        if (!doc || !pane || !provider.queryFeatureOptions(documentColorMethod, doc).length) return;
        let client: LspColorClient | undefined;
        try {
            client = colorClient(pane[1]);
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
        const next = `${state.phase}:${state.epoch}:${state.registrationVersion(documentColorMethod)}`;
        if (next === connection && last?.buffer === doc?.buffer && last?.revision === doc?.revision
            && last?.language === doc?.language) return;
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
        at(offset: number, swatch?: string) {
            const doc = document.getSnapshot();
            if (!paint || !isNonNegativeInteger(offset) || paint.revision !== doc?.revision || doc.language !== last?.language) return;
            return paint.items.find(item => swatch === undefined ? item.from <= offset && offset < item.to
                : item.from === offset && css(item.color) === swatch);
        },
        add(layer: DecorationLayer, owner: Owner) {
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

export function mountSwatches(editor: TextEditor, provider: LspWorkspace, owner: Owner,
    activate?: (item: LspDocumentColor) => void) {
    const source = editor.workspace.observeDocument(editor.view.documentId);
    const layer = editor.decorations.add({ name: "document colors", order: 35 });
    const byDocument = scans.get(provider) ?? new WeakMap<Document, ReturnType<typeof scanDocument>>();
    scans.set(provider, byDocument);
    let group = byDocument.get(source);
    try { group ??= scanDocument(source, provider); } catch (error) { layer.dispose(); throw error; }
    byDocument.set(source, group);
    const events = new AbortController();
    group.add(layer, owner);
    if (activate) {
        editor.element.classList.add("st-interactive-swatches");
        const hit = (event: PointerEvent) => {
            const mark = event.target;
            if (!(mark instanceof HTMLElement) || !mark.classList.contains("st-color-swatch")) return;
            const point = editor.viewport.hitTest(event.clientX, event.clientY);
            if (point && point.revision === source.getSnapshot()?.revision) {
                return group.at(point.offset, mark.style.getPropertyValue("--st-swatch-color"));
            }
        };
        let press: { id: number; item: LspDocumentColor; x: number; y: number } | undefined;
        const options = { capture: true, signal: events.signal };
        editor.element.addEventListener("pointerdown", event => {
            press = undefined;
            if (!event.isPrimary || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            const item = hit(event);
            if (!item) return;
            press = { id: event.pointerId, item, x: event.clientX, y: event.clientY };
            event.preventDefault();
            event.stopPropagation();
        }, options);
        editor.element.addEventListener("pointerup", event => {
            const down = press;
            press = undefined;
            if (!down || event.pointerId !== down.id || hit(event) !== down.item
                || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;
            event.preventDefault();
            event.stopPropagation();
            activate(down.item);
        }, options);
        editor.element.addEventListener("pointercancel", () => { press = undefined; }, options);
    }
    return { at: group.at, accept: group.accept, clear: group.clear, dispose() {
        events.abort();
        if (activate) editor.element.classList.remove("st-interactive-swatches");
        group.remove(layer);
        layer.dispose();
    } };
}
