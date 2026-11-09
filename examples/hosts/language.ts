import { createFindController, createRegexFindBackend } from "../../src/browser/index.ts";
import type { EditingCandidate, FindController, FindSnapshot } from "../../src/browser/index.ts";
import type { ComparisonBaseline, DocumentId, FoldRange, FoldRegion, FoldingSnapshot, TabId, TabTarget, Workspace } from "../../src/index.ts";
import { createProviderController } from "../editing/provider-controller.ts";
import type { ProviderSnapshot } from "../editing/provider-controller.ts";
import { EditingPresentation } from "../editing/presentation.ts";
import { HostCell } from "../shared/observable.ts";

type Session = { id: string; editor: EditingCandidate; tab: TabId; target: TabTarget; saveTarget: TabTarget; presentation: EditingPresentation;
    provider?: ReturnType<typeof createProviderController>; reference?: ComparisonBaseline; find?: FindController; stopFind?: () => void; initialized: boolean };
type DetachedOwner = Readonly<{ id: string; target: TabTarget; documentId: DocumentId; reference?: ComparisonBaseline }>;
type SaveShortcut = (event: KeyboardEvent, control: HTMLElement, target: TabTarget, composing: () => boolean) => void;
type LanguageSnapshot = Readonly<{ readOnlyReference: boolean; view: string | null; provider: ProviderSnapshot | null; find: FindSnapshot | null; folds: FoldingSnapshot | null; foldMessage: string; query: string; replacement: string; wholeWord: boolean; matchCase: boolean; regularExpression: boolean }>;

