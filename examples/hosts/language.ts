import { createFindController, createRegexFindBackend } from "../../src/browser/index.ts";
import type { TextEditor, FindController, FindSnapshot } from "../../src/browser/index.ts";
import type { ComparisonBaseline, DocumentId, FoldRange, FoldRegion, FoldingSnapshot, TabId, TabTarget, Workspace } from "../../src/index.ts";
import type { ProviderController, ProviderFactory, ProviderSnapshot } from "../shared/language/provider-contract.ts";
import { completionPageSize } from "../shared/language/completion-list.ts";
import type { JsonValue } from "../../src/protocol/index.ts";
import { EditingPresentation } from "../shared/language/presentation.ts";
import { HostCell } from "../shared/observable.ts";

type Session = { id: string; editor: TextEditor; target: TabTarget; presentation: EditingPresentation;
    provider?: ProviderController; stopProvider?: () => void; providerError?: string; reference?: () => ComparisonBaseline | null; find?: FindController; stopFind?: () => void; initialized: boolean };
type DetachedOwner = Readonly<{ id: string; target: TabTarget; documentId: DocumentId; reference?: ComparisonBaseline }>;
type FindCommand = Readonly<{ kind: "navigate"; direction: 1 | -1 } | { kind: "replace"; text: string }>;

type SaveShortcut = (event: KeyboardEvent, control: HTMLElement, target: TabTarget, composing: () => boolean) => void;
type LanguageSnapshot = Readonly<{ readOnlyReference: boolean; view: string | null; provider: ProviderSnapshot | null; providerError: string | null; find: FindSnapshot | null; folds: FoldingSnapshot | null; foldMessage: string; query: string; replacement: string; wholeWord: boolean; matchCase: boolean; regularExpression: boolean }>;

