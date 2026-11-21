import { clientBox } from "./dom-coordinates.ts";
import { isFocused } from "./dom-focus.ts";
import type { Affinity } from "../core/positions.ts";
import type { DocumentView, TabTarget, Workspace } from "../core/workspace.ts";
import type { SelectionSet } from "../core/selections.ts";
import { applyTextDrop, captureTextTransfer, isCurrentTextTransfer } from "./text-transfer.ts";
import type { TextTransferCapture } from "./text-transfer.ts";
import type { TextViewport } from "./viewport.ts";
import { createEdgeAutoscroll, edgeVelocity } from "./edge-autoscroll.ts";

const transferType = "application/x-sttropez-text";
type ActiveDrag = { token: string; owner: symbol; source?: TextTransferCapture };
const activeDrags = new WeakMap<Document, ActiveDrag>();

/** Native data-store bridge. Payloads are read at drop, never during protected dragover. */
export function mountTextDragDrop(options: Readonly<{ workspace: Workspace; tab: TabTarget; view: DocumentView; viewport: TextViewport;
    input: HTMLTextAreaElement; available: () => boolean; beforeStart: () => void;
    afterDrop: (offset: number) => void; rejected: (reason: string) => void }>) {
    const { workspace, tab, view, viewport, input } = options, root = viewport.element;
    const document = root.ownerDocument, win = document.defaultView!, owner = Symbol(), listeners = new AbortController();
    const apple = /Mac|iPhone|iPad|iPod/.test(win.navigator.platform);
    const marker = document.createElement("div"), preview = document.createElement("div");
    marker.className = "st-text-drop-caret"; marker.setAttribute("aria-hidden", "true");
    preview.className = "st-text-drag-preview"; preview.setAttribute("aria-hidden", "true");
    type Arm = Readonly<{ revision: number; selectionSet: SelectionSet; pointer: number; offset: number; affinity: Affinity }>;
    type Aim = Readonly<{ revision: number; offset: number; affinity: Affinity; token: string | null; copy: boolean; x: number; y: number }>;
    let armed: Arm | undefined, aim: Aim | undefined, previewFrame: number | undefined;
    let disposed = false, expired = false;
    function current() {
        if (disposed || !options.available() || !root.isConnected || !workspace.resolveTab(tab) || !workspace.ownsDocumentView(view)) return;
        return workspace.observeDocument(view.documentId).getSnapshot();
    }
    function clearAim(): void {
        aim = undefined; marker.remove();
        scrolling.stop();
    }
    function clearArm(): void { armed = undefined; root.draggable = false; }
    function clearPreview(): void {
        if (previewFrame !== undefined) win.cancelAnimationFrame(previewFrame); previewFrame = undefined;
        preview.remove(); preview.textContent = "";
    }
    function invalidateSource(): void {
        const active = activeDrags.get(document);
        // Keep the opaque token as a tombstone until dragend/drop; a stale internal drag
        // must never fall through to an external-text copy. Release model references now.
        if (active?.owner === owner && active.source && (!current() || !isCurrentTextTransfer(active.source))) {
            delete active.source; clearPreview();
        }
    }
    function changed(): void {
        invalidateSource(); const state = current();
        if (armed && (!state || state.revision !== armed.revision || view.getSnapshot().selectionSet !== armed.selectionSet)) clearArm();
        if (aim && (!state || input.readOnly || state.revision !== aim.revision)) { expired = true; clearAim(); }
    }
    function finish(): void {
        if (activeDrags.get(document)?.owner === owner) activeDrags.delete(document);
        const returnFocus = root.draggable && isFocused(root) && current();
        clearArm(); clearAim(); expired = false; clearPreview();
        if (returnFocus) input.focus({ preventScroll: true });
    }
    function accepts(data: DataTransfer | null): data is DataTransfer {
        return !!data && (data.types.includes(transferType) || data.types.includes("text/plain"));
    }
    const allows = (data: DataTransfer, copy: boolean) => data.effectAllowed === "all" || data.effectAllowed === "uninitialized"
        || (copy ? ["copy", "copyLink", "copyMove"] : ["move", "linkMove", "copyMove"]).includes(data.effectAllowed);
    function paint(): void {
        if (!aim) return;
        const point = viewport.coordsAt(aim.offset, aim.affinity), box = clientBox(root);
        if (!point || point.revision !== aim.revision) { marker.remove(); return; }
        marker.style.left = `${root.scrollLeft + (point.left - box.left) / box.zoom}px`;
        marker.style.top = `${root.scrollTop + (point.top - box.top) / box.zoom}px`; marker.style.height = `${point.height / box.zoom}px`; root.append(marker);
    }
    const scrolling = createEdgeAutoscroll(win, viewport, {
        capture: () => aim,
        valid: captured => {
            const state = current(); invalidateSource();
            if (!state || state.revision !== captured.revision || input.readOnly || expired
                || captured.token !== null && !activeDrags.get(document)?.source) return false;
            const hit = document.elementFromPoint(captured.x, captured.y); return !!hit && root.contains(hit);
        },
        velocity: captured => edgeVelocity(captured, clientBox(root, viewport.minimap()), viewport.snapshot(), "inside"),
        update: captured => {
            const point = viewport.hitTest(captured.x, captured.y);
            if (aim !== captured) return;
            if (point) aim = { ...captured, offset: point.offset, affinity: point.affinity }; paint();
        },
        cancel: clearAim, updateAtRest: true, recheckAfterUpdate: true,
    });
    root.addEventListener("dragstart", event => {
        const intent = armed;
        if (!intent || event.target === input || !event.dataTransfer || current()?.revision !== intent.revision || view.getSnapshot().selectionSet !== intent.selectionSet) {
            event.preventDefault(); clearArm(); return;
        }
        options.beforeStart(); const captured = captureTextTransfer(workspace, tab, view);
        const source = captured && input.readOnly ? Object.freeze({ ...captured, moveAllowed: false }) : captured;
        if (!source || source.revision !== intent.revision || source.selectionSet !== intent.selectionSet) { event.preventDefault(); clearArm(); return; }
        const token = win.crypto.randomUUID(); activeDrags.set(document, { token, owner, source }); armed = undefined;
        event.dataTransfer.setData("text/plain", source.text); event.dataTransfer.setData(transferType, token);
        event.dataTransfer.effectAllowed = source.moveAllowed ? "copyMove" : "copy";
        preview.textContent = source.text.slice(0, 160) + (source.text.length > 160 ? "…" : ""); root.append(preview);
        event.dataTransfer.setDragImage(preview, 8, 8);
        // The browser captures the drag image after dragstart; its source need not stay painted.
        previewFrame = win.requestAnimationFrame(clearPreview);
    }, { signal: listeners.signal });
    root.addEventListener("dragenter", event => {
        if (accepts(event.dataTransfer) && current() && !input.readOnly && !expired) event.preventDefault();
    }, { signal: listeners.signal });
    root.addEventListener("dragover", event => {
        const data = event.dataTransfer, state = current(); invalidateSource();
        if (!accepts(data) || !state || input.readOnly || expired) { clearAim(); return; }
        const internal = data.types.includes(transferType), active = activeDrags.get(document);
        // A transport that strips our token must not silently turn an intended move into
        // an unrelated external copy. Keep the captured source intact and refuse the drop.
        if (active && !internal) { data.dropEffect = "none"; clearAim(); return; }
        if (internal && (!active?.source || !isCurrentTextTransfer(active.source))) { data.dropEffect = "none"; clearAim(); return; }
        if (aim && aim.revision !== state.revision) { expired = true; clearAim(); return; }
        const copy = !active?.source || active.source.workspace !== workspace || !active.source.moveAllowed || (apple ? event.altKey : event.ctrlKey);
        if (!allows(data, copy)) { data.dropEffect = "none"; clearAim(); return; }
        viewport.flush(); const point = viewport.hitTest(event.clientX, event.clientY);
        if (!point || point.revision !== state.revision) { clearAim(); return; }
        event.preventDefault(); data.dropEffect = copy ? "copy" : "move";
        aim = { revision: state.revision, offset: point.offset, affinity: point.affinity, token: active?.token ?? null, copy, x: event.clientX, y: event.clientY };
        paint(); scrolling.schedule();
    }, { signal: listeners.signal });
    root.addEventListener("dragleave", event => {
        if (!(event.relatedTarget instanceof win.Node) || !root.contains(event.relatedTarget)) clearAim();
    }, { signal: listeners.signal });
    root.addEventListener("drop", event => {
        // Refuse default text-control insertion and file/URL navigation, even for unsupported data.
        event.preventDefault(); const captured = aim, data = event.dataTransfer, state = current();
        let source: TextTransferCapture | undefined;
        try {
            if (!captured || !accepts(data) || !state || input.readOnly || expired || state.revision !== captured.revision) return;
            if (captured.token !== null || data.types.includes(transferType)) {
                const active = activeDrags.get(document);
                if (!active?.source || active.token !== captured.token || data.getData(transferType) !== captured.token) { options.rejected("stale-drag-source"); return; }
                source = active.source;
            }
            options.beforeStart();
            const result = applyTextDrop({ workspace, tab, view, expectedRevision: captured.revision, offset: captured.offset,
                ...(source ? { source } : { text: data.getData("text/plain") }), copy: captured.copy });
            if (!result.applied) options.rejected(result.reason);
            else if (result.offset !== null) options.afterDrop(result.offset);
        } finally {
            activeDrags.delete(document); finish();
            document.dispatchEvent(new Event("sttropez-text-drag-end"));
        }
    }, { signal: listeners.signal });
    document.addEventListener("pointerup", event => {
        const intent = armed; if (!intent || intent.pointer !== event.pointerId) return; clearArm();
        if (current()?.revision !== intent.revision || view.getSnapshot().selectionSet !== intent.selectionSet) return;
        options.beforeStart(); view.setSelection(intent.revision, { anchor: intent.offset, head: intent.offset, anchorAffinity: intent.affinity, headAffinity: intent.affinity }); input.focus({ preventScroll: true });
    }, { signal: listeners.signal });
    document.addEventListener("pointercancel", event => { if (armed?.pointer === event.pointerId) clearArm(); }, { signal: listeners.signal });
    document.addEventListener("dragend", finish, { signal: listeners.signal });
    document.addEventListener("sttropez-text-drag-end", finish, { signal: listeners.signal });
    document.addEventListener("keydown", event => { if (event.key === "Escape") finish(); }, { signal: listeners.signal });
    win.addEventListener("pagehide", finish, { signal: listeners.signal });
    const resource = workspace.resourceForDocument(view.documentId);
    const subscriptions = [workspace.observeDocument(view.documentId).subscribe(changed), view.subscribe(changed), resource.metadata.subscribe(changed), workspace.tabState.subscribe(changed)];
    return Object.freeze({
        disarm: clearArm,
        arm: (event: PointerEvent): boolean => {
            clearArm(); const state = current();
            if (!state || event.button !== 0 || event.pointerType && event.pointerType !== "mouse" || event.altKey || event.shiftKey || event.target === input || !(event.target instanceof win.Element)
                || !event.target.closest(".st-viewport-selected")) return false;
            const point = viewport.hitTest(event.clientX, event.clientY), set = view.getSnapshot().selectionSet;
            if (!point || !set.ranges.some(range => range.anchor !== range.head && point.offset >= Math.min(range.anchor, range.head) && point.offset <= Math.max(range.anchor, range.head))) return false;
            armed = { revision: state.revision, selectionSet: set, pointer: event.pointerId, offset: point.offset, affinity: point.affinity }; root.draggable = true; return true;
        },
        dispose: () => { if (disposed) return; disposed = true; invalidateSource(); finish(); listeners.abort(); subscriptions.forEach(unsubscribe => unsubscribe()); },
    });
}
