import type { DocumentSnapshot, Observable } from "../../src/index.ts";
import type { DecorationLayer, InlineDecoration, TextEditor } from "../../src/browser/index.ts";
import { createLspColorClient, type LspDocumentColor, type LspWorkspace } from "../../src/protocol/index.ts";
import { rgbaColor } from "../../fixtures/language/colors.ts";

/** The panes share one provider scan per document. Painted ranges map through edits while it runs. */
export function watchColorSwatches(document: Observable<DocumentSnapshot | undefined>, provider: LspWorkspace, enabled: boolean) {
    const layers = new Set<DecorationLayer>();
    let previous: DocumentSnapshot | undefined, connection: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined, request: ReturnType<typeof createLspColorClient> | undefined;
    let painted: { revision: number; colors: readonly LspDocumentColor[]; ranges: readonly InlineDecoration[] } | undefined;
    function cancel() {
        clearTimeout(timer); timer = undefined;
        const retired = request; request = undefined;
        if (retired) queueMicrotask(retired.dispose);
    }
    function clear() {
        cancel(); painted = undefined;
        for (const layer of layers) layer.clear();
    }
    function accept(revision: number, items: readonly LspDocumentColor[]) {
        if (document.getSnapshot()?.revision !== revision) return;
        cancel();
        const colors = items.map(({ from, to, color }) => ({ from, to, color }));
        const ranges = colors.map(c => ({ from: c.from, to: c.to, className: "st-document-color", before: "host-inline-swatch",
            properties: { "--swatch-color": rgbaColor(c.color) } }));
        painted = { revision, colors, ranges };
        for (const layer of layers) layer.set(revision, ranges);
    }
    async function scan() {
        timer = undefined;
        const doc = document.getSnapshot();
        if (!layers.size || !enabled || !doc) return;
        if (!provider.queryFeatureOptions("textDocument/documentColor", doc).length) { clear(); return; }
        const client = createLspColorClient(provider); request = client;
        try {
            const reply = await client.run({ document: doc }).result;
            if (request === client && reply.isCurrent()) accept(doc.revision, reply.items);
        } catch { if (request === client) clear(); }
        finally { if (request === client) request = undefined; client.dispose(); }
    }
    function schedule() {
        const doc = document.getSnapshot(), state = provider.getSnapshot();
        const next = `${state.phase}:${state.epoch}:${state.registrationVersion("textDocument/documentColor")}`;
        if (doc?.revision === previous?.revision && doc?.language === previous?.language && next === connection) return;
        const available = enabled && doc?.key.variant === "working" && state.phase === "ready";
        if (next !== connection || !available) clear(); else cancel();
        previous = doc; connection = next;
        if (available) timer = setTimeout(() => void scan(), 200);
    }
    const stopDocument = document.subscribe(schedule), stopProvider = provider.subscribe(schedule);
    return {
        add(layer: DecorationLayer) { layers.add(layer); if (painted) layer.set(painted.revision, painted.ranges); schedule(); },
        remove(layer: DecorationLayer) { layers.delete(layer); if (!layers.size) { stopDocument(); stopProvider(); clear(); } },
        setEnabled(value: boolean) { if (value !== enabled) { enabled = value; connection = undefined; schedule(); } },
        resume() { if (document.getSnapshot()?.revision !== painted?.revision) { previous = undefined; schedule(); } },
        cancel, clear, accept, current: () => painted,
    };
}

export function bindSwatchPicker(editor: TextEditor, swatches: ReturnType<typeof watchColorSwatches>,
    open: (item: LspDocumentColor) => void, signal: AbortSignal) {
    const hit = (event: PointerEvent) => {
        const mark = event.target;
        if (!(mark instanceof HTMLElement) || !mark.matches(".host-inline-swatch")) return;
        const painted = swatches.current(), point = editor.viewport.hitTest(event.clientX, event.clientY);
        if (!painted || !point || point.revision !== painted.revision) return;
        const css = mark.style.getPropertyValue("--swatch-color");
        return painted.colors.find(item => item.from === point.offset && rgbaColor(item.color) === css);
    };
    let press: { id: number; item: LspDocumentColor; x: number; y: number } | undefined;
    const options = { capture: true, signal };
    editor.element.addEventListener("pointerdown", event => {
        press = undefined;
        if (!event.isPrimary || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        const item = hit(event); if (!item) return;
        press = { id: event.pointerId, item, x: event.clientX, y: event.clientY };
        event.preventDefault(); event.stopPropagation();
    }, options);
    editor.element.addEventListener("pointerup", event => {
        const down = press; press = undefined;
        if (!down || down.id !== event.pointerId || hit(event) !== down.item || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;
        event.preventDefault(); event.stopPropagation(); open(down.item);
    }, options);
    editor.element.addEventListener("pointercancel", () => { press = undefined; }, options);
}
