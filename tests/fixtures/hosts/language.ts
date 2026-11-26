import { onSourceFocus } from "../../../examples/shared/source-focus.ts";
import { scopedCommands } from "../../../examples/shared/editor-attachment.ts";
import { mountFindBar, type TextEditor } from "../../../src/browser/index.ts";
import type { ComparisonBaseline, DocumentId, FoldRange, FoldRegion, FoldingSnapshot, TabId, TabTarget, Workspace } from "../../../src/index.ts";
import type { LspProviderController, LspProviderFactory } from "../language/lsp-provider-controller.ts";
import { EditingPresentation } from "../language/presentation.ts";
import { HostCell } from "../../../examples/shared/observable.ts";

type Session = { id: string; editor: TextEditor; target: TabTarget; presentation: EditingPresentation;
    provider?: LspProviderController; stopProvider?: () => void; providerError?: string; reference?: () => ComparisonBaseline | null; initialized: boolean };
type DetachedOwner = Readonly<{ id: string; target: TabTarget; documentId: DocumentId; reference?: ComparisonBaseline }>;
type LanguageSnapshot = Readonly<{ readOnlyReference: boolean; view: string | null; provider: ReturnType<LspProviderController["getSnapshot"]> | null; providerError: string | null; folds: FoldingSnapshot | null; foldMessage: string }>;

