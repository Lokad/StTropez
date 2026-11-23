import { fixtureRequests, type FixturePolicy } from "../shared/language/fixture-requests.ts";
import { createReviewKey, panelPaging, type PanelPaging } from "./panel-actions.ts";
import { bindSwatchPicker, watchColorSwatches } from "./color-swatches.ts";
import { formatEditNote } from "./edit-review.ts";
import { createPanelKeyBinding } from "./panel-keys.ts";
import { attachPanelSession } from "../shared/editor-attachment.ts";
import { focusSourceCaret, onSourceFocus } from "./source-focus.ts";
import { openChangedFile, type ChangedFile, type LanguageHost } from "./language-host.ts";
import type { DocumentId, TabId } from "../../src/index.ts";
import { createDocumentColorController } from "../../src/browser/index.ts";
import type { ColorPresentationChoice, DecorationLayer, DocumentColorChoice, DocumentColorController, ReviewEditResult, TextEditor } from "../../src/browser/index.ts";
import type { LspDocumentColor, LspPrepare, LspWorkspace } from "../../src/protocol/index.ts";
import { colorLimits, parseColor, rgbaColor, sameColor } from "../../fixtures/language/colors.ts";
import type { ColorFault, ColorReference } from "../../fixtures/language/colors.ts";
import { HostCell } from "../shared/observable.ts";

export type ColorHostOptions = Readonly<{ provider: LspWorkspace;
    prepare: (kind: "discovery" | "presentation", policy: FixturePolicy<ColorFault>) => LspPrepare }>;
type Session = { id: string; editor: TextEditor; controller: DocumentColorController; swatches: ReturnType<typeof watchColorSwatches> };
export type ColorNote = ColorReference & Readonly<{ ordinal: number; line: number; column: number; css: string; inspect: () => void }>;
export type DocumentColorsSnapshot = Readonly<{ available: boolean; connected: boolean; disconnected: boolean; pending: boolean; view: string | null;
    status: "idle" | "scan" | "colors" | "presentations" | "applied" | "expired" | "failed"; message: string; count: number; page: number; paging: PanelPaging | null; colors: readonly ColorNote[];
    selected: number; value: string; css: string | null; presentation: string; choices: readonly ColorPresentationChoice[];
    edits: readonly string[]; canPreview: boolean; canApply: boolean; reviewKey: number | null; apply: (() => ReviewEditResult) | null; changed: ChangedFile | null }>;
const initial: DocumentColorsSnapshot = { available: false, connected: false, disconnected: false, pending: false, view: null,
    status: "idle", message: "Focus a source to discover colors.", count: 0, page: 0, paging: null, colors: [], selected: -1, value: "", css: null,
    presentation: "", choices: Object.freeze([]), edits: Object.freeze([]), canPreview: false, canApply: false, reviewKey: null, apply: null, changed: null };

