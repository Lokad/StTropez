import type { Affinity, TabId } from "../../src/index.ts";
import { detachWithEditor, scopedCommands } from "../shared/editor-attachment.ts";
import { createHoverController, observePointerDwell } from "../../src/browser/index.ts";
import type { DocumentationContent, HoverController, HoverDiagnostics, HoverSnapshot, TextEditor } from "../../src/browser/index.ts";
import type { LspScopeAccess, LspWorkspace } from "../../src/protocol/index.ts";
import { HostCell } from "../shared/observable.ts";
type Settings = { delay: number; fault?: "malformed" | "failure" | "markup" };
type Session = { id: string; editor: TextEditor; controller: HoverController; settings: Settings;
    revision: number; affinity: Affinity; offset: number; overTarget: boolean; cancelTimers: () => void };
export type HoverPresentation = Readonly<{ visible: boolean; view: string | null; status: HoverSnapshot["status"]; text: string; message: string; content?: DocumentationContent }>;
export type HoverHostOptions = Readonly<{ provider: LspWorkspace; diagnostics?: HoverDiagnostics;
    beforeRequest?: (session: LspScopeAccess, config: Settings) => Promise<unknown>;
    canCapture?: (document: TextEditor["view"]["documentId"]) => boolean }>;

/** Host-owned presentation follows an explicit view; pointer inspection never changes focus. */
export class HostHoverTools {
    private readonly allowInspect: (kind: "pointer" | "keyboard") => boolean;
    private readonly options: HoverHostOptions;
    private readonly canCapture: (document: TextEditor["view"]["documentId"]) => boolean;
    private readonly sessions = new Map<string, Session>();
    private readonly cell = new HostCell<HoverPresentation>({ visible: false, view: null, status: "idle", text: "", message: "" });
    private current: Session | undefined;
    private kind: "pointer" | "keyboard" = "pointer";
    private overPopup = false;
    private popup: HTMLElement | undefined;
    private cancelDismiss: (() => void) | undefined;
    private retired = { posted: 0, received: 0, stale: 0, invalid: 0, failed: 0, cancelled: 0 };
    readonly state = this.cell.observable;
    constructor(allowInspect: (kind: "pointer" | "keyboard") => boolean = () => true,
        options: HoverHostOptions) {
        this.allowInspect = allowInspect; this.options = options; this.canCapture = options.canCapture ?? (() => true);
    }
    private clearDismiss(): void { this.cancelDismiss?.(); this.cancelDismiss = undefined; }
    popupAnchor() {
        const session = this.current;
        if (!session || !this.cell.get().visible) return;
        const range = session.controller.getSnapshot().range;
        if (this.kind === "keyboard" && range) return { editor: session.editor, revision: session.revision, ...range };
        return { editor: session.editor, revision: session.revision, offset: session.offset, affinity: session.affinity };
    }
    private publish(): void {
        const session = this.current;
        if (!session) { this.cell.set({ ...this.cell.get(), visible: false, view: null, status: "idle", text: "", message: "" }); return; }
        const state = session.controller.getSnapshot();
        if (["expired", "empty", "disposed"].includes(state.status)) { this.current = undefined; this.overPopup = false; this.clearDismiss(); this.cell.set({ ...this.cell.get(), visible: false, view: null, status: state.status, text: "", message: state.message }); return; }
        const visible = state.status === "ready" || state.status === "failed" || (state.status === "pending" && this.kind === "keyboard");
        this.cell.set({ visible, view: session.id, status: state.status, text: state.text, message: state.message, ...(state.content ? { content: state.content } : {}) });
    }
    readonly dismiss = (): void => {
        this.clearDismiss(); for (const session of this.sessions.values()) session.cancelTimers();
        const current = this.current; this.current = undefined; this.overPopup = false; current?.controller.cancel(); this.publish();
    };
    private queueDismiss(session: Session): void {
        this.clearDismiss(); if (this.kind !== "pointer" || this.overPopup || session.overTarget || this.popup?.matches(":focus-within")) return;
        const win = session.editor.element.ownerDocument.defaultView!, id = win.setTimeout(() => { this.cancelDismiss = undefined;
            if (this.current === session && !this.overPopup && !session.overTarget && !this.popup?.matches(":focus-within")) this.dismiss(); }, 200);
        this.cancelDismiss = () => win.clearTimeout(id);
    }
    readonly enterPopup = (): void => { this.overPopup = true; this.clearDismiss(); };
    readonly leavePopup = (): void => { this.overPopup = false; if (this.current) this.queueDismiss(this.current); };
    bindPopup(popup: HTMLElement): () => void {
        this.popup = popup;
        return () => { if (this.popup === popup) this.popup = undefined; };
    }
    private inspect(session: Session, revision: number, offset: number, affinity: Affinity, kind: "pointer" | "keyboard"): boolean {
        if (this.sessions.get(session.id) !== session || !this.allowInspect(kind)) return false;
        const reuse = kind === "pointer" && this.kind === kind && this.current === session;
        if (!reuse) this.dismiss();
        this.current = session; this.kind = kind; session.revision = revision; session.affinity = affinity; session.offset = offset;
        const accepted = session.controller.request({ revision, offset, affinity }, reuse ? "reuse" : "refresh");
        if (!accepted) this.dismiss();
        return accepted;
    }
    inspectCaret(id: string): boolean {
        const session = this.sessions.get(id); if (!session) return false;
        const { editor } = session, selected = editor.view.getSnapshot();
        editor.viewport.revealOffset(selected.selection.head, { vertical: "nearest", horizontal: "nearest", affinity: selected.selection.headAffinity ?? "after" });
        editor.viewport.flush(); editor.element.scrollIntoView({ block: "nearest", inline: "nearest" });
        return this.inspect(session, selected.revision, selected.selection.head, selected.selection.headAffinity ?? "after", "keyboard");
    }
    attach(id: string, _tab: TabId, editor: TextEditor): () => void {
        if (this.sessions.has(id)) throw new Error("Hover view already mounted.");
        const settings: Settings = { delay: 0 }, { provider, diagnostics, beforeRequest } = this.options;
        const controller = createHoverController(editor, provider, { canCapture: () => this.canCapture(editor.view.documentId),
            ...(diagnostics && { diagnostics }), ...(beforeRequest && { prepareRequest: session => {
                const config = { ...settings }; delete settings.fault; return beforeRequest(session, config);
            } }) });
        const listeners = new AbortController(), win = editor.element.ownerDocument.defaultView!;
        const session: Session = { id, editor, controller, settings, revision: -1, affinity: "after", offset: 0, overTarget: false, cancelTimers: () => {} };
        const dwell = observePointerDwell(editor, point => this.inspect(session, point.revision, point.offset, point.affinity, "pointer"), {
            enabled: () => !(this.current && this.kind === "keyboard") && this.allowInspect("pointer"),
            onMiss: () => { if (this.current === session) this.dismiss(); } });
        listeners.signal.addEventListener("abort", dwell.dispose, { once: true });
        session.cancelTimers = dwell.cancel;
        try {
            const register = scopedCommands(editor, listeners.signal);
            register({ id: "hover.inspect", label: "Inspect type",
                enabled: () => this.canCapture(editor.view.documentId), run: () => this.inspectCaret(id) },
                { keys: ["Ctrl+k Ctrl+i", "Meta+k Meta+i"] });
            register({ id: "hover.dismiss", label: "Dismiss hover",
                enabled: () => (editor.getSnapshot().focused || !!this.popup?.matches(":focus-within"))
                    && (this.current === session || dwell.isPending()), run: () => {
                    if (this.current !== session) { dwell.cancel(); return false; }
                    const visible = this.cell.get().visible; this.dismiss(); return visible;
                } }, { keys: ["Escape"], priority: 20, shared: true });
        } catch (error) { listeners.abort(); controller.dispose(); throw error; }
        this.sessions.set(id, session);
        const stop = controller.subscribe(() => { if (this.current === session) this.publish(); });
        editor.element.addEventListener("pointerenter", () => { session.overTarget = true; if (this.current === session) this.clearDismiss(); }, { signal: listeners.signal });
        editor.element.addEventListener("pointerleave", () => { dwell.cancel(); session.overTarget = false; if (this.current === session) this.queueDismiss(session); }, { signal: listeners.signal });
        editor.element.addEventListener("pointerdown", () => { dwell.cancel(); if (this.current === session) this.dismiss(); }, { signal: listeners.signal });
        win.addEventListener("keydown", event => {
            if (event.key === "Escape" && this.current === session && this.kind === "pointer" && this.cell.get().visible
                && !event.defaultPrevented && !event.isComposing && event.keyCode !== 229 && !event.ctrlKey && !event.metaKey
                && !event.altKey && !event.shiftKey && !editor.element.matches(":focus-within") && !this.popup?.matches(":focus-within")) {
                // A pointer hover can belong to a pane that has never had keyboard focus.
                // Leave the key and focus with the user's active control.
                this.dismiss(); return;
            }
            if (event.key !== "Control" && event.key !== "Meta") return;
            if (this.popup?.matches(":focus-within")) return;
            dwell.cancel(); if (this.current === session && this.kind === "pointer") this.dismiss();
        }, { signal: listeners.signal });
        editor.element.addEventListener("focusout", event => {
            if (this.current === session && this.kind === "keyboard"
                && !(event.relatedTarget instanceof Node && this.popup?.contains(event.relatedTarget))) this.dismiss();
        }, { signal: listeners.signal });
        editor.onEditIntent(() => {
            dwell.cancel();
            if (this.current === session) this.dismiss();
        }, listeners.signal);
        const scroll = () => {
            if (this.current === session && this.kind === "pointer") this.dismiss();
        };
        editor.element.addEventListener("scroll", scroll, { capture: true, signal: listeners.signal });
        win.addEventListener("scroll", event => {
            const target = event.target;
            if (target !== win && target !== editor.element.ownerDocument && !(target instanceof Node && target.contains(editor.element))) return;
            scroll();
        }, { capture: true, signal: listeners.signal });
        win.addEventListener("resize", () => { dwell.cancel(); if (this.current === session) this.dismiss(); }, { signal: listeners.signal });
        return detachWithEditor(editor, listeners.signal, () => {
            if (this.sessions.get(id) !== session) return;
            this.sessions.delete(id);
            if (this.current === session) this.dismiss();
            session.cancelTimers(); listeners.abort(); stop();
            const counts = controller.getDiagnostics(); for (const name of Object.keys(this.retired) as (keyof typeof this.retired)[]) this.retired[name] += counts[name];
            controller.dispose();
        });
    }
    setDelay(id: string, value: number): void {
        if (!Number.isFinite(value) || value < 0 || value > 1000) throw new RangeError("Invalid hover delay.");
        const session = this.sessions.get(id); if (session) session.settings.delay = value;
    }
    faultNext(id: string, value: NonNullable<Settings["fault"]>): void { const session = this.sessions.get(id); if (session) session.settings.fault = value; }
    debug() { return { presentation: this.cell.get(), subscriptions: this.cell.count(), sessions: [...this.sessions.values()].map(session => ({ id: session.id, viewId: session.editor.view.id, counters: { ...session.controller.getDiagnostics(), transport: "lsp3.17" } })), retired: { ...this.retired } }; }
}
