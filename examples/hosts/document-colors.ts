import { onSourceFocus } from "./source-focus.ts";
import type { DocumentId, TabId, Workspace } from "../../src/index.ts";
import { createDocumentColorController } from "../../src/browser/index.ts";
import type { ColorPresentationReview, DecorationLayer, DocumentColorChoice, DocumentColorController, TextEditor } from "../../src/browser/index.ts";
import type { LspPrepare, LspWorkspace } from "../../src/protocol/index.ts";
import { colorLimits, parseColor, rgbaColor } from "../../fixtures/language/colors.ts";
import type { ColorFault, ColorReference } from "../../fixtures/language/colors.ts";
import { HostCell } from "../shared/observable.ts";

export type ColorHostOptions = Readonly<{ provider: LspWorkspace;
    prepare: (kind: "discovery" | "presentation", delay: number, fault?: ColorFault) => LspPrepare }>;
type Session = { id: string; editor: TextEditor; controller: DocumentColorController; layer: DecorationLayer; detach: () => void; painted?: readonly DocumentColorChoice[] };
export type ColorNote = ColorReference & Readonly<{ ordinal: number; line: number; column: number; css: string; inspect: () => void }>;
export type ColorEditNote = Readonly<{ document: string; resource: string; title: string; revision: number; from: number; to: number; insert: string; context: string }>;
export type DocumentColorsSnapshot = Readonly<{ available: boolean; connected: boolean; disconnected: boolean; pending: boolean; view: string | null;
    status: "idle" | "scan" | "colors" | "presentations" | "applied" | "expired" | "failed"; message: string; count: number; page: number; colors: readonly ColorNote[];
    selected: number; value: string; css: string | null; presentation: string; choices: readonly Readonly<{ id: string; label: string; select: () => void }>[];
    edits: readonly ColorEditNote[]; canPreview: boolean; canApply: boolean; reviewKey: number | null; apply: (() => boolean) | null; changed: Readonly<{ document: DocumentId; title: string }> | null }>;
const initial: DocumentColorsSnapshot = { available: false, connected: false, disconnected: false, pending: false, view: null,
    status: "idle", message: "Focus a source to discover colors.", count: 0, page: 0, colors: [], selected: -1, value: "", css: null,
    presentation: "", choices: [], edits: [], canPreview: false, canApply: false, reviewKey: null, apply: null, changed: null };

function focusSource(editor: TextEditor) {
    editor.viewport.revealOffset(editor.view.getSnapshot().selection.head);
    editor.viewport.element.scrollIntoView({ block: "nearest", inline: "nearest" });
    editor.focus();
}

