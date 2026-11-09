import type { Affinity, TabId, Workspace } from "../../src/index.ts";
import type { EditingCandidate } from "../../src/browser/index.ts";
import { createHoverController } from "../editing/hover-controller.ts";
import type { HoverSnapshot } from "../editing/hover-controller.ts";
import { HostCell } from "../shared/observable.ts";
type Session = { id: string; tooltipId: string; editor: EditingCandidate; controller: ReturnType<typeof createHoverController>;
    affinity: Affinity; offset: number; overTarget: boolean; scheduled: boolean; cancelTimers: () => void };
export type HoverPresentation = Readonly<{ visible: boolean; id: string; view: string | null; left: number; top: number; status: HoverSnapshot["status"]; text: string; message: string }>;
let nextTooltip = 0;

/** Host-owned presentation follows an explicit view; pointer inspection never changes focus. */
export class HostHoverTools {
    private readonly workspace: Workspace;
    private readonly sessions = new Map<string, Session>();
    private readonly cell = new HostCell<HoverPresentation>({ visible: false, id: "", view: null, left: 0, top: 0, status: "idle", text: "", message: "" });
    private current: Session | undefined;
    private kind: "pointer" | "keyboard" = "pointer";
    private overPopup = false;
    private cancelDismiss: (() => void) | undefined;
    private layout: { observer: MutationObserver; win: Window; frame: number | undefined } | undefined;
    private retired = { created: 0, posted: 0, received: 0, stale: 0, invalid: 0, failed: 0, cancelled: 0, postedUnits: 0 };
    readonly state = this.cell.observable;
    constructor(workspace: Workspace) { this.workspace = workspace; }
    private clearDismiss(): void { this.cancelDismiss?.(); this.cancelDismiss = undefined; }
    private stopLayout(): void {
        const layout = this.layout; this.layout = undefined; layout?.observer.disconnect();
        if (layout?.frame !== undefined) layout.win.cancelAnimationFrame(layout.frame);
    }
    private position(session: Session): Readonly<{ left: number; top: number }> {
        const win = session.editor.element.ownerDocument.defaultView!, point = session.editor.viewport.coordsAt(session.offset, session.affinity), box = session.editor.element.getBoundingClientRect();
        const at = point ?? { left: box.left + 12, top: box.top + 8, height: 20 };
        return { left: Math.max(8, Math.min(win.innerWidth - 352, at.left + 10)), top: Math.max(8, Math.min(win.innerHeight - 160, at.top + at.height + 8)) };
    }
    private trackLayout(session: Session): void {
        if (this.layout) return;
        const win = session.editor.element.ownerDocument.defaultView!, root = session.editor.element.closest("#host") ?? session.editor.element.ownerDocument.body;
        const layout = { observer: new MutationObserver(() => {
            if (this.layout !== layout || layout.frame !== undefined) return;
            layout.frame = win.requestAnimationFrame(() => {
                layout.frame = undefined; if (this.layout !== layout || this.current !== session || !this.cell.get().visible) return;
                if (!session.editor.element.isConnected) { this.dismiss(); return; }
                const position = this.position(session), state = this.cell.get();
                if (position.left !== state.left || position.top !== state.top) this.cell.set({ ...state, ...position });
            });
        }), win, frame: undefined as number | undefined };
        this.layout = layout; layout.observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
    }
    private publish(): void {
        const session = this.current;
        if (!session) { this.stopLayout(); this.cell.set({ ...this.cell.get(), visible: false, view: null, status: "idle", text: "", message: "" }); return; }
        const state = session.controller.state.getSnapshot();
        if (["expired", "empty", "disconnected", "disposed"].includes(state.status)) { this.current = undefined; this.overPopup = false; this.clearDismiss(); this.stopLayout(); this.cell.set({ ...this.cell.get(), visible: false, view: null, status: state.status, text: "", message: state.message }); return; }
        const visible = ["pending", "ready", "failed"].includes(state.status);
        this.cell.set({ visible, id: session.tooltipId, view: session.id, status: state.status, text: state.text, message: state.message, ...this.position(session) });
        if (visible) this.trackLayout(session); else this.stopLayout();
    }
    readonly dismiss = (): void => {
        this.clearDismiss(); for (const session of this.sessions.values()) session.cancelTimers();
        const current = this.current; this.current = undefined; this.overPopup = false; current?.controller.cancel(); this.publish();
    };
    private queueDismiss(session: Session): void {
        this.clearDismiss(); if (this.kind !== "pointer" || this.overPopup || session.overTarget) return;
        const win = session.editor.element.ownerDocument.defaultView!, id = win.setTimeout(() => { this.cancelDismiss = undefined;
            if (this.current === session && !this.overPopup && !session.overTarget) this.dismiss(); }, 200);
        this.cancelDismiss = () => win.clearTimeout(id);
    }
    readonly enterPopup = (): void => { this.overPopup = true; this.clearDismiss(); };
    readonly leavePopup = (): void => { this.overPopup = false; if (this.current) this.queueDismiss(this.current); };
    private inspect(session: Session, revision: number, offset: number, affinity: Affinity, kind: "pointer" | "keyboard"): boolean {
        if (this.sessions.get(session.id) !== session) return false;
        this.dismiss(); this.current = session; this.kind = kind; session.affinity = affinity; session.offset = offset;
        const posted = session.controller.request(revision, offset); if (!posted) { this.current = undefined; this.publish(); } return posted;
    }
    inspectCaret(id: string): boolean {
        const session = this.sessions.get(id); if (!session) return false;
        const selected = session.editor.view.getSnapshot();
        return this.inspect(session, selected.revision, selected.selection.head, selected.selection.headAffinity ?? "after", "keyboard");
    }
    attach(id: string, tab: TabId, editor: EditingCandidate): () => void {
        if (this.sessions.has(id)) throw new Error("Hover view already mounted.");
        const controller = createHoverController(this.workspace, tab, editor), listeners = new AbortController(), win = editor.element.ownerDocument.defaultView!;
        let pointerTimer: number | undefined, chordTimer: number | undefined, chord = false, key: string | undefined;
        const session: Session = { id, tooltipId: `host-symbol-info-${++nextTooltip}`, editor, controller, affinity: "after", offset: 0, overTarget: false, scheduled: false, cancelTimers: () => {} };
        const cancelPointer = () => { if (pointerTimer !== undefined) win.clearTimeout(pointerTimer); pointerTimer = undefined; session.scheduled = false; key = undefined; };
        const cancelChord = () => { if (chordTimer !== undefined) win.clearTimeout(chordTimer); chordTimer = undefined; chord = false; };
        session.cancelTimers = () => { cancelPointer(); cancelChord(); };
        this.sessions.set(id, session); const stopDescription = editor.describe(session.tooltipId);
        const stop = controller.state.subscribe(() => { if (this.current === session) this.publish(); });
        editor.element.addEventListener("pointerenter", () => { session.overTarget = true; if (this.current === session) this.clearDismiss(); }, { signal: listeners.signal });
        editor.element.addEventListener("pointermove", event => {
            if (event.buttons || editor.snapshot().composing) { cancelPointer(); if (this.current === session) this.dismiss(); return; }
            const point = editor.viewport.hitTest(event.clientX, event.clientY), viewport = editor.viewport.snapshot();
            if (!point || viewport.pending || Math.abs(point.left - event.clientX) > viewport.columnWidth * 1.5 || Math.abs(point.top + point.height / 2 - event.clientY) > point.height) {
                cancelPointer(); if (this.current === session) this.dismiss(); return;
            }
            session.overTarget = true; if (this.current === session) this.clearDismiss(); const next = `${point.revision}:${point.offset}`;
            if (key === next) return; cancelPointer(); key = next; session.scheduled = true;
            pointerTimer = win.setTimeout(() => { pointerTimer = undefined; session.scheduled = false; this.inspect(session, point.revision, point.offset, point.affinity, "pointer"); }, 300);
        }, { signal: listeners.signal });
        editor.element.addEventListener("pointerleave", () => { cancelPointer(); session.overTarget = false; if (this.current === session) this.queueDismiss(session); }, { signal: listeners.signal });
        editor.element.addEventListener("pointerdown", () => { cancelPointer(); if (this.current === session) this.dismiss(); }, { signal: listeners.signal });
        editor.input.addEventListener("keydown", event => {
            if (event.isComposing || editor.snapshot().composing) return;
            if (["Control", "Meta", "Shift", "Alt"].includes(event.key)) return;
            if (event.key === "Escape" && (this.current || session.scheduled)) { event.preventDefault(); event.stopImmediatePropagation(); this.dismiss(); return; }
            const command = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey, name = event.key.toLowerCase();
            if (command && name === "k") { event.preventDefault(); event.stopImmediatePropagation(); cancelChord(); chord = true; chordTimer = win.setTimeout(cancelChord, 1500); return; }
            if (chord) { cancelChord(); if (command && name === "i") { event.preventDefault(); event.stopImmediatePropagation(); this.inspectCaret(id); } }
        }, { capture: true, signal: listeners.signal });
        editor.input.addEventListener("blur", () => { cancelChord(); if (this.current === session && this.kind === "keyboard") this.dismiss(); }, { signal: listeners.signal });
        editor.input.addEventListener("compositionstart", () => { session.cancelTimers(); if (this.current === session) this.dismiss(); }, { signal: listeners.signal });
        editor.input.addEventListener("beforeinput", () => { cancelPointer(); if (this.current === session) this.dismiss(); }, { signal: listeners.signal });
        editor.element.addEventListener("scroll", () => { cancelPointer(); if (this.current === session) this.dismiss(); }, { capture: true, signal: listeners.signal });
        win.addEventListener("scroll", event => {
            const target = event.target;
            if (target !== win && target !== editor.element.ownerDocument && !(target instanceof Node && target.contains(editor.element))) return;
            cancelPointer(); if (this.current === session) this.dismiss();
        }, { capture: true, signal: listeners.signal });
        win.addEventListener("resize", () => { cancelPointer(); if (this.current === session) this.dismiss(); }, { signal: listeners.signal });
        let detached = false;
        return () => {
            if (detached) return; detached = true; if (this.current === session) this.dismiss(); session.cancelTimers(); listeners.abort(); stop(); stopDescription();
            const counts = controller.snapshot(); for (const name of Object.keys(this.retired) as (keyof typeof this.retired)[]) this.retired[name] += counts[name];
            controller.destroy(); this.sessions.delete(id);
        };
    }
    setDelay(id: string, value: number): void { this.sessions.get(id)?.controller.setDelay(value); }
    faultNext(id: string, value: "malformed" | "failure" | "markup"): void { this.sessions.get(id)?.controller.faultNext(value); }
    debug() { return { presentation: this.cell.get(), subscriptions: this.cell.count(), layoutObserver: this.layout !== undefined, layoutFramePending: this.layout?.frame !== undefined, sessions: [...this.sessions.values()].map(session => ({ id: session.id, viewId: session.editor.view.id, counters: session.controller.snapshot() })), retired: { ...this.retired } }; }
}
