import type { Affinity, TabId, Workspace } from "../../src/index.ts";
import type { DocumentationContent, TextEditor } from "../../src/browser/index.ts";
import type { createHoverController } from "../shared/language/hover-controller.ts";
import type { HoverSnapshot } from "../shared/language/hover-controller.ts";
import { HostCell } from "../shared/observable.ts";
type Session = { id: string; editor: TextEditor; controller: ReturnType<typeof createHoverController>;
    affinity: Affinity; offset: number; overTarget: boolean; scheduled: boolean; cancelTimers: () => void };
export type HoverPresentation = Readonly<{ visible: boolean; view: string | null; left: number; top: number; status: HoverSnapshot["status"]; text: string; message: string; content?: DocumentationContent }>;
export type HoverControllerFactory = (workspace: Workspace, tab: TabId, editor: TextEditor, canCapture: () => boolean) => ReturnType<typeof createHoverController>;

/** Host-owned presentation follows an explicit view; pointer inspection never changes focus. */
export class HostHoverTools {
    private readonly workspace: Workspace;
    private readonly allowInspect: (kind: "pointer" | "keyboard") => boolean;
    private readonly createController: HoverControllerFactory;
    private readonly canCapture: (document: TextEditor["view"]["documentId"]) => boolean;
    private readonly sessions = new Map<string, Session>();
    private readonly cell = new HostCell<HoverPresentation>({ visible: false, view: null, left: 0, top: 0, status: "idle", text: "", message: "" });
    private current: Session | undefined;
    private kind: "pointer" | "keyboard" = "pointer";
    private overPopup = false;
    private cancelDismiss: (() => void) | undefined;
    private layout: { observer: MutationObserver; win: Window; frame: number | undefined } | undefined;
    private retired = { posted: 0, received: 0, stale: 0, invalid: 0, failed: 0, cancelled: 0 };
    readonly state = this.cell.observable;
    constructor(workspace: Workspace, allowInspect: (kind: "pointer" | "keyboard") => boolean = () => true,
        options: Readonly<{ createController: HoverControllerFactory; canCapture?: (document: TextEditor["view"]["documentId"]) => boolean }>) {
        this.workspace = workspace; this.allowInspect = allowInspect; this.createController = options.createController; this.canCapture = options.canCapture ?? (() => true);
    }
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
        const visible = state.status === "ready" || state.status === "failed" || (state.status === "pending" && this.kind === "keyboard");
        this.cell.set({ visible, view: session.id, status: state.status, text: state.text, message: state.message, ...(state.content ? { content: state.content } : {}), ...this.position(session) });
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
        if (this.sessions.get(session.id) !== session || !this.allowInspect(kind)) return false;
        this.dismiss(); this.current = session; this.kind = kind; session.affinity = affinity; session.offset = offset;
        const posted = session.controller.request(revision, offset); if (!posted) { this.current = undefined; this.publish(); } return posted;
    }
    inspectCaret(id: string): boolean {
        const session = this.sessions.get(id); if (!session) return false;
        session.editor.view.folding.revealSelection(session.editor.view.folding.getSnapshot()); session.editor.viewport.flush();
        const selected = session.editor.view.getSnapshot();
        return this.inspect(session, selected.revision, selected.selection.head, selected.selection.headAffinity ?? "after", "keyboard");
    }
    attach(id: string, tab: TabId, editor: TextEditor): () => void {
        if (this.sessions.has(id)) throw new Error("Hover view already mounted.");
        const controller = this.createController(this.workspace, tab, editor, () => this.canCapture(editor.view.documentId)), listeners = new AbortController(), win = editor.element.ownerDocument.defaultView!;
        let pointerTimer: number | undefined, chordTimer: number | undefined, chord = false, key: string | undefined;
        let requested: Readonly<{ revision: number; offset: number }> | undefined;
        const session: Session = { id, editor, controller, affinity: "after", offset: 0, overTarget: false, scheduled: false, cancelTimers: () => {} };
        const cancelDwell = () => { if (pointerTimer !== undefined) win.clearTimeout(pointerTimer); pointerTimer = undefined; session.scheduled = false; key = undefined; };
        const cancelPointer = () => { cancelDwell(); requested = undefined; };
        const cancelChord = () => { if (chordTimer !== undefined) win.clearTimeout(chordTimer); chordTimer = undefined; chord = false; };
        session.cancelTimers = () => { cancelPointer(); cancelChord(); };
        this.sessions.set(id, session);
        const stop = controller.state.subscribe(() => { if (this.current === session) this.publish(); });
        const pointerAt = (x: number, y: number) => {
            const viewport = editor.viewport.snapshot(); if (viewport.pending) return undefined;
            const point = editor.viewport.hitTest(x, y);
            return point && Math.abs(point.left - x) <= viewport.columnWidth * 1.5 && Math.abs(point.top + point.height / 2 - y) <= point.height ? point : undefined;
        };
        const sameTarget = (revision: number, offset: number) => {
            if (requested?.revision !== revision) return false;
            const state = controller.state.getSnapshot();
            if (requested.offset === offset && (state.status === "pending" || state.status === "ready" || state.status === "empty" || state.status === "failed")) return true;
            return state.status === "ready" && state.range !== null && state.range.from <= offset && offset < state.range.to;
        };
        editor.element.addEventListener("pointerenter", () => { session.overTarget = true; if (this.current === session) this.clearDismiss(); }, { signal: listeners.signal });
        editor.element.addEventListener("pointermove", event => {
            // Keyboard inspection owns the popup until dismissal or a captured-state change.
            // Browsers can deliver delayed pointer motion after a dialog or layout change.
            if (this.current && this.kind === "keyboard" && !event.buttons) { cancelPointer(); return; }
            if (!this.allowInspect("pointer")) { cancelPointer(); return; }
            if (event.buttons || editor.activity().composing) { cancelPointer(); if (this.current === session) this.dismiss(); return; }
            const x = event.clientX, y = event.clientY, pending = editor.viewport.activity().pending, point = pointerAt(x, y);
            if (!pending && !point) {
                cancelPointer(); if (this.current === session) this.dismiss(); return;
            }
            const revision = this.workspace.document(editor.view.documentId).revision;
            session.overTarget = true; if (this.current === session) this.clearDismiss();
            if (point && sameTarget(revision, point.offset)) { cancelDwell(); return; }
            const next = `${revision}:${point?.offset ?? `${x},${y}`}`;
            if (key === next) return; cancelDwell(); key = next; session.scheduled = true;
            // Decoration/focus changes can leave a frame pending when the pointer arrives.
            // Keep the existing dwell, then capture settled geometry once; never force a paint
            // from pointermove or retry indefinitely, and never follow a changed document.
            pointerTimer = win.setTimeout(() => {
                cancelDwell();
                const settled = pointerAt(x, y);
                if (settled?.revision === revision && !sameTarget(revision, settled.offset)
                    && this.inspect(session, revision, settled.offset, settled.affinity, "pointer")) requested = settled;
            }, 300);
        }, { signal: listeners.signal });
        editor.element.addEventListener("pointerleave", () => { cancelPointer(); session.overTarget = false; if (this.current === session) this.queueDismiss(session); }, { signal: listeners.signal });
        editor.element.addEventListener("pointerdown", () => { cancelPointer(); if (this.current === session) this.dismiss(); }, { signal: listeners.signal });
        editor.input.addEventListener("keydown", event => {
            if (event.isComposing || editor.activity().composing) return;
            if (["Control", "Meta", "Shift", "Alt"].includes(event.key)) return;
            if (event.key === "Escape" && (this.current || session.scheduled)) { event.preventDefault(); event.stopImmediatePropagation(); this.dismiss(); return; }
            const command = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey, name = event.key.toLowerCase();
            if (command && name === "k") { if (!this.allowInspect("keyboard")) return; event.preventDefault(); event.stopImmediatePropagation(); cancelChord(); chord = true; chordTimer = win.setTimeout(cancelChord, 1500); return; }
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
            if (detached) return; detached = true; if (this.current === session) this.dismiss(); session.cancelTimers(); listeners.abort(); stop();
            const counts = controller.snapshot(); for (const name of Object.keys(this.retired) as (keyof typeof this.retired)[]) this.retired[name] += counts[name];
            controller.dispose(); this.sessions.delete(id);
        };
    }
    setDelay(id: string, value: number): void { this.sessions.get(id)?.controller.setDelay(value); }
    faultNext(id: string, value: "malformed" | "failure" | "markup"): void { this.sessions.get(id)?.controller.faultNext(value); }
    debug() { return { presentation: this.cell.get(), subscriptions: this.cell.count(), layoutObserver: this.layout !== undefined, layoutFramePending: this.layout?.frame !== undefined, sessions: [...this.sessions.values()].map(session => ({ id: session.id, viewId: session.editor.view.id, counters: session.controller.snapshot() })), retired: { ...this.retired } }; }
}