/** Host-owned tools follow an explicit mounted view; delayed commands never consult focus later. */
export class HostLanguageTools {
    private readonly workspace: Workspace;
    private readonly saveShortcut: SaveShortcut;
    private readonly providerFactory: ProviderFactory;
    private readonly canCapture: (documentId: DocumentId) => boolean;
    private readonly sessions = new Map<string, Session>();
    private active: Session | undefined;
    private detachedOwner: DetachedOwner | undefined;
    private stopFolds: (() => void) | undefined;
    private pendingFind: { kind: FindCommand["kind"]; session: Session; stop: () => void } | undefined;
    private foldSerial = 0;
    private readonly cell = new HostCell<LanguageSnapshot>({ readOnlyReference: false, view: null, provider: null, providerError: null, find: null, folds: null, foldMessage: "", query: "", replacement: "", wholeWord: false, matchCase: true, regularExpression: false });
    readonly state = this.cell.observable;
    private queryElement: HTMLInputElement | null = null;
    private replacementElement: HTMLInputElement | null = null;
    private toolsElement: HTMLElement | null = null;
    readonly queryRef = (element: HTMLInputElement | null): void => { this.queryElement = element; };
    readonly replacementRef = (element: HTMLInputElement | null): void => { this.replacementElement = element; };
    readonly toolsRef = (element: HTMLElement | null): void => { if (this.toolsElement !== element) this.cancelFindCommand(); this.toolsElement = element; };
    private retired = { posted: 0, applied: 0, stale: 0, cancelled: 0, invalid: 0, failed: 0, postedUnits: 0 };
    constructor(workspace: Workspace, saveShortcut: SaveShortcut, options: Readonly<{ providerFactory: ProviderFactory; canCapture?: (documentId: DocumentId) => boolean }>) {
        this.workspace = workspace; this.saveShortcut = saveShortcut; this.providerFactory = options.providerFactory; this.canCapture = options.canCapture ?? (() => true);
    }
    private publish(): void {
        const previous = this.cell.get(), folds = this.active?.editor.view.folding.getSnapshot() ?? null;
        this.cell.set({ ...previous, readOnlyReference: this.active?.reference !== undefined, view: this.active?.id ?? null, provider: this.active?.provider?.getSnapshot() ?? null,
            providerError: this.active?.providerError ?? null, find: this.active?.find?.getSnapshot() ?? null, folds, foldMessage: folds === previous.folds ? previous.foldMessage : "" });
    }
    private activate(session: Session, initialize = true): void {
        this.detachedOwner = undefined;
        if (this.active !== session) {
            this.cancelFindCommand();
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
        const reference = session.reference?.();
        const compatible = previous.reference && reference
            ? previous.reference.buffer === reference.buffer && previous.reference.version === reference.version
            : !previous.reference && !session.reference && previous.documentId === session.editor.view.documentId
                && previous.target.workspace === session.target.workspace && previous.target.id === session.target.id && previous.target.generation === session.target.generation;
        // A new attachment owns new jobs. Restoring the logical context starts none and never focuses.
        if (compatible && !this.active) this.activate(session, false);
    }
    clearRetainedView(): void { this.cancelFindCommand(); this.detachedOwner = undefined; }
    private attachProvider(session: Session): void {
        const { editor } = session;
        let provider: ProviderController;
        try { provider = this.providerFactory(editor, { autoConnect: false, canCapture: () => this.canCapture(editor.view.documentId),
            getPageSize: () => completionPageSize(this.toolsElement?.querySelector<HTMLElement>('[role="listbox"]')) }); }
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
        this.sessions.set(id, session); this.attachProvider(session);
        editor.input.addEventListener("focus", () => this.activate(session), { signal: listeners.signal });
        editor.input.addEventListener("keydown", event => {
            if (event.isComposing || editor.activity().composing || event.defaultPrevented) return;
            if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && (event.code === "BracketLeft" || event.code === "BracketRight")) {
                event.preventDefault(); this.activate(session); if (event.code === "BracketLeft") this.foldSelection(); else this.expandFolds();
            } else if (this.findKey(event, session)) return;
            else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.code === "Space") { event.preventDefault(); this.activate(session); session.provider?.request(); }
            else if (event.altKey && event.key === "Enter" && session.provider?.getSnapshot().offerText != null) { event.preventDefault(); const state = session.provider.getSnapshot(); state.completionAt(state.choiceIndex ?? 0)?.accept("replace"); }
            else if (event.key === "Escape" && (session.provider?.getSnapshot().pending || session.provider?.getSnapshot().offerText != null)) { event.preventDefault(); session.provider?.cancel(); }
        }, { signal: listeners.signal });
        this.resume(session); return this.detachSession(session, listeners);
    }
    attachReferenceFind(id: string, editor: TextEditor, presentation: EditingPresentation, reference: () => ComparisonBaseline | null, target: TabTarget): () => void {
        if (this.sessions.has(id)) throw new Error("Find view already mounted.");
        const session: Session = { id, target, editor, presentation, initialized: true, reference }, listeners = new AbortController();
        if (!this.ownsSession(session)) throw new Error("Reference Find requires its captured view and baseline.");
        this.sessions.set(id, session);
        editor.input.addEventListener("focus", () => this.activate(session), { signal: listeners.signal });
        editor.input.addEventListener("keydown", event => { if (!event.defaultPrevented && !event.isComposing && !editor.activity().composing) this.findKey(event, session); }, { signal: listeners.signal });
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
    private findKey(event: KeyboardEvent, session: Session): boolean {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && ["f", "h"].includes(event.key.toLowerCase())) {
            this.cancelFindCommand();
            event.preventDefault(); this.activate(session); this.ensureFind();
            const field = session.reference || event.key.toLowerCase() === "f" ? this.queryElement : this.replacementElement;
            field?.focus(); field?.select(); return true;
        }
        if (event.key === "F3") { event.preventDefault(); this.activate(session); this.runFind(session, { kind: "navigate", direction: event.shiftKey ? -1 : 1 }); return true; }
        return false;
    }
    private cancelFindCommand(session?: Session): void {
        if (!session || this.pendingFind?.session === session) this.pendingFind?.stop();
    }
    private runFind(session: Session, command: FindCommand): void {
        if (command.kind === "replace" && session.reference) return;
        this.cancelFindCommand();
        const find = this.ensureFind(); if (!find) return;
        const captured = find.getSnapshot();
        const execute = () => command.kind === "navigate" ? find.next(command.direction) : find.replaceCurrent(command.text);
        if (captured.status === "ready") { execute(); return; }
        if (captured.status !== "searching") return;
        if (captured.retained && execute()) return;
        const metadata = this.workspace.resourceForDocument(session.editor.view.documentId).metadata;
        const authority = () => { const m = metadata.getSnapshot(); return JSON.stringify([m.state, m.capabilities.edit, m.editLock]); };
        const capturedAuthority = command.kind === "replace" ? authority() : undefined, access = metadata.getSnapshot();
        if (command.kind === "replace" && (access.state !== "ready" || !access.capabilities.edit.includes("human") || access.editLock !== null)) return;
        const editor = session.editor, owner = editor.element.ownerDocument, clock = owner.defaultView!, origin = owner.activeElement;
        if (!(origin instanceof clock.HTMLElement) || !editor.element.contains(origin) && !this.toolsElement?.contains(origin)) return;
        const selections = editor.view.getSnapshot().selectionSet, listeners = new AbortController(), stops: (() => void)[] = [];
        let disability: MutationObserver | undefined;
        let stopped = false, queued = false;
        const stop = () => { if (stopped) return; stopped = true; listeners.abort(); disability?.disconnect(); for (const unsubscribe of stops) unsubscribe();
            if (this.pendingFind?.stop === stop) this.pendingFind = undefined; };
        const current = () => {
            if (disability?.takeRecords().length) return false;
            const state = find.getSnapshot();
            return this.active === session && this.sessions.get(session.id) === session && session.find === find
                && (capturedAuthority === undefined || authority() === capturedAuthority)
                && origin.isConnected && owner.activeElement === origin && !(origin.closest("button,input,select,textarea") ?? origin).matches(":disabled")
                && editor.element.isConnected && !editor.activity().disposed && !editor.activity().composing && this.workspace.ownsDocumentView(editor.view)
                && this.ownsSession(session)
                && this.workspace.document(editor.view.documentId).revision === captured.revision && editor.view.getSnapshot().selectionSet === selections
                && state.revision === captured.revision && state.query === captured.query && state.wholeWord === captured.wholeWord
                && state.matchCase === captured.matchCase && state.regularExpression === captured.regularExpression
                && (state.status === "searching" || state.status === "ready");
        };
        const changed = () => {
            if (stopped) return;
            if (!current()) { stop(); return; }
            if (!queued && find.getSnapshot().status === "ready") {
                queued = true;
                // Observable delivery rejects reentrant commands. Revalidate after the delivery ends.
                clock.queueMicrotask(() => { if (stopped) return; const valid = current(); stop(); if (valid) execute(); });
            }
        };
        this.pendingFind = { kind: command.kind, session, stop };
        // Native blur may follow a render that reenables the control. A disabled transition still expires the command.
        disability = new clock.MutationObserver(stop);
        for (let node: HTMLElement | null = origin; node; node = node.parentElement) disability.observe(node, { attributes: true, attributeFilter: ["disabled"] });
        origin.addEventListener("blur", stop, { signal: listeners.signal });
        origin.addEventListener("input", stop, { signal: listeners.signal });
        origin.addEventListener("compositionstart", stop, { signal: listeners.signal });
        editor.input.addEventListener("compositionstart", stop, { signal: listeners.signal });
        clock.addEventListener("blur", stop, { signal: listeners.signal });
        stops.push(find.subscribe(changed), this.workspace.observeDocument(editor.view.documentId).subscribe(changed), editor.view.subscribe(changed), this.workspace.tabs.subscribe(changed));
        if (command.kind === "replace") stops.push(metadata.subscribe(changed));
        changed();
    }
    private toolsSession(event: KeyboardEvent): { session: Session; control: HTMLElement } | undefined {
        const root = this.toolsElement, target = event.target, realm = root?.ownerDocument.defaultView, session = this.active;
        if (event.defaultPrevented || event.isComposing || !root?.isConnected || !realm || !(target instanceof realm.HTMLElement) || !root.contains(target) || !session
            || (target.closest("button,input,select,textarea") ?? target).matches(":disabled") || !session.editor.element.isConnected
            || session.editor.activity().disposed || session.editor.activity().composing || !this.workspace.ownsDocumentView(session.editor.view)) return;
        if (!this.ownsSession(session)) return;
        return { session, control: target };
    }
    readonly keyFromTools = (event: KeyboardEvent): void => {
        const key = event.key.toLowerCase(), modified = event.ctrlKey || event.metaKey;
        const save = modified && key === "s", find = key === "f3" || modified && !event.altKey && (key === "f" || key === "h");
        const replacement = event.target === this.replacementElement, enter = key === "enter" && (replacement || event.target === this.queryElement);
        if (!save && !find && !enter && key !== "escape") return;
        const owned = this.toolsSession(event); if (!owned) return;
        if (save) this.saveShortcut(event, owned.control, owned.session.target, () => owned.session.editor.activity().composing);
        else if (find) this.findKey(event, owned.session);
        else if (enter) { event.preventDefault(); if (replacement) this.replaceCurrent(); else if (event.shiftKey) this.previous(); else this.next(); }
        else { event.preventDefault(); owned.session.find?.cancel(); owned.session.editor.focus(); }
    };
    private detachSession(session: Session, listeners: AbortController): () => void {
        let detached = false;
        return () => {
            if (detached) return; detached = true;
            this.cancelFindCommand(session);
            if (this.active === session) {
                const reference = session.reference?.();
                this.detachedOwner = Object.freeze({ id: session.id, target: session.target, documentId: session.editor.view.documentId, ...(reference ? { reference } : {}) });
                this.stopFolds?.(); this.stopFolds = undefined;
            }
            session.stopProvider?.(); listeners.abort(); session.stopFind?.(); session.find?.dispose();
            const counts = session.provider?.snapshot(); if (counts) for (const key of Object.keys(this.retired) as (keyof typeof this.retired)[]) this.retired[key] += counts[key] ?? 0;
            session.provider?.dispose(); session.presentation.clear(); this.sessions.delete(session.id);
            if (this.active === session) this.active = undefined; this.publish();
        };
    }
    private ensureFind(): FindController | undefined {
        const session = this.active; if (!session) return;
        if (!session.find) {
            const clock = session.editor.element.ownerDocument.defaultView!;
            session.find = createFindController(session.editor, { regularExpressionBackend: createRegexFindBackend({ clock,
                createWorker: () => new Worker("/regex-worker.js", { type: "module" }) }) });
            session.stopFind = session.find.subscribe(() => { if (this.active === session) this.publish(); });
        }
        const state = session.find.getSnapshot(), { query, wholeWord, matchCase, regularExpression } = this.cell.get();
        if (state.wholeWord !== wholeWord || state.matchCase !== matchCase || state.regularExpression !== regularExpression) session.find.setFlags({ wholeWord, matchCase, regularExpression });
        if (state.query !== query || state.status === "cancelled") session.find.setQuery(query);
        return session.find;
    }
    readonly request = (): void => { if (this.active) { this.activate(this.active); this.active.provider?.request(); } };
    readonly cancel = (): void => { this.active?.provider?.cancel(); };
    readonly disconnect = (): void => { this.active?.provider?.disconnect(); };
    readonly reconnect = (): void => {
        const session = this.active; if (!session || session.reference) return;
        if (!session.provider) this.attachProvider(session); else session.provider.disconnect();
        session.initialized = true; session.provider?.connect();
    };
    readonly setQuery = (query: string): void => { this.cancelFindCommand(); this.cell.set({ ...this.cell.get(), query }); this.ensureFind(); };
    readonly setWholeWord = (wholeWord: boolean): void => { this.cancelFindCommand(); this.cell.set({ ...this.cell.get(), wholeWord }); this.ensureFind(); };
    readonly setMatchCase = (matchCase: boolean): void => { this.cancelFindCommand(); this.cell.set({ ...this.cell.get(), matchCase }); this.ensureFind(); };
    readonly setRegularExpression = (regularExpression: boolean): void => { this.cancelFindCommand(); this.cell.set({ ...this.cell.get(), regularExpression }); this.ensureFind(); };
    readonly setReplacement = (replacement: string): void => { if (this.pendingFind?.kind === "replace") this.cancelFindCommand(); this.cell.set({ ...this.cell.get(), replacement }); };
    readonly next = (): void => { if (this.active) this.runFind(this.active, { kind: "navigate", direction: 1 }); };
    readonly previous = (): void => { if (this.active) this.runFind(this.active, { kind: "navigate", direction: -1 }); };
    readonly replaceCurrent = (): void => { if (this.active) this.runFind(this.active, { kind: "replace", text: this.cell.get().replacement }); };
    readonly replaceAll = (): void => { if (this.active?.reference) return; this.ensureFind()?.replaceAll(this.cell.get().replacement, { focusEditor: true }); };
    readonly cancelFind = (): void => { this.active?.find?.cancel(); this.active?.editor.focus(); };
    readonly focusEditor = (): void => { this.active?.editor.focus(); };
    private foldTarget(): Session | undefined {
        const session = this.active; if (!session) return;
        if (!this.ownsSession(session) || !session.editor.element.isConnected) return;
        if (session.editor.activity().composing) { this.cell.set({ ...this.cell.get(), foldMessage: "Finish composition before folding." }); return; }
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
    customRequest(method: string, params: JsonValue): Promise<JsonValue> {
        const provider = this.active?.provider; if (!provider?.customRequest) return Promise.reject(new Error("The active provider has no custom-message extension.")); return provider.customRequest(method, params);
    }
    setDelay(value: number): void { this.active?.provider?.setDelay(value); }
    faultNext(value: "malformed" | "failure"): void { this.active?.provider?.faultNext(value); }
    debug() { return { active: this.active?.id ?? null, navigationPending: this.pendingFind?.kind === "navigate", findCommandPending: this.pendingFind?.kind ?? null, subscriptions: this.cell.count(), referenceFind: [...this.sessions.values()].filter(s => s.reference).map(s => ({ id: s.id, documentId: s.editor.view.documentId, viewId: s.editor.view.id, find: s.find?.getSnapshot() ?? null })), sessions: [...this.sessions.values()].flatMap(s => s.provider ? [{ id: s.id, documentId: s.editor.view.documentId,
        viewId: s.editor.view.id, foldRegions: s.editor.view.folding.getSnapshot().regions.length, collapsedFolds: s.editor.view.folding.getSnapshot().index.collapsedCount, provider: s.provider.snapshot(), presentation: s.presentation.snapshot() }] : []), retired: { ...this.retired } }; }
}
