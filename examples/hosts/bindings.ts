import { mountEditingCandidate, mountTextComparison, mountTextEditor } from "../../src/browser/index.ts";
import type { EditingCandidate, MountedEditor, TextComparison, ViewportSnapshot, ViewState } from "../../src/browser/index.ts";
import type { ComparisonBaseline, ComparisonTicket, DocumentId, DocumentView, Selection, TabId } from "../../src/index.ts";
import type { HostController } from "./controller.ts";
import { EditingPresentation } from "../editing/presentation.ts";
import { HostLanguageTools } from "./language.ts";

export type HostEditor = "native" | "candidate";
type BoundEditor = MountedEditor & Readonly<{ metrics: () => null | ReturnType<EditingCandidate["snapshot"]> & Readonly<{ viewport: ViewportSnapshot }> }>;
export function hostEditor(): HostEditor { return new URLSearchParams(location.search).get("editor") === "candidate" ? "candidate" : "native"; }

/** Stable refs own editor descendants; the controller and resource IDs survive every detach. */
export class ViewBindings {
    private readonly controller: HostController;
    private readonly mounted = new Map<string, { editor: BoundEditor; documentId: DocumentId }>();
    readonly editor: HostEditor;
    private readonly states = new Map<string, Map<DocumentId, ViewState>>();
    private readonly selections = new Map<string, Map<DocumentId, DocumentView>>();
    private mounts = 0;
    private destroys = 0;
    private review: TextComparison | undefined;
    readonly language: HostLanguageTools;
    private detachReviewLanguage: (() => void) | undefined;
    private referenceState: Readonly<{ baseline: ComparisonBaseline; state: ViewState }> | undefined;
    private reviewStatus: HTMLOutputElement | undefined;
    private reviewListeners: AbortController | undefined;
    private readonly reviewTickets: ComparisonTicket[] = [];
    private referenceSerial = 0;
    private reviewResult = "No reference command";
    private unwatchReference: (() => void) | undefined;
    private referenceGeneration = -1;
    readonly primary: (host: HTMLDivElement | null) => void;
    readonly secondary: (host: HTMLDivElement | null) => void;
    readonly comparison = (host: HTMLDivElement | null): void => {
        this.unwatchReference?.(); this.unwatchReference = undefined;
        for (const ticket of this.reviewTickets.splice(0)) ticket.cancel();
        if (this.review) {
            const baseline = this.review.controller.getSnapshot().baseline, reference = this.review.referenceViewport();
            if (baseline && reference) this.referenceState = { baseline, state: reference.captureView() };
            if (this.review.controller.getSnapshot().working) this.retainState("comparison", this.review.working.view.documentId, this.review.working.captureView());
        }
        this.detachReviewLanguage?.(); this.detachReviewLanguage = undefined;
        this.review?.destroy(); this.review = undefined; this.reviewListeners?.abort(); this.reviewListeners = undefined;
        this.reviewStatus?.remove(); this.reviewStatus = undefined;
        if (!host) return;
        this.reviewStatus = host.ownerDocument.createElement("output"); this.reviewStatus.setAttribute("aria-label", "Reference operation status");
        this.reviewStatus.setAttribute("aria-live", "polite"); this.reviewStatus.textContent = this.reviewResult; host.append(this.reviewStatus);
        const publication = this.controller.comparisonReference.getSnapshot(), baseline = publication.baseline;
        this.referenceGeneration = publication.generation;
        const view = this.retainedView("comparison", this.controller.source.documentId);
        const presentation = new EditingPresentation(), referencePresentation = new EditingPresentation();
        this.review = mountTextComparison(host, this.controller.workspace, this.controller.viewTab("primary"),
            baseline, { ariaLabel: "Source review", view, workingDecorate: presentation.decorate, baselineDecorate: referencePresentation.decorate });
        const detachLanguage = this.language.attach("comparison", this.controller.viewTab("primary"), this.review.working, presentation);
        this.detachReviewLanguage = () => { detachLanguage(); referencePresentation.clear(); };
        const state = this.states.get("comparison")?.get(view.documentId);
        if (state) this.review.working.restoreView(this.restoreState(state, view));
        if (this.referenceState?.baseline.buffer === baseline.buffer && this.referenceState.baseline.version === baseline.version)
            this.review.referenceViewport()?.restoreView(this.referenceState.state);
        else this.referenceState = undefined;
        const documentId = this.review.working.view.documentId;
        this.reviewListeners = new AbortController();
        this.review.working.input.addEventListener("sttropez-conflict", event => this.controller.captureInputConflict(documentId, (event as CustomEvent<unknown>).detail), { signal: this.reviewListeners.signal });
        const working = this.review.working;
        this.bindSaveShortcut(working.input, this.controller.viewTab("primary"), () => working.snapshot().composing, this.reviewListeners.signal);
        this.unwatchReference = this.controller.comparisonReference.subscribe(() => this.updateReference());
    };
    private bindSaveShortcut(input: HTMLTextAreaElement, tabId: TabId, composing: () => boolean, signal: AbortSignal): void {
        const workspace = this.controller.workspace, target = workspace.captureTab(tabId);
        input.addEventListener("keydown", event => {
            if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "s"
                || event.defaultPrevented || event.isComposing || input.disabled || !input.isConnected || composing()) return;
            const tab = workspace.resolveTab(target);
            if (tab?.surface.kind !== "text" || tab.surface.documentId !== this.controller.source.documentId) return;
            event.preventDefault();
            if (!event.repeat) this.controller.save();
        }, { signal });
    }
    private beginReference(kind: "refresh" | "accept"): void {
        if (!this.review) return;
        try {
            const ticket = kind === "refresh" ? this.review.controller.beginRefresh() : this.review.controller.beginAcceptance();
            this.reviewTickets.push(ticket); this.reviewResult = `Captured ${kind} at revision ${ticket.capture.working.revision}`;
            this.reviewStatus!.textContent = this.reviewResult;
        } catch (error) { this.controller.reportError(error); }
    }
    private finishReference(kind: "refresh" | "accept"): void {
        const index = this.reviewTickets.findIndex(ticket => ticket.kind === kind);
        if (index < 0 || !this.review) return;
        const ticket = this.reviewTickets.splice(index, 1)[0]!;
        try {
            const baseline = kind === "refresh" ? this.controller.savedComparisonReference()
                : { buffer: ticket.capture.working.buffer, version: `reference:accepted-${++this.referenceSerial}-r${ticket.capture.working.revision}` };
            const applied = ticket.complete(baseline);
            if (applied) this.controller.retainComparisonReference(this.review.controller.getSnapshot().baseline!);
            this.reviewResult = `${kind} ${applied ? "applied" : "expired"}`;
            this.reviewStatus!.textContent = this.reviewResult;
        } catch (error) { this.controller.reportError(error); } finally { ticket.finish(); }
    }
    readonly beginReferenceRefresh = (): void => this.beginReference("refresh");
    readonly finishReferenceRefresh = (): void => this.finishReference("refresh");
    readonly beginReviewAcceptance = (): void => this.beginReference("accept");
    readonly finishReviewAcceptance = (): void => this.finishReference("accept");
    referenceRange(from: number, to: number): string | undefined { return this.review?.controller.getSnapshot().baseline?.buffer.slice(from, to); }
    selectSource(id: "primary" | "secondary", revision: number, selection: Selection): boolean {
        return this.mounted.get(id)?.editor.view.setSelection(revision, selection) ?? false;
    }
    selectSourceSet(id: "primary" | "secondary" | "comparison", revision: number, ranges: readonly Selection[], primary = 0): boolean {
        const view = id === "comparison" ? this.review?.working.view : this.mounted.get(id)?.editor.view;
        return view?.setSelections(revision, ranges, primary) ?? false;
    }
    constructor(controller: HostController, editor: HostEditor = "native") {
        this.controller = controller; this.editor = editor; this.language = new HostLanguageTools(controller.workspace);
        this.primary = this.ref("primary", "Primary source");
        this.secondary = this.ref("secondary", "Secondary source");
    }
    private updateReference(): void {
        const review = this.review, current = review?.controller.getSnapshot().baseline;
        if (!review || !current) return;
        const publication = this.controller.comparisonReference.getSnapshot(), next = publication.baseline;
        if (current.buffer === next.buffer && current.version === next.version && this.referenceGeneration === publication.generation) return;
        // A host reference publication expires older captures; the working view still owns
        // its input, selection, provider target and pending commands on the same document.
        for (const ticket of this.reviewTickets.splice(0)) ticket.cancel();
        try {
            const ticket = review.controller.beginRefresh();
            try { if (ticket.complete(next)) { this.referenceState = undefined; this.referenceGeneration = publication.generation; } }
            finally { ticket.finish(); }
        } catch (error) { this.controller.reportError(error); }
    }
    private retainedView(id: string, documentId: DocumentId): DocumentView {
        const selections = this.selections.get(id) ?? new Map<DocumentId, DocumentView>();
        let view = selections.get(documentId);
        if (!view) { view = this.controller.workspace.createDocumentView(documentId); selections.set(documentId, view); this.selections.set(id, selections); }
        return view;
    }
    private retainState(id: string, documentId: DocumentId, state: ViewState): void {
        const states = this.states.get(id) ?? new Map<DocumentId, ViewState>();
        states.set(documentId, state); this.states.set(id, states);
    }
    private restoreState(state: ViewState, view: DocumentView): ViewState {
        const { selection, selectionSet } = view.getSnapshot(), at = state.horizontalAnchor;
        // A caret anchor can follow the host-owned selection mapped during detach.
        // Other viewport anchors retain their original revision and validation rules.
        const followsCaret = at && at.offset === state.head && at.affinity === (state.headAffinity ?? "after");
        return { ...state, ...selection, selectionSet, ...(followsCaret ? { horizontalAnchor: { ...at,
            revision: this.controller.workspace.document(view.documentId).revision,
            offset: selection.head, affinity: selection.headAffinity ?? "after" } } : {}) };
    }
    private ref(id: "primary" | "secondary", ariaLabel: string): (host: HTMLDivElement | null) => void {
        return host => {
            this.detach(id);
            if (host === null) return;
            const workspace = this.controller.workspace, tabId = this.controller.viewTab(id);
            const tab = workspace.resolveTab(workspace.captureTab(tabId));
            if (tab?.surface.kind !== "text") throw new Error("Text view requires a text tab.");
            const documentId = tab.surface.documentId;
            const view = this.retainedView(id, documentId);
            const presentation = new EditingPresentation();
            const candidate = this.editor === "candidate" ? mountEditingCandidate(host, workspace, tabId, { ariaLabel, view, decorate: presentation.decorate }) : undefined;
            const detachLanguage = candidate ? this.language.attach(id, tabId, candidate, presentation) : undefined;
            const mounted: BoundEditor = candidate ? { element: candidate.input, view, captureView: candidate.captureView,
                restoreView: candidate.restoreView, destroy: candidate.destroy,
                metrics: () => ({ ...candidate.snapshot(), viewport: candidate.viewport.snapshot() }) }
                : { ...mountTextEditor(host, workspace, tabId, { ariaLabel, view }), metrics: () => null };
            const listeners = new AbortController();
            mounted.element.addEventListener("sttropez-conflict", event => this.controller.captureInputConflict(documentId, (event as CustomEvent<unknown>).detail), { signal: listeners.signal });
            this.bindSaveShortcut(mounted.element, tabId, () => candidate?.snapshot().composing ?? false, listeners.signal);
            const editor: BoundEditor = { ...mounted, destroy: () => { try { detachLanguage?.(); mounted.destroy(); } finally { listeners.abort(); } } };
            const state = this.states.get(id)?.get(documentId); if (state) editor.restoreView(this.restoreState(state, view));
            this.mounted.set(id, { editor, documentId }); this.mounts++;
        };
    }
    private detach(id: string): void {
        const mounted = this.mounted.get(id); if (!mounted) return;
        this.retainState(id, mounted.documentId, mounted.editor.captureView());
        mounted.editor.destroy(); this.mounted.delete(id); this.destroys++;
    }
    unmount(): void { for (const id of [...this.mounted.keys()]) this.detach(id); }
    dispose(): void {
        this.comparison(null); this.unmount(); for (const selections of this.selections.values()) for (const view of selections.values()) view.dispose();
        this.selections.clear(); this.states.clear(); this.referenceState = undefined;
    }
    debug() {
        const comparison = this.review?.controller.getSnapshot();
        return { editor: this.editor, mounts: this.mounts, destroys: this.destroys, activeViews: this.mounted.size, language: this.language.debug(),
        comparison: comparison ? { status: comparison.status, generation: comparison.generation, workingRevision: comparison.working?.revision,
            referenceIsWorkingBuffer: comparison.baseline !== null && comparison.baseline.buffer === comparison.working?.buffer,
            progress: comparison.progress && { work: comparison.progress.work, readUnits: comparison.progress.readUnits,
                lineComparisons: comparison.progress.lineComparisons, lineEdits: comparison.progress.lineEdits },
            viewId: this.review!.working.view.id, selection: this.review!.working.view.getSnapshot().selection, selectionSet: this.review!.working.view.getSnapshot().selectionSet,
            baseline: comparison.baseline && { version: comparison.baseline.version, epoch: comparison.baseline.epoch, length: comparison.baseline.buffer.length },
            hunks: comparison.hunks.length, pending: this.reviewTickets.map(ticket => ({ kind: ticket.kind, revision: ticket.capture.working.revision, current: ticket.isCurrent() })),
            result: this.reviewResult, work: this.review!.snapshot(), input: this.review!.working.snapshot(),
            workingViewport: this.review!.working.viewport.snapshot(), referenceViewport: this.review!.referenceViewport()?.snapshot() } : null,
        views: [...this.mounted].map(([id, { editor, documentId }]) => ({ id, documentId, viewId: editor.view.id,
            selection: editor.view.getSnapshot().selection, selectionSet: editor.view.getSnapshot().selectionSet, focused: editor.element.ownerDocument.activeElement === editor.element, metrics: editor.metrics() })) }; }
}
