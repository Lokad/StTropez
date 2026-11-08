import type { Affinity, DocumentView, SelectionSet, TabTarget, Workspace } from "../index.ts";
import { applyTextDrop, captureTextTransfer, isCurrentTextTransfer } from "./text-transfer.ts";
import type { TextTransferCapture } from "./text-transfer.ts";
import type { TextViewport } from "./viewport.ts";

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
    let armed: Arm | undefined, aim: Aim | undefined, frame: number | undefined, previousTime: number | undefined;
    let disposed = false, expired = false;
    function current() {
        if (disposed || !options.available() || !root.isConnected || !workspace.resolveTab(tab) || !workspace.ownsDocumentView(view)) return;
        return workspace.observeDocument(view.documentId).getSnapshot();
    }
    function clearAim(): void {
        aim = undefined; marker.remove();
        if (frame !== undefined) win.cancelAnimationFrame(frame); frame = undefined; previousTime = undefined;
    }
    function clearArm(): void { armed = undefined; root.draggable = false; }
    function invalidateSource(): void {
        const active = activeDrags.get(document);
        // Keep the opaque token as a tombstone until dragend/drop; a stale internal drag
        // must never fall through to an external-text copy. Release model references now.
        if (active?.owner === owner && active.source && (!current() || !isCurrentTextTransfer(active.source))) {
            delete active.source; preview.remove(); preview.textContent = "";
        }
    }
    function changed(): void {
        invalidateSource(); const state = current();
        if (armed && (!state || state.revision !== armed.revision || view.getSnapshot().selectionSet !== armed.selectionSet)) clearArm();
        if (aim && (!state || input.readOnly || state.revision !== aim.revision)) { expired = true; clearAim(); }
    }
    function finish(): void {
        if (activeDrags.get(document)?.owner === owner) activeDrags.delete(document);
        clearArm(); clearAim(); expired = false; preview.remove(); preview.textContent = "";
    }
    function accepts(data: DataTransfer | null): data is DataTransfer {
        return !!data && (data.types.includes(transferType) || data.types.includes("text/plain"));
    }
    const allows = (data: DataTransfer, copy: boolean) => data.effectAllowed === "all" || data.effectAllowed === "uninitialized"
        || (copy ? ["copy", "copyLink", "copyMove"] : ["move", "linkMove", "copyMove"]).includes(data.effectAllowed);
    function paint(): void {
        if (!aim) return;
        const point = viewport.coordsAt(aim.offset, aim.affinity), box = root.getBoundingClientRect();
        if (!point || point.revision !== aim.revision) { marker.remove(); return; }
        marker.style.left = `${root.scrollLeft + point.left - box.left}px`;
        marker.style.top = `${root.scrollTop + point.top - box.top}px`; marker.style.height = `${point.height}px`; root.append(marker);
    }
    function bounds() {
        const box = root.getBoundingClientRect(), left = box.left + root.clientLeft, top = box.top + root.clientTop;
        return { left, right: left + root.clientWidth, top, bottom: top + root.clientHeight };
    }
    function velocity() {
        if (!aim) return { x: 0, y: 0 }; const box = bounds(), metrics = viewport.snapshot();
        const speed = (point: number, low: number, high: number, unit: number) => {
            const zone = Math.min(24, (high - low) / 4), distance = point < low + zone ? point - low - zone : point >= high - zone ? point - high + zone : 0;
            return Math.sign(distance) * Math.min((high - low) * 3, Math.max(unit * 5, Math.abs(distance) * 20));
        };
        return { x: speed(aim.x, box.left, box.right, metrics.columnWidth), y: speed(aim.y, box.top, box.bottom, metrics.lineHeight) };
    }
    function scheduleScroll(): void {
        const speed = velocity();
        if (!speed.x && !speed.y) { if (frame !== undefined) win.cancelAnimationFrame(frame); frame = undefined; previousTime = undefined; }
        else if (frame === undefined) frame = win.requestAnimationFrame(scroll);
    }
    function scroll(time: number): void {
        frame = undefined; const captured = aim, state = current(); invalidateSource();
        if (!captured || !state || state.revision !== captured.revision || input.readOnly || expired
            || captured.token !== null && !activeDrags.get(document)?.source) { clearAim(); return; }
        const hit = document.elementFromPoint(captured.x, captured.y);
        if (!hit || !root.contains(hit)) { clearAim(); return; }
        const speed = velocity(), elapsed = previousTime === undefined ? 1000 / 60 : Math.max(0, Math.min(32, time - previousTime)); previousTime = time;
        const before = viewport.snapshot();
        viewport.scrollTo({ left: before.scrollLeft + speed.x * elapsed / 1000, top: before.scrollTop + speed.y * elapsed / 1000 }); viewport.flush();
        if (aim !== captured || current()?.revision !== captured.revision) { clearAim(); return; }
        const point = viewport.hitTest(captured.x, captured.y);
        if (point) aim = { ...captured, offset: point.offset, affinity: point.affinity }; paint();
        const after = viewport.snapshot();
        if (after.scrollLeft !== before.scrollLeft || after.scrollTop !== before.scrollTop) scheduleScroll(); else previousTime = undefined;
    }
    root.addEventListener("dragstart", event => {
        const intent = armed;
        if (!intent || event.target === input || !event.dataTransfer || current()?.revision !== intent.revision || view.getSnapshot().selectionSet !== intent.selectionSet) {
            event.preventDefault(); clearArm(); return;
        }
        options.beforeStart(); const source = captureTextTransfer(workspace, tab, view);
        if (!source || source.revision !== intent.revision || source.selectionSet !== intent.selectionSet) { event.preventDefault(); clearArm(); return; }
        const token = win.crypto.randomUUID(); activeDrags.set(document, { token, owner, source }); armed = undefined;
        event.dataTransfer.setData("text/plain", source.text); event.dataTransfer.setData(transferType, token);
        event.dataTransfer.effectAllowed = source.moveAllowed ? "copyMove" : "copy";
        preview.textContent = source.text.slice(0, 160) + (source.text.length > 160 ? "…" : ""); root.append(preview);
        event.dataTransfer.setDragImage(preview, 8, 8);
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
        paint(); scheduleScroll();
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
        arm: (event: PointerEvent): boolean => {
            clearArm(); const state = current();
            if (!state || event.button !== 0 || event.pointerType && event.pointerType !== "mouse" || event.altKey || event.shiftKey || event.target === input || !(event.target instanceof win.Element)
                || !event.target.closest(".st-viewport-selected")) return false;
            const point = viewport.hitTest(event.clientX, event.clientY), set = view.getSnapshot().selectionSet;
            if (!point || !set.ranges.some(range => range.anchor !== range.head && point.offset >= Math.min(range.anchor, range.head) && point.offset <= Math.max(range.anchor, range.head))) return false;
            armed = { revision: state.revision, selectionSet: set, pointer: event.pointerId, offset: point.offset, affinity: point.affinity }; root.draggable = true; return true;
        },
        destroy: () => { if (disposed) return; disposed = true; invalidateSource(); finish(); listeners.abort(); subscriptions.forEach(unsubscribe => unsubscribe()); },
    });
}