/** Host-owned tools follow an explicit mounted view; delayed commands never consult focus later. */
export class HostLanguageTools {
    private readonly workspace: Workspace;
    private readonly providerFactory: LspProviderFactory;
    private readonly canCapture: (documentId: DocumentId) => boolean;
    private readonly sessions = new Map<string, Session>();
    private active: Session | undefined;
    private detachedOwner: DetachedOwner | undefined;
    private stopFolds: (() => void) | undefined;
    private readonly find = mountFindBar(document.createElement("div"), {
        createWorker: () => new Worker("/regex-worker.js", { type: "module" })
    });
    readonly findRef = (host: HTMLElement | null): void => {
        if (host) host.append(this.find.element);
        else this.find.element.remove();
    };
    private readonly cell = new HostCell<LanguageSnapshot>({ readOnlyReference: false, view: null, provider: null, providerError: null, folds: null, foldMessage: "" });
    readonly state = this.cell.observable;
    private toolsElement: HTMLElement | null = null;
    readonly toolsRef = (element: HTMLElement | null): void => { this.toolsElement = element; };
    constructor(workspace: Workspace, options: Readonly<{ providerFactory: LspProviderFactory; canCapture?: (documentId: DocumentId) => boolean }>) {
        this.workspace = workspace; this.providerFactory = options.providerFactory; this.canCapture = options.canCapture ?? (() => true);
    }
    private publish(): void {
        const previous = this.cell.get(), folds = this.active?.editor.view.folding.getSnapshot() ?? null;
        this.cell.set({ ...previous, readOnlyReference: this.active?.reference !== undefined, view: this.active?.id ?? null, provider: this.active?.provider?.getSnapshot() ?? null,
            providerError: this.active?.providerError ?? null, folds, foldMessage: folds === previous.folds ? previous.foldMessage : "" });
    }
    private activate(session: Session, initialize = true): void {
        this.detachedOwner = undefined;
        if (this.active !== session) {
            this.stopFolds?.();
            this.active?.provider?.cancel();
            this.active = session;
            this.find.setTarget(session.editor);
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
        const reference = session.reference?.();
        const compatible = previous.reference && reference
            ? previous.reference.buffer === reference.buffer && previous.reference.version === reference.version
            : !previous.reference && !session.reference && previous.documentId === session.editor.view.documentId
                && previous.target.workspace === session.target.workspace && previous.target.id === session.target.id && previous.target.generation === session.target.generation;
        // Only the same resource can resume as the toolbar target without a new focus gesture.
        if (compatible && !this.active) this.activate(session, false);
    }
    dispose(): void {
        this.find.dispose();
        this.detachedOwner = undefined;
    }
    private attachProvider(session: Session): void {
        const { editor } = session;
        let provider: LspProviderController;
        try { provider = this.providerFactory(editor, { autoConnect: false, canCapture: () => this.canCapture(editor.view.documentId) }); }
        catch (error) {
            // Provider construction owns its partial cleanup. Local editing and Find keep their view.
            session.providerError = error instanceof Error ? error.message : String(error);
            if (this.active === session) this.publish();
            return;
        }
        session.provider = provider; delete session.providerError;
        const update = () => { if (this.active === session) this.publish(); };
        session.stopProvider = provider.subscribe(update); update();
    }
    attach(id: string, tab: TabId, editor: TextEditor, presentation: EditingPresentation): () => void {
        if (this.sessions.has(id)) throw new Error("Language view already mounted.");
        const target = this.workspace.tabs.capture(tab), session: Session = { id, target, editor, presentation, initialized: false }, listeners = new AbortController();
        this.bindCommands(session, listeners);
        this.sessions.set(id, session); this.attachProvider(session);
        onSourceFocus(editor, listeners.signal, () => this.activate(session));
        this.resume(session); return this.detachSession(session, listeners);
    }
    attachReference(id: string, editor: TextEditor, presentation: EditingPresentation, reference: () => ComparisonBaseline | null, target: TabTarget): () => void {
        if (this.sessions.has(id)) throw new Error("Find view already mounted.");
        const session: Session = { id, target, editor, presentation, initialized: true, reference }, listeners = new AbortController();
        if (!this.ownsSession(session)) throw new Error("Reference Find requires its captured view and baseline.");
        this.bindCommands(session, listeners);
        this.sessions.set(id, session);
        onSourceFocus(editor, listeners.signal, () => this.activate(session));
        // A host remount can restore the logical field target while the toolbar has focus.
        this.resume(session);
        return this.detachSession(session, listeners);
    }
    private ownsSession(session: Session): boolean {
        const surface = this.workspace.tabs.resolve(session.target)?.surface, view = session.editor.view;
        if (surface?.kind !== "text" || !this.workspace.ownsDocumentView(view) || session.editor.signal.aborted) return false;
        if (!session.reference) return surface.documentId === view.documentId;
        const reference = session.reference();
        return reference !== null && this.workspace.document(view.documentId).buffer === reference.buffer;
    }
    private bindCommands(session: Session, listeners: AbortController): void {
        const { editor } = session;
        try {
            const binding = this.find.attach(editor);
            listeners.signal.addEventListener("abort", binding.dispose, { once: true });
            const register = scopedCommands(editor, listeners.signal);
            for (const [id, label, code, apply] of [
                ["fold.selection", "Fold selected lines", "BracketLeft", () => this.collapseSelection(session)],
                ["fold.expand-all", "Expand all folds", "BracketRight", () => this.expandRegions(session)]
            ] as const) {
                register({ id, label,
                    enabled: () => this.ownsSession(session) && editor.element.isConnected,
                    run: () => { this.activate(session); apply(); } }, { keys: ["Mod+Shift+Code:" + code] });
            }
        } catch (error) { listeners.abort(); throw error; }
    }
    private toolsSession(event: KeyboardEvent): Session | undefined {
        const root = this.toolsElement, target = event.target, realm = root?.ownerDocument.defaultView, session = this.active;
        if (event.defaultPrevented || event.isComposing || !root?.isConnected || !realm || !(target instanceof realm.HTMLElement) || !root.contains(target) || !session
            || (target.closest("button,input,select,textarea") ?? target).matches(":disabled") || !session.editor.element.isConnected
            || session.editor.activity().disposed || session.editor.activity().input === "composing" || !this.workspace.ownsDocumentView(session.editor.view)) return;
        if (!this.ownsSession(session)) return;
        return session;
    }
    readonly keyFromTools = (event: KeyboardEvent): void => {
        this.toolsSession(event)?.editor.keymap.handle(event);
    };
    private detachSession(session: Session, listeners: AbortController): () => void {
        let detached = false;
        return () => {
            if (detached) return; detached = true;
            if (this.active === session) {
                const reference = session.reference?.();
                this.detachedOwner = Object.freeze({ id: session.id, target: session.target, documentId: session.editor.view.documentId, ...(reference ? { reference } : {}) });
                this.stopFolds?.(); this.stopFolds = undefined;
            }
            session.stopProvider?.();
            listeners.abort();
            session.provider?.dispose(); session.presentation.clear(); this.sessions.delete(session.id);
            if (this.active === session) this.active = undefined; this.publish();
        };
    }
    readonly request = (): void => { if (this.active) { this.activate(this.active); this.active.provider?.request(); } };
    readonly disconnect = (): void => { this.active?.provider?.disconnect(); };
    readonly reconnect = (): void => {
        const session = this.active; if (!session || session.reference) return;
        if (!session.provider) this.attachProvider(session); else session.provider.disconnect();
        session.initialized = true; session.provider?.connect();
    };
    readonly focusEditor = (): void => { this.active?.editor.focus(); };
    private foldTarget(): Session | undefined {
        const session = this.active; if (!session) return;
        if (!this.ownsSession(session) || !session.editor.element.isConnected) return;
        if (session.editor.activity().input === "composing") { this.cell.set({ ...this.cell.get(), foldMessage: "Finish composition before folding." }); return; }
        return session;
    }
    readonly foldSelection = (): void => { this.foldTarget()?.editor.commands.run("fold.selection"); };
    readonly expandFolds = (): void => { this.foldTarget()?.editor.commands.run("fold.expand-all"); };
    private collapseSelection(session: Session): void {
        const { editor } = session, document = this.workspace.document(editor.view.documentId), selected = editor.view.getSnapshot().selectionSet;
        const current = editor.view.folding.getSnapshot(), ranges: FoldRange[] = [...current.regions], ids = new Set(ranges.map(r => r.id)); let count = 0;
        const selections = selected.ranges.map(selection => {
            const low = Math.min(selection.anchor, selection.head), high = Math.max(selection.anchor, selection.head), first = document.buffer.lineAt(low), last = document.buffer.lineAt(high > low ? high - 1 : high);
            let existing: FoldRegion | undefined;
            for (const r of current.regions) { if (first === last ? r.lineFrom <= first && first < r.lineTo : r.lineFrom === first) existing = r; }
            if (first === last && !existing) return selection;
            const from = existing && first === last ? existing.from : document.buffer.offsetAt(first);
            const to = existing && first === last ? existing.to : last + 1 < document.buffer.lineCount ? document.buffer.offsetAt(last + 1) : document.buffer.length;
            let id = existing?.id;
            if (!id) {
                do { id = `selection-fold-${this.workspace.allocateIdentity()}`; } while (ids.has(id));
            }
            const at = ranges.findIndex(r => r.id === id); if (at < 0) ranges.push({ id, from, to, collapsed: true }); else ranges[at] = { id, from, to, collapsed: true };
            count++; const head = document.buffer.offsetAt(document.buffer.lineAt(from)); return { anchor: head, head };
        });
        if (!count) { this.cell.set({ ...this.cell.get(), foldMessage: "Select multiple lines to create a fold." }); return; }
        try {
            if (!editor.view.folding.setRanges(current, ranges)) return;
            editor.view.setSelections(document.revision, selections, selected.primary); editor.viewport.revealOffset(editor.view.getSnapshot().selection.head, { horizontal: "nearest", vertical: "nearest" }); editor.focus();
            this.cell.set({ ...this.cell.get(), foldMessage: `Folded ${count} ${count === 1 ? "region" : "regions"}.` });
        } catch (error) { if (!(error instanceof RangeError)) throw error; this.cell.set({ ...this.cell.get(), foldMessage: "Select nested or separate line regions." }); }
    }
    private expandRegions(session: Session): void {
        const folds = session.editor.view.folding, current = folds.getSnapshot();
        if (current.index.collapsedCount) {
            const ids = current.regions.filter(region => region.collapsed).map(region => region.id);
            if (!folds.setCollapsed(current, ids, false)) return;
        }
        session.editor.viewport.revealOffset(session.editor.view.getSnapshot().selection.head, { horizontal: "nearest", vertical: "nearest" }); session.editor.focus();
        this.cell.set({ ...this.cell.get(), foldMessage: "All folds expanded." });
    }
    setDelay(value: number): void { this.active?.provider?.setDelay(value); }
    debug() {
        const sessions = [...this.sessions.values()];
        return {
            active: this.active?.id ?? null,
            subscriptions: this.cell.count(),
            referenceViews: sessions.filter(s => s.reference).map(s => ({
                id: s.id, documentId: s.editor.view.documentId, viewId: s.editor.view.id
            })),
            sessions: sessions.flatMap(s => {
                if (!s.provider) return [];
                const { connected, pending, diagnosticRevision, diagnosticsPending } = s.provider.getSnapshot();
                const folds = s.editor.view.folding.getSnapshot();
                return [{
                    id: s.id, documentId: s.editor.view.documentId, viewId: s.editor.view.id,
                    foldRegions: folds.regions.length, collapsedFolds: folds.index.collapsedCount,
                    provider: { connected, pending, diagnosticRevision, diagnosticsPending }, presentation: s.presentation.snapshot()
                }];
            })
        };
    }
}