/** Host-owned tools follow an explicit mounted view; delayed commands never consult focus later. */
export class HostLanguageTools {
    private readonly workspace: Workspace;
    private readonly saveShortcut: SaveShortcut;
    private readonly sessions = new Map<string, Session>();
    private active: Session | undefined;
    private detachedOwner: DetachedOwner | undefined;
    private stopFolds: (() => void) | undefined;
    private foldSerial = 0;
    private readonly cell = new HostCell<LanguageSnapshot>({ readOnlyReference: false, view: null, provider: null, find: null, folds: null, foldMessage: "", query: "", replacement: "", wholeWord: false, matchCase: true, regularExpression: false });
    readonly state = this.cell.observable;
    private queryElement: HTMLInputElement | null = null;
    private replacementElement: HTMLInputElement | null = null;
    private toolsElement: HTMLElement | null = null;
    readonly queryRef = (element: HTMLInputElement | null): void => { this.queryElement = element; };
    readonly replacementRef = (element: HTMLInputElement | null): void => { this.replacementElement = element; };
    readonly toolsRef = (element: HTMLElement | null): void => { this.toolsElement = element; };
    private retired = { posted: 0, applied: 0, stale: 0, cancelled: 0, invalid: 0, failed: 0, postedUnits: 0 };
    constructor(workspace: Workspace, saveShortcut: SaveShortcut) { this.workspace = workspace; this.saveShortcut = saveShortcut; }
    private publish(): void {
        const previous = this.cell.get(), folds = this.active?.editor.view.folding.getSnapshot() ?? null;
        this.cell.set({ ...previous, readOnlyReference: this.active?.reference !== undefined, view: this.active?.id ?? null, provider: this.active?.provider?.state.getSnapshot() ?? null,
            find: this.active?.find?.state.getSnapshot() ?? null, folds, foldMessage: folds === previous.folds ? previous.foldMessage : "" });
    }
    private activate(session: Session, initialize = true): void {
        this.detachedOwner = undefined;
        if (this.active !== session) {
            this.stopFolds?.(); this.active?.provider?.cancel(); this.active?.find?.cancel(); this.active = session;
            let revision = session.editor.view.folding.getSnapshot().revision;
            this.stopFolds = session.editor.view.folding.subscribe(() => {
                const current = session.editor.view.folding.getSnapshot(); if (current.revision === revision) session.provider?.cancel(); revision = current.revision;
                if (this.active === session) this.publish();
            }); this.cell.set({ ...this.cell.get(), foldMessage: "" });
        }
        if (initialize && !session.initialized) { session.initialized = true; session.provider?.connect(); }
        this.publish();
    }
    private resume(session: Session): void {
        const previous = this.detachedOwner;
        if (!previous || previous.id !== session.id) return;
        this.detachedOwner = undefined;
        const compatible = previous.reference && session.reference
            ? previous.reference.buffer === session.reference.buffer && previous.reference.version === session.reference.version
            : !previous.reference && !session.reference && previous.documentId === session.editor.view.documentId
                && previous.target.workspace === session.target.workspace && previous.target.id === session.target.id && previous.target.generation === session.target.generation;
        // A new attachment owns new jobs. Restoring the logical context starts none and never focuses.
        if (compatible && !this.active) this.activate(session, false);
    }
    clearRetainedView(): void { this.detachedOwner = undefined; }
    attach(id: string, tab: TabId, editor: EditingCandidate, presentation: EditingPresentation): () => void {
        if (this.sessions.has(id)) throw new Error("Language view already mounted.");
        const provider = createProviderController(this.workspace, tab, editor, { autoConnect: false });
        const target = this.workspace.captureTab(tab), session: Session = { id, tab, target, saveTarget: target, editor, presentation, provider, initialized: false }, listeners = new AbortController();
        this.sessions.set(id, session);
        const update = () => {
            const state = provider.state.getSnapshot(), previous = presentation.diagnostics;
            presentation.diagnostics = { revision: state.diagnosticRevision, ranges: state.diagnostics };
            if (previous?.revision !== state.diagnosticRevision || previous.ranges !== state.diagnostics) editor.viewport.invalidate();
            if (this.active === session) this.publish();
        };
        const unsubscribe = provider.state.subscribe(update);
        editor.input.addEventListener("focus", () => this.activate(session), { signal: listeners.signal });
        editor.input.addEventListener("keydown", event => {
            if (event.isComposing || editor.snapshot().composing || event.defaultPrevented) return;
            if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && (event.code === "BracketLeft" || event.code === "BracketRight")) {
                event.preventDefault(); this.activate(session); if (event.code === "BracketLeft") this.foldSelection(); else this.expandFolds();
            } else if (this.findKey(event, session)) return;
            else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.code === "Space") { event.preventDefault(); this.activate(session); provider.request(); }
            else if (event.altKey && event.key === "Enter" && provider.state.getSnapshot().offerText !== null) { event.preventDefault(); provider.apply("replace"); }
            else if (event.key === "Escape" && (provider.state.getSnapshot().pending || provider.state.getSnapshot().offerText !== null)) { event.preventDefault(); provider.cancel(); }
        }, { signal: listeners.signal });
        update(); this.resume(session); return this.detachSession(session, listeners, unsubscribe);
    }
    attachReferenceFind(id: string, target: TabTarget, editor: EditingCandidate, presentation: EditingPresentation, baseline: ComparisonBaseline, saveTarget: TabTarget, resume = false): () => void {
        if (this.sessions.has(id)) throw new Error("Find view already mounted.");
        const tab = this.workspace.resolveTab(target);
        if (tab?.surface.kind !== "text" || tab.surface.documentId !== editor.view.documentId || !this.workspace.ownsDocumentView(editor.view)
            || this.workspace.document(editor.view.documentId).buffer !== baseline.buffer) throw new Error("Reference Find requires its captured view and baseline.");
        const session: Session = { id, tab: target.id, target, saveTarget, editor, presentation, initialized: true, reference: baseline }, listeners = new AbortController();
        this.sessions.set(id, session);
        editor.input.addEventListener("focus", () => this.activate(session), { signal: listeners.signal });
        editor.input.addEventListener("keydown", event => { if (!event.defaultPrevented && !event.isComposing && !editor.snapshot().composing) this.findKey(event, session); }, { signal: listeners.signal });
        // Keep the logical field target after replacement, without starting old work or moving focus.
        if (resume) this.activate(session); else this.resume(session);
        return this.detachSession(session, listeners);
    }
    private findKey(event: KeyboardEvent, session: Session): boolean {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && ["f", "h"].includes(event.key.toLowerCase())) {
            event.preventDefault(); this.activate(session); this.ensureFind();
            const field = session.reference || event.key.toLowerCase() === "f" ? this.queryElement : this.replacementElement;
            field?.focus(); field?.select(); return true;
        }
        if (event.key === "F3") { event.preventDefault(); this.activate(session); this.ensureFind()?.next(event.shiftKey ? -1 : 1); return true; }
        return false;
    }
    private toolsSession(event: KeyboardEvent): { session: Session; control: HTMLElement } | undefined {
        const root = this.toolsElement, target = event.target, realm = root?.ownerDocument.defaultView, session = this.active;
        if (event.defaultPrevented || event.isComposing || !root?.isConnected || !realm || !(target instanceof realm.HTMLElement) || !root.contains(target) || !session
            || (target.closest("button,input,select,textarea") ?? target).matches(":disabled") || !session.editor.element.isConnected
            || session.editor.snapshot().disposed || session.editor.snapshot().composing || !this.workspace.ownsDocumentView(session.editor.view)) return;
        const tab = this.workspace.resolveTab(session.target);
        if (tab?.surface.kind !== "text" || tab.surface.documentId !== session.editor.view.documentId) return;
        return { session, control: target };
    }
    readonly saveFromTools = (event: KeyboardEvent): void => {
        const owned = this.toolsSession(event);
        if (owned) this.saveShortcut(event, owned.control, owned.session.saveTarget, () => owned.session.editor.snapshot().composing);
    };
    readonly escapeFromTools = (event: KeyboardEvent): void => {
        const owned = this.toolsSession(event); if (!owned) return;
        event.preventDefault(); owned.session.find?.cancel(); owned.session.editor.focus();
    };
    private detachSession(session: Session, listeners: AbortController, unsubscribe: () => void = () => {}): () => void {
        let detached = false;
        return () => {
            if (detached) return; detached = true;
            if (this.active === session) {
                this.detachedOwner = Object.freeze({ id: session.id, target: session.target, documentId: session.editor.view.documentId, ...(session.reference ? { reference: session.reference } : {}) });
                this.stopFolds?.(); this.stopFolds = undefined;
            }
            unsubscribe(); listeners.abort(); session.stopFind?.(); session.find?.destroy();
            const counts = session.provider?.snapshot(); if (counts) for (const key of Object.keys(this.retired) as (keyof typeof this.retired)[]) this.retired[key] += counts[key];
            session.provider?.destroy(); session.presentation.clear(); this.sessions.delete(session.id);
            if (this.active === session) this.active = undefined; this.publish();
        };
    }
    private ensureFind(): FindController | undefined {
        const session = this.active; if (!session) return;
        if (!session.find) {
            const clock = session.editor.element.ownerDocument.defaultView!;
            session.find = createFindController(this.workspace, session.tab, session.editor, { regularExpression: createRegexFindBackend({ clock,
                createWorker: () => new Worker("/regex-worker.js", { type: "module" }) }) });
            const update = () => { const state = session.find!.state.getSnapshot(), previous = session.presentation.search;
                session.presentation.search = { revision: state.revision, ranges: state.preview };
                if (previous?.revision !== state.revision || previous.ranges !== state.preview) session.editor.viewport.invalidate();
                if (this.active === session) this.publish(); };
            session.stopFind = session.find.state.subscribe(update);
        }
        const state = session.find.state.getSnapshot(), { query, wholeWord, matchCase, regularExpression } = this.cell.get();
        if (state.wholeWord !== wholeWord || state.matchCase !== matchCase || state.regularExpression !== regularExpression) session.find.setOptions({ wholeWord, matchCase, regularExpression });
        if (state.query !== query || state.status === "cancelled") session.find.setQuery(query);
        return session.find;
    }
    readonly request = (): void => { if (this.active) { this.activate(this.active); this.active.provider?.request(); } };
    readonly insert = (): void => { this.active?.provider?.apply("insert"); };
    readonly replace = (): void => { this.active?.provider?.apply("replace"); };
    readonly cancel = (): void => { this.active?.provider?.cancel(); };
    readonly disconnect = (): void => { this.active?.provider?.disconnect(); };
    readonly reconnect = (): void => { if (this.active) { this.active.initialized = true; this.active.provider?.connect(); } };
    readonly setQuery = (query: string): void => { this.cell.set({ ...this.cell.get(), query }); this.ensureFind(); };
    readonly setWholeWord = (wholeWord: boolean): void => { this.cell.set({ ...this.cell.get(), wholeWord }); this.ensureFind(); };
    readonly setMatchCase = (matchCase: boolean): void => { this.cell.set({ ...this.cell.get(), matchCase }); this.ensureFind(); };
    readonly setRegularExpression = (regularExpression: boolean): void => { this.cell.set({ ...this.cell.get(), regularExpression }); this.ensureFind(); };
    readonly setReplacement = (replacement: string): void => { this.cell.set({ ...this.cell.get(), replacement }); };
    readonly next = (): void => { this.ensureFind()?.next(); };
    readonly previous = (): void => { this.ensureFind()?.next(-1); };
    readonly replaceCurrent = (): void => { if (this.active?.reference) return; this.ensureFind()?.replaceCurrent(this.cell.get().replacement); };
    readonly replaceAll = (): void => { if (this.active?.reference) return; this.ensureFind()?.replaceAll(this.cell.get().replacement); };
    readonly cancelFind = (): void => { this.active?.find?.cancel(); this.active?.editor.focus(); };
    readonly focusEditor = (): void => { this.active?.editor.focus(); };
    private foldTarget(): Session | undefined {
        const session = this.active; if (!session) return;
        const tab = this.workspace.resolveTab(session.target);
        if (tab?.surface.kind !== "text" || tab.surface.documentId !== session.editor.view.documentId || !this.workspace.ownsDocumentView(session.editor.view)
            || !session.editor.element.isConnected || session.editor.snapshot().disposed) return;
        if (session.editor.snapshot().composing) { this.cell.set({ ...this.cell.get(), foldMessage: "Finish composition before folding." }); return; }
        return session;
    }
    readonly foldSelection = (): void => {
        const session = this.foldTarget(); if (!session) return;
        const { editor } = session, document = this.workspace.document(editor.view.documentId), selected = editor.view.getSnapshot().selectionSet;
        const current = editor.view.folding.getSnapshot(), ranges: FoldRange[] = [...current.regions], ids = new Set(ranges.map(r => r.id)); let count = 0;
        const selections = selected.ranges.map(selection => {
            const low = Math.min(selection.anchor, selection.head), high = Math.max(selection.anchor, selection.head), first = document.buffer.lineAt(low), last = document.buffer.lineAt(high > low ? high - 1 : high);
            let existing: FoldRegion | undefined;
            for (const r of current.regions) { if (first === last ? r.lineFrom <= first && first < r.lineTo : r.lineFrom === first) existing = r; }
            if (first === last && !existing) return selection;
            const from = existing && first === last ? existing.from : document.buffer.offsetAt(first);
            const to = existing && first === last ? existing.to : last + 1 < document.buffer.lineCount ? document.buffer.offsetAt(last + 1) : document.buffer.length;
            let id = existing?.id; if (!id) { do { id = `selection-fold-${++this.foldSerial}`; } while (ids.has(id)); ids.add(id); }
            const at = ranges.findIndex(r => r.id === id); if (at < 0) ranges.push({ id, from, to, collapsed: true }); else ranges[at] = { id, from, to, collapsed: true };
            count++; const head = document.buffer.offsetAt(document.buffer.lineAt(from)); return { anchor: head, head };
        });
        if (!count) { this.cell.set({ ...this.cell.get(), foldMessage: "Select multiple lines to create a fold." }); return; }
        try {
            if (!editor.view.folding.setRanges(current, ranges)) return;
            editor.view.setSelections(document.revision, selections, selected.primary); editor.viewport.revealOffset(editor.view.getSnapshot().selection.head, { horizontal: "nearest", vertical: "nearest" }); editor.focus();
            this.cell.set({ ...this.cell.get(), foldMessage: `Folded ${count} ${count === 1 ? "region" : "regions"}.` });
        } catch (error) { if (!(error instanceof RangeError)) throw error; this.cell.set({ ...this.cell.get(), foldMessage: "Select nested or separate line regions." }); }
    };
    readonly expandFolds = (): void => {
        const session = this.foldTarget(); if (!session) return; const folds = session.editor.view.folding, current = folds.getSnapshot();
        if (!folds.setRanges(current, current.regions.map(r => ({ ...r, collapsed: false })))) return;
        session.editor.viewport.revealOffset(session.editor.view.getSnapshot().selection.head, { horizontal: "nearest", vertical: "nearest" }); session.editor.focus();
        this.cell.set({ ...this.cell.get(), foldMessage: "All folds expanded." });
    };
    selectDiagnostic(index: number): void { this.active?.provider?.selectDiagnostic(index); }
    setDelay(value: number): void { this.active?.provider?.setDelay(value); }
    faultNext(value: "malformed" | "failure"): void { this.active?.provider?.faultNext(value); }
    debug() { return { active: this.active?.id ?? null, subscriptions: this.cell.count(), referenceFind: [...this.sessions.values()].filter(s => s.reference).map(s => ({ id: s.id, documentId: s.editor.view.documentId, viewId: s.editor.view.id, find: s.find?.state.getSnapshot() ?? null })), sessions: [...this.sessions.values()].flatMap(s => s.provider ? [{ id: s.id, documentId: s.editor.view.documentId,
        viewId: s.editor.view.id, foldRegions: s.editor.view.folding.getSnapshot().regions.length, collapsedFolds: s.editor.view.folding.getSnapshot().index.collapsedCount, provider: s.provider.snapshot(), presentation: s.presentation.snapshot() }] : []), retired: { ...this.retired } }; }
}