/** The host owns the picker, swatches, preview list and focus after confirmation. */
export class HostDocumentColors {
    private readonly sessions = new Map<Session, () => void>();
    private readonly reviewKey;
    private active: Session | undefined;
    private owner: Session | undefined;
    private selectedSwatch: LspDocumentColor | undefined;
    private displayed: readonly DocumentColorChoice[] | undefined;
    private value = "";
    private readonly panelEditor = () => (this.owner ?? this.active)?.editor;
    private readonly valueField = createPanelKeyBinding<HTMLInputElement>(this.panelEditor);
    private readonly colorList = createPanelKeyBinding<HTMLElement>(this.panelEditor);
    private disposed = false;
    private disconnected = false;
    readonly fixture = fixtureRequests<ColorFault>("color");
    private readonly metrics = { requested: 0, previews: 0, applied: 0, unchanged: 0 };
    private readonly cell = new HostCell(initial);
    readonly state = this.cell.observable;
    private readonly host: LanguageHost;
    private readonly options: ColorHostOptions;
    constructor(host: LanguageHost, options: ColorHostOptions) {
        this.reviewKey = createReviewKey(host.workspace);
        this.host = host; this.options = options;
    }
    private publish(patch: Partial<DocumentColorsSnapshot> = {}) {
        this.cell.set({ ...this.cell.get(), ...patch, view: this.owner?.id ?? null, available: !!this.active && !this.disposed,
            connected: !!this.owner && this.options.provider.getSnapshot().phase === "ready", disconnected: this.disconnected });
    }
    private render(s: Session, patch: Partial<Pick<DocumentColorsSnapshot, "page" | "value" | "selected">> = {}) {
        if (this.owner !== s) return;
        const state = s.controller.getSnapshot(), old = this.cell.get(), doc = this.host.workspace.observeDocument(s.editor.view.documentId).getSnapshot();
        const fresh = this.displayed !== state.colors;
        this.displayed = state.colors;
        if (!doc) { this.owner = undefined; this.publish({ ...initial, status: "expired", message: "The source closed." }); return; }
        if (state.status === "failed" || state.status === "expired" || state.status === "disposed" || state.status === "idle" || state.status === "applied") {
            this.owner = undefined;
            if (state.status === "failed") s.swatches.clear();
            else if (state.status === "expired" || state.status === "idle") s.swatches.resume();
            const applied = state.status === "applied";
            if (applied) { if (state.changed) this.metrics.applied++; else this.metrics.unchanged++; }
            const offline = this.options.provider.getSnapshot().phase === "disconnected";
            this.publish({ ...initial, value: this.value, status: offline ? "failed" : state.status === "disposed" ? "idle" : state.status, changed: applied ? { document: doc.id, title: doc.title } : null,
                message: state.message || (offline ? "Color provider disconnected." : applied ? state.changed ? "Applied the reviewed color presentation." : "The presentation already matches." : "Discover fresh colors.") });
            return;
        }
        if (state.status === "discovering") { this.publish({ ...initial, value: this.value, status: "scan", pending: true, message: "Discovering document colors…" }); return; }
        if (fresh) s.swatches.accept(doc.revision, state.colors);
        const head = s.editor.view.getSnapshot().selection.head;
        const target = this.selectedSwatch; this.selectedSwatch = undefined;
        const selected = patch.selected ?? (target ? state.colors.findIndex(c => c.from === target.from && c.to === target.to && sameColor(c.color, target.color))
            : fresh && state.colors.length ? Math.max(0, state.colors.findIndex(c => c.from <= head && head <= c.to)) : old.selected);
        const reference = state.colors[selected], page = patch.page ?? (fresh ? Math.max(0, Math.floor(selected / colorLimits.page)) : old.page);
        const value = patch.value ?? (fresh && reference && !target ? rgbaColor(reference.color) : this.value), proposed = parseColor(value);
        this.value = value;
        const colors = fresh || page !== old.page ? state.colors.slice(page * colorLimits.page, (page + 1) * colorLimits.page).map((c, i) => {
            const { line, column } = doc.buffer.positionAt(c.from), ordinal = page * colorLimits.page + i, label = rgbaColor(c.color);
            return { from: c.from, to: c.to, color: c.color, label, text: doc.buffer.slice(c.from, Math.min(c.to, c.from + 96)), css: label, ordinal, line: line + 1, column: column + 1,
                inspect: () => this.inspect(s, ordinal, c) };
        }) : old.colors;
        const review = state.review, pending = state.status === "previewing";
        const paging = pending ? null : panelPaging(this.reviewKey(state.colors)!, page, state.colors.length, colorLimits.page, next => {
            const current = this.cell.get();
            if (this.owner === s && !current.pending && current.colors === colors) this.render(s, { page: next });
        });
        const choices = state.presentations, reviewKey = this.reviewKey(review);
        const edits = !review ? initial.edits : reviewKey === old.reviewKey ? old.edits : Object.freeze(review.notes.map(formatEditNote));
        this.publish({ status: state.status === "ready" ? "colors" : "presentations", message: target && !reference ? "The selected color changed. Choose a current color."
            : pending ? "Requesting color presentations…" : review ? "Review the edits before applying." : `${state.colors.length} document colors.`,
            pending, count: state.colors.length, colors, selected, page, paging, value, css: proposed ? rgbaColor(proposed) : null, choices,
            presentation: review ? `provider-${choices.indexOf(review.choice)}` : "", edits, canPreview: !!reference && !!proposed && !pending,
            canApply: review?.canApply ?? false, reviewKey, apply: review ? () => {
                const result = review.apply();
                if (result.applied && this.sessions.has(s)) focusSourceCaret(s.editor);
                return result;
            } : null });
    }
    readonly cancel = () => {
        const owner = this.owner; this.owner = undefined; this.selectedSwatch = undefined; this.displayed = undefined; this.value = ""; owner?.controller.cancel();
        owner?.swatches.resume();
        this.publish({ ...initial, message: "Color preview dismissed." });
    };
    readonly disconnect = () => { this.disconnected = true; this.cancel(); for (const s of this.sessions.keys()) s.swatches.setEnabled(false); };
    readonly reconnect = () => { this.disconnected = false; this.cancel(); this.host.reconnect?.(); for (const s of this.sessions.keys()) s.swatches.setEnabled(true); };
    readonly bindList = this.colorList.bind;
    readonly bindValue = this.valueField.bind;
    setValue(value: string) {
        if (value === this.cell.get().value) return;
        this.value = value.slice(0, colorLimits.literal + 1); this.owner?.controller.dismissPreview();
        if (this.owner) this.render(this.owner);
        else { const proposed = parseColor(this.value); this.publish({ value: this.value, css: proposed ? rgbaColor(proposed) : null }); }
    }
    attach(id: string, _tab: TabId, editor: TextEditor) {
        if (this.disposed) throw new Error("Color panel is disposed.");
        const controller = createDocumentColorController(editor, this.options.provider, { canCapture: () => this.host.canCapture(editor.view.documentId),
            prepareRequest: kind => this.options.prepare(kind, this.fixture.take()) });
        let layer: DecorationLayer;
        try { layer = editor.decorations.add({ name: "document colors", order: 35 }); }
        catch (error) { controller.dispose(); throw error; }
        const swatches = [...this.sessions.keys()].find(s => s.editor.view.documentId === editor.view.documentId)?.swatches
            ?? watchColorSwatches(this.host.workspace.observeDocument(editor.view.documentId), this.options.provider, !this.disconnected);
        const s: Session = { id, editor, controller, swatches };
        return attachPanelSession(this.sessions, s, (signal, register) => {
            swatches.add(layer);
            bindSwatchPicker(editor, swatches, item => { this.active = s; this.start(false, item); }, signal);
            controller.subscribe(() => this.render(s));
            register({ id: "colors.discover", label: "Discover document colors", enabled: () => !this.disconnected,
                run: () => { this.active = s; this.start(true); } }, { keys: ["F6"] });
            const ownsValue = () => (this.owner ?? this.active) === s && this.valueField.focused;
            register({ id: "colors.preview", label: "Preview color presentations",
                enabled: () => this.owner === s && ownsValue(), run: this.preview }, { keys: ["Enter"], shared: true, priority: 34, repeat: false });
            register({ id: "colors.dismiss", label: "Dismiss color preview",
                enabled: () => ownsValue() || (this.owner === s && this.colorList.focused),
                run: () => { this.cancel(); focusSourceCaret(editor); } }, { keys: ["Escape"], shared: true, priority: 8 });
            onSourceFocus(editor, signal, () => { this.active = s; this.publish(); });
            editor.onEditIntent(() => {
                if (this.owner?.editor.view.documentId === editor.view.documentId) this.cancel();
            }, signal);
        }, () => {
            try {
                if (this.active === s) this.active = undefined;
                if (this.owner === s) this.cancel();
                else this.publish();
            } finally { swatches.remove(layer); layer.dispose(); }
        });
    }
    readonly discover = () => this.start(false);
    private inspect(s: Session, ordinal: number, color: DocumentColorChoice) {
        if (this.owner !== s || s.controller.getSnapshot().colors[ordinal] !== color) return;
        s.controller.dismissPreview();
        this.render(s, { page: Math.floor(ordinal / colorLimits.page), selected: ordinal, value: rgbaColor(color.color) });
        this.valueField.element?.focus(); this.valueField.element?.select();
    }
    private start(keyboard: boolean, swatch?: LspDocumentColor) {
        const s = this.active;
        if (!s || this.disconnected || !this.host.canCapture(s.editor.view.documentId) || this.host.workspace.document(s.editor.view.documentId).key.variant !== "working") return;
        const state = s.controller.getSnapshot();
        if (swatch && this.owner === s && (state.status === "ready" || state.status === "review")) {
            const index = state.colors.findIndex(c => c.from === swatch.from && c.to === swatch.to && sameColor(c.color, swatch.color));
            if (index >= 0) { this.inspect(s, index, state.colors[index]!); return; }
        }
        this.cancel(); this.owner = s; this.metrics.requested++;
        s.swatches.cancel(); this.selectedSwatch = swatch;
        if (swatch) this.value = rgbaColor(swatch.color);
        void s.controller.request().then(() => { if (keyboard && this.owner === s && s.controller.getSnapshot().status === "ready" && s.editor.getSnapshot().focused) this.colorList.element?.focus(); });
        if (swatch) { this.valueField.element?.focus(); this.valueField.element?.select(); }
    }
    readonly preview = () => {
        const s = this.owner, state = this.cell.get(), proposed = parseColor(state.value), reference = s?.controller.getSnapshot().colors[state.selected];
        if (!s || !reference || !proposed || state.pending || !this.host.canCapture(s.editor.view.documentId)) return;
        this.metrics.previews++; void reference.preview(proposed);
    };
    readonly openChanged = (id: DocumentId) => {
        if (this.disposed || this.owner || this.cell.get().changed?.document !== id) return;
        this.publish({ message: openChangedFile(this.host, id, this.sessions.keys()) });
    };
    debug() { return { ...this.metrics, state: this.cell.get(), sessions: this.sessions.size, subscriptions: this.cell.count(),
        decoratedViews: [...this.sessions.keys()].filter(s => s.swatches.current()?.colors.length).length, disposed: this.disposed }; }
    dispose() { if (!this.disposed) { this.disposed = true; this.cancel(); this.colorList.dispose(); this.valueField.dispose(); for (const detach of this.sessions.values()) detach(); } }
}