/** The host owns the picker, swatches, preview list and focus after confirmation. */
export class HostDocumentColors {
    private readonly sessions = new Set<Session>();
    private readonly reviewKeys = new WeakMap<ColorPresentationReview, number>();
    private active: Session | undefined;
    private owner: Session | undefined;
    private displayed: readonly DocumentColorChoice[] | undefined;
    private value = "";
    private valueInput: HTMLInputElement | undefined;
    private list: HTMLElement | undefined;
    private fieldEvents: AbortController | undefined;
    private listEvents: AbortController | undefined;
    private disposed = false;
    private disconnected = false;
    private delay = 0;
    private fault: ColorFault | undefined;
    private readonly metrics = { requested: 0, previews: 0, applied: 0, unchanged: 0 };
    private readonly cell = new HostCell(initial);
    readonly state = this.cell.observable;
    private readonly workspace: Workspace;
    private readonly canCapture: (id: DocumentId) => boolean;
    private readonly present: (id: DocumentId) => TextEditor | undefined;
    private readonly options: ColorHostOptions;
    private readonly reconnectProvider: (() => void) | undefined;
    constructor(workspace: Workspace, canCapture: (id: DocumentId) => boolean, present: (id: DocumentId) => TextEditor | undefined, options: ColorHostOptions, reconnectProvider?: () => void) {
        this.workspace = workspace; this.canCapture = canCapture; this.present = present; this.options = options; this.reconnectProvider = reconnectProvider;
    }
    private publish(patch: Partial<DocumentColorsSnapshot> = {}) {
        this.cell.set({ ...this.cell.get(), ...patch, view: this.owner?.id ?? null, available: !!this.active && !this.disposed,
            connected: !!this.owner && this.options.provider.getSnapshot().phase === "ready", disconnected: this.disconnected });
    }
    private syncSwatches() {
        const s = this.owner, colors = s?.controller.getSnapshot().colors;
        for (const pane of this.sessions) {
            if (colors?.length && s?.editor.view.documentId === pane.editor.view.documentId
                && colors[0]!.revision === this.workspace.observeDocument(pane.editor.view.documentId).getSnapshot()?.revision) {
                if (pane.painted === colors) continue;
                pane.layer.set(colors[0]!.revision, colors.map(c => ({ from: c.from, to: c.to, className: "st-document-color", before: "host-inline-swatch",
                    properties: { "--swatch-color": rgbaColor(c.color) } }))); pane.painted = colors;
            } else if (pane.painted) { delete pane.painted; pane.layer.clear(); }
        }
    }
    private render(s: Session, patch: Partial<Pick<DocumentColorsSnapshot, "page" | "value" | "selected">> = {}) {
        if (this.owner !== s) return;
        const state = s.controller.getSnapshot(), old = this.cell.get(), doc = this.workspace.observeDocument(s.editor.view.documentId).getSnapshot();
        const fresh = this.displayed !== state.colors;
        if (fresh) { this.displayed = state.colors; queueMicrotask(() => this.syncSwatches()); }
        if (!doc) { this.owner = undefined; this.publish({ ...initial, status: "expired", message: "The source closed." }); return; }
        if (state.status === "failed" || state.status === "expired" || state.status === "disposed" || state.status === "idle" || state.status === "applied") {
            this.owner = undefined;
            const applied = state.status === "applied";
            if (applied) { if (state.changed) this.metrics.applied++; else this.metrics.unchanged++; }
            const offline = this.options.provider.getSnapshot().phase === "disconnected";
            this.publish({ ...initial, value: this.value, status: offline ? "failed" : state.status === "disposed" ? "idle" : state.status, changed: applied ? { document: doc.id, title: doc.title } : null,
                message: state.message || (offline ? "Color provider disconnected." : applied ? state.changed ? "Applied the reviewed color presentation." : "The presentation already matches." : "Discover fresh colors.") });
            return;
        }
        if (state.status === "discovering") { this.publish({ ...initial, status: "scan", pending: true, message: "Discovering document colors…" }); return; }
        const head = s.editor.view.getSnapshot().selection.head;
        const selected = patch.selected ?? (fresh && state.colors.length ? Math.max(0, state.colors.findIndex(c => c.from <= head && head <= c.to)) : old.selected);
        const reference = state.colors[selected], page = patch.page ?? (fresh ? Math.max(0, Math.floor(selected / colorLimits.page)) : old.page);
        const value = patch.value ?? (fresh && reference ? rgbaColor(reference.color) : this.value), proposed = parseColor(value);
        this.value = value;
        const colors = fresh || page !== old.page ? state.colors.slice(page * colorLimits.page, (page + 1) * colorLimits.page).map((c, i) => {
            const { line, column } = doc.buffer.positionAt(c.from), ordinal = page * colorLimits.page + i, label = rgbaColor(c.color);
            return { from: c.from, to: c.to, color: c.color, label, text: doc.buffer.slice(c.from, Math.min(c.to, c.from + 96)), css: label, ordinal, line: line + 1, column: column + 1,
                inspect: () => {
                    if (this.owner !== s || s.controller.getSnapshot().colors[ordinal] !== c) return;
                    s.controller.dismissPreview(); this.render(s, { selected: ordinal, value: label }); this.valueInput?.focus(); this.valueInput?.select();
                } };
        }) : old.colors;
        const review = state.review, pending = state.status === "previewing";
        let reviewKey = review && this.reviewKeys.get(review);
        if (review && reviewKey === undefined) {
            reviewKey = this.workspace.allocateIdentity();
            this.reviewKeys.set(review, reviewKey);
        }
        const choices = state.presentations.map((choice, i) => ({ id: `provider-${i}`, label: choice.label, select: choice.select }));
        const edits = review?.edits.map(edit => ({ ...edit, document: doc.id, resource: doc.resourceId, title: doc.title.slice(0, 128), revision: doc.revision,
            context: doc.buffer.slice(Math.max(0, edit.from - 32), Math.min(doc.buffer.length, edit.from + 32)) })) ?? [];
        this.publish({ status: state.status === "ready" ? "colors" : "presentations", message: pending ? "Requesting color presentations…" : review ? "Review the edits before applying." : `${state.colors.length} document colors.`,
            pending, count: state.colors.length, colors, selected, page, value, css: proposed ? rgbaColor(proposed) : null, choices,
            presentation: review ? choices[state.presentations.indexOf(review.choice)]!.id : "", edits, canPreview: !!reference && !!proposed && !pending,
            canApply: review?.canApply ?? false, reviewKey: reviewKey ?? null, apply: review ? () => {
                if (!review.apply()) return false;
                if (this.sessions.has(s)) focusSource(s.editor);
                return true;
            } : null });
    }
    readonly cancel = () => {
        const owner = this.owner; this.owner = undefined; this.displayed = undefined; this.value = ""; owner?.controller.cancel();
        this.syncSwatches(); this.publish({ ...initial, message: "Color preview dismissed." });
    };
    readonly disconnect = () => { this.disconnected = true; this.cancel(); };
    readonly reconnect = () => { this.disconnected = false; this.cancel(); this.reconnectProvider?.(); };
    private readonly handlePanelKey = (event: KeyboardEvent) => {
        if ((this.owner ?? this.active)?.editor.keymap.handle(event)) event.stopPropagation();
    };
    readonly bindList = (list: HTMLElement | null) => {
        this.listEvents?.abort(); this.list = list ?? undefined; if (!list || this.disposed) return;
        const events = new AbortController(); this.listEvents = events;
        list.addEventListener("keydown", this.handlePanelKey, { signal: events.signal });
    };
    readonly bindValue = (input: HTMLInputElement | null) => {
        this.fieldEvents?.abort(); this.valueInput = input ?? undefined; if (!input || this.disposed) return;
        const events = new AbortController(); this.fieldEvents = events;
        input.addEventListener("keydown", this.handlePanelKey, { signal: events.signal });
    };
    setValue(value: string) {
        if (value === this.cell.get().value) return;
        this.value = value.slice(0, colorLimits.literal + 1); this.owner?.controller.dismissPreview();
        if (this.owner) this.render(this.owner);
        else { const proposed = parseColor(this.value); this.publish({ value: this.value, css: proposed ? rgbaColor(proposed) : null }); }
    }
    attach(id: string, _tab: TabId, editor: TextEditor) {
        if (this.disposed) throw new Error("Color panel is disposed.");
        const controller = createDocumentColorController(editor, this.options.provider, { canCapture: () => this.canCapture(editor.view.documentId),
            prepareRequest: kind => { const fault = this.fault; this.fault = undefined; return this.options.prepare(kind, this.delay, fault); } });
        let layer: DecorationLayer;
        try { layer = editor.decorations.add({ name: "document colors", order: 35 }); }
        catch (error) { controller.dispose(); throw error; }
        const s: Session = { id, editor, controller, layer, detach: () => detach() }, events = new AbortController();
        this.sessions.add(s);
        const stop = controller.subscribe(() => this.render(s));
        const detach = () => {
            if (!this.sessions.delete(s)) return;
            if (this.active === s) this.active = undefined;
            if (this.owner === s) this.cancel();
            events.abort(); stop(); controller.dispose(); s.layer.dispose(); this.publish();
        };
        try {
            const command = editor.commands.register({ id: "colors.discover", label: "Discover document colors", enabled: () => !this.disconnected,
                run: () => { this.active = s; this.start(true); } }, { keys: ["F6"] });
            events.signal.addEventListener("abort", command.dispose, { once: true });
            const ownsValue = () => (this.owner ?? this.active) === s && !!this.valueInput?.matches(":focus");
            const preview = editor.commands.register({ id: "colors.preview", label: "Preview color presentations",
                enabled: () => this.owner === s && ownsValue(), run: this.preview }, { keys: ["Enter"], shared: true, priority: 34, repeat: false });
            events.signal.addEventListener("abort", preview.dispose, { once: true });
            const dismiss = editor.commands.register({ id: "colors.dismiss", label: "Dismiss color preview",
                enabled: () => ownsValue() || (this.owner === s && !!this.list?.matches(":focus-within")),
                run: () => { this.cancel(); focusSource(editor); } }, { keys: ["Escape"], shared: true, priority: 8 });
            events.signal.addEventListener("abort", dismiss.dispose, { once: true });
            this.syncSwatches();
        } catch (error) { detach(); throw error; }
        editor.signal.addEventListener("abort", detach, { once: true, signal: events.signal });
        onSourceFocus(editor, events.signal, () => { this.active = s; this.publish(); });
        editor.onEditIntent(() => {
            if (this.owner?.editor.view.documentId === editor.view.documentId) this.cancel();
        }, events.signal);
        return detach;
    }
    readonly discover = () => this.start(false);
    private start(keyboard: boolean) {
        const s = this.active;
        if (!s || this.disconnected || !this.canCapture(s.editor.view.documentId) || this.workspace.document(s.editor.view.documentId).key.variant !== "working") return;
        this.cancel(); this.owner = s; this.metrics.requested++;
        void s.controller.request().then(() => { if (keyboard && this.owner === s && s.controller.getSnapshot().status === "ready" && s.editor.getSnapshot().focused) this.list?.focus(); });
    }
    readonly preview = () => {
        const s = this.owner, state = this.cell.get(), proposed = parseColor(state.value), reference = s?.controller.getSnapshot().colors[state.selected];
        if (!s || !reference || !proposed || state.pending || !this.canCapture(s.editor.view.documentId)) return;
        this.metrics.previews++; void reference.preview(proposed);
    };
    readonly openChanged = (id: DocumentId) => {
        if (this.disposed || this.owner || this.cell.get().changed?.document !== id || !this.canCapture(id)) return;
        try { const editor = [...this.sessions].find(s => s.editor.view.documentId === id)?.editor ?? this.present(id); if (editor) focusSource(editor); }
        catch { this.publish({ message: "The changed color resource is no longer available." }); }
    };
    private page(delta: number) {
        const s = this.cell.get(), page = s.page + delta;
        if (this.owner && page >= 0 && page * colorLimits.page < s.count) this.render(this.owner, { page });
    }
    readonly nextPage = () => this.page(1);
    readonly previousPage = () => this.page(-1);
    setDelay(value: number) { if (!Number.isFinite(value) || value < 0 || value > 1000) throw new RangeError("Invalid color delay."); this.delay = value; }
    faultNext(value: ColorFault) { this.fault = value; }
    debug() { return { ...this.metrics, state: this.cell.get(), sessions: this.sessions.size, subscriptions: this.cell.count(),
        decoratedViews: [...this.sessions].filter(s => !!s.painted).length, disposed: this.disposed }; }
    dispose() { if (!this.disposed) { this.disposed = true; this.cancel(); this.bindList(null); this.bindValue(null); for (const s of this.sessions) s.detach(); } }
}
