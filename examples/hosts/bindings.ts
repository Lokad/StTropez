import { mountEditingCandidate, mountTextComparison, mountTextEditor } from "../../src/browser/index.ts";
import type { EditingCandidate, MountedEditor, TextComparison, ViewportSnapshot, ViewState } from "../../src/browser/index.ts";
import type { ComparisonBaseline, ComparisonReversion, ComparisonTicket, DocumentId, DocumentView, Selection, TabId } from "../../src/index.ts";
import type { HostController } from "./controller.ts";
import { EditingPresentation } from "../editing/presentation.ts";
import { HostLanguageTools } from "./language.ts";
import { HostHoverTools } from "./hover.ts";
import { HostTablePaste } from "./table-paste.ts";
import { HostDomainTools } from "./domain.ts";
import { HostNavigationTools } from "./navigation.ts";

export type HostEditor = "native" | "candidate";
type BoundEditor = MountedEditor & Readonly<{ metrics: () => null | ReturnType<EditingCandidate["snapshot"]> & Readonly<{ viewport: ViewportSnapshot }> }>;
export function hostEditor(): HostEditor { return new URLSearchParams(location.search).get("editor") === "candidate" ? "candidate" : "native"; }

/** Stable refs own editor descendants; the controller and resource IDs survive every detach. */
export class ViewBindings {
    private readonly controller: HostController;
    private readonly stopInputCapture: () => void;
    private readonly mounted = new Map<string, { editor: BoundEditor; documentId: DocumentId; candidate: EditingCandidate | undefined }>();
    readonly editor: HostEditor;
    private readonly states = new Map<string, Map<DocumentId, ViewState>>();
    private readonly selections = new Map<string, Map<DocumentId, DocumentView>>();
    private mounts = 0;
    private destroys = 0;
    private review: TextComparison | undefined;
    readonly language: HostLanguageTools;
    readonly hover: HostHoverTools;
    readonly tablePaste: HostTablePaste;
    readonly domain: HostDomainTools;
    readonly navigation: HostNavigationTools;
    private detachReviewLanguage: (() => void) | undefined;
    private referenceState: Readonly<{ baseline: ComparisonBaseline; state: ViewState }> | undefined;
    private reviewStatus: HTMLOutputElement | undefined;
    private reviewListeners: AbortController | undefined;
    private readonly reviewTickets: ComparisonTicket[] = [];
    private readonly discardTickets: { ticket: ComparisonReversion; variantGeneration: number }[] = [];
    private referenceSerial = 0;
    private reviewResult = "No reference command";
    private unwatchReference: (() => void) | undefined;
    private referenceGeneration = -1;
    readonly primary: (host: HTMLDivElement | null) => void;
    readonly secondary: (host: HTMLDivElement | null) => void;
    readonly comparison = (host: HTMLDivElement | null): void => {
        this.unwatchReference?.(); this.unwatchReference = undefined;
        for (const ticket of this.reviewTickets.splice(0)) ticket.cancel();
        for (const { ticket } of this.discardTickets.splice(0)) ticket.cancel();
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
        const detachHover = this.hover.attach("comparison", this.controller.viewTab("primary"), this.review.working);
        const detachPaste = this.tablePaste.attach("comparison", this.controller.viewTab("primary"), this.review.working);
        const detachDomain = this.domain.attach("comparison", this.controller.viewTab("primary"), this.review.working, presentation);
        const detachNavigation = this.navigation.attach("comparison", this.controller.viewTab("primary"), this.review.working);
        this.detachReviewLanguage = () => { detachNavigation(); detachDomain(); detachPaste(); detachHover(); detachLanguage(); referencePresentation.clear(); };
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
    private composing(): boolean { return this.review?.working.snapshot().composing === true || [...this.mounted.values()].some(value => value.editor.metrics()?.composing); }
    readonly beginDiscard = (): void => {
        if (!this.review) return;
        for (const { ticket } of this.discardTickets.splice(0)) ticket.cancel();
        if (this.composing() || this.review.controller.getSnapshot().status !== "ready") {
            this.reviewResult = "Finish composition and wait for the review before discarding changes."; this.reviewStatus!.textContent = this.reviewResult; return;
        }
        if (this.review.working.input.disabled || this.review.working.input.readOnly) {
            this.reviewResult = "The working source is read-only. Changes were retained."; this.reviewStatus!.textContent = this.reviewResult; return;
        }
        try { const ticket = this.review.controller.beginReversion(); this.discardTickets.push({ ticket, variantGeneration: this.controller.variants.state.getSnapshot().generation });
            this.reviewResult = `Confirm discarding the captured changes against ${ticket.capture.baselineVersion}. Undo will restore them.`; this.reviewStatus!.textContent = this.reviewResult;
        } catch (error) { this.controller.reportError(error); }
    };
    readonly finishDiscard = (): void => {
        const captured = this.discardTickets.shift(); if (!captured) return; const { ticket } = captured;
        try { const applied = !this.composing() && this.controller.variants.state.getSnapshot().generation === captured.variantGeneration && ticket.complete(); this.reviewResult = applied ? "Discarded the reviewed changes as one undoable command." : "The captured review changed. Later text was retained.";
            if (this.reviewStatus) this.reviewStatus.textContent = this.reviewResult;
        } catch (error) { this.controller.reportError(error); } finally { ticket.finish(); }
    };
    readonly cancelDiscard = (): void => { for (const { ticket } of this.discardTickets.splice(0)) ticket.cancel();
        this.reviewResult = "Discard cancelled. Working text was retained."; if (this.reviewStatus) this.reviewStatus.textContent = this.reviewResult; };
    referenceRange(from: number, to: number): string | undefined { return this.review?.controller.getSnapshot().baseline?.buffer.slice(from, to); }
    selectSource(id: "primary" | "secondary", revision: number, selection: Selection): boolean {
        return this.mounted.get(id)?.editor.view.setSelection(revision, selection) ?? false;
    }
    selectSourceSet(id: "primary" | "secondary" | "comparison", revision: number, ranges: readonly Selection[], primary = 0): boolean {
        const view = id === "comparison" ? this.review?.working.view : this.mounted.get(id)?.editor.view;
        return view?.setSelections(revision, ranges, primary) ?? false;
    }
    constructor(controller: HostController, editor: HostEditor = "native") {
        this.controller = controller; this.editor = editor; this.language = new HostLanguageTools(controller.workspace); this.hover = new HostHoverTools(controller.workspace);
        this.tablePaste = new HostTablePaste(controller.workspace, editor === "candidate");
        this.domain = new HostDomainTools(controller.workspace, documentId => !this.tablePaste.hasPendingInput(documentId) && !(this.review?.working.view.documentId === documentId && (this.review.working.snapshot().pendingInput || this.review.working.snapshot().composing))
            && ![...this.mounted.values()].some(value => { const metrics = value.editor.metrics(); return value.documentId === documentId && (metrics?.pendingInput || metrics?.composing); }));
        this.navigation = new HostNavigationTools(controller.workspace, documentId => {
            const busy = (metrics: ReturnType<EditingCandidate["snapshot"]> | null) => metrics && (metrics.pendingInput || metrics.pendingCommand || metrics.composing);
            return !this.tablePaste.hasPendingInput(documentId) && !(this.review?.working.view.documentId === documentId && busy(this.review.working.snapshot())) && ![...this.mounted.values()].some(value => value.documentId === documentId && busy(value.editor.metrics()));
        }, documentId => this.presentNavigationDocument(documentId));
        this.stopInputCapture = controller.registerInputCaptureGuard(() => !this.tablePaste.hasPendingInput(controller.source.documentId) && !this.review?.working.snapshot().pendingInput
            && ![...this.mounted.values()].some(value => value.editor.metrics()?.pendingInput));
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
    private presentNavigationDocument(documentId: DocumentId): EditingCandidate | undefined {
        if (this.editor !== "candidate") return;
        const previous = this.mounted.get("secondary"), host = previous?.editor.element.closest<HTMLDivElement>(".editor-host"), metrics = previous?.editor.metrics();
        if (!previous || !host?.isConnected || metrics?.composing || metrics?.pendingInput || metrics?.pendingCommand) return;
        const workspace = this.controller.workspace, target = workspace.captureTab(this.controller.viewTab("secondary"));
        if (!workspace.resolveTab(target) || !workspace.observeDocument(documentId).getSnapshot()) return;
        // Explicit host lifecycle: replace this captured pane synchronously; React owns only its stable ref.
        this.detach("secondary"); workspace.replace(target.id, { kind: "text", documentId }); this.secondary(host);
        return this.mounted.get("secondary")?.candidate;
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
            const detachHover = candidate ? this.hover.attach(id, tabId, candidate) : undefined;
            const detachPaste = candidate ? this.tablePaste.attach(id, tabId, candidate) : undefined;
            const detachDomain = candidate ? this.domain.attach(id, tabId, candidate, presentation) : undefined;
            const detachNavigation = candidate ? this.navigation.attach(id, tabId, candidate) : undefined;
            const mounted: BoundEditor = candidate ? { element: candidate.input, view, captureView: candidate.captureView,
                restoreView: candidate.restoreView, destroy: candidate.destroy,
                metrics: () => ({ ...candidate.snapshot(), viewport: candidate.viewport.snapshot() }) }
                : { ...mountTextEditor(host, workspace, tabId, { ariaLabel, view }), metrics: () => null };
            const listeners = new AbortController();
            mounted.element.addEventListener("sttropez-conflict", event => this.controller.captureInputConflict(documentId, (event as CustomEvent<unknown>).detail), { signal: listeners.signal });
            this.bindSaveShortcut(mounted.element, tabId, () => candidate?.snapshot().composing ?? false, listeners.signal);
            const editor: BoundEditor = { ...mounted, destroy: () => { try { detachNavigation?.(); detachDomain?.(); detachPaste?.(); detachHover?.(); detachLanguage?.(); mounted.destroy(); } finally { listeners.abort(); } } };
            const state = this.states.get(id)?.get(documentId); if (state) editor.restoreView(this.restoreState(state, view));
            this.mounted.set(id, { editor, documentId, candidate }); this.mounts++;
        };
    }
    private detach(id: string): void {
        const mounted = this.mounted.get(id); if (!mounted) return;
        this.retainState(id, mounted.documentId, mounted.editor.captureView());
        mounted.editor.destroy(); this.mounted.delete(id); this.destroys++;
    }
    unmount(): void { for (const id of [...this.mounted.keys()]) this.detach(id); }
    dispose(): void {
        this.stopInputCapture();
        this.comparison(null); this.unmount(); this.navigation.dispose(); this.domain.dispose(); for (const selections of this.selections.values()) for (const view of selections.values()) view.dispose();
        this.selections.clear(); this.states.clear(); this.referenceState = undefined;
    }
    debug() {
        const comparison = this.review?.controller.getSnapshot();
        return { editor: this.editor, mounts: this.mounts, destroys: this.destroys, activeViews: this.mounted.size, language: this.language.debug(), hover: this.hover.debug(), tablePaste: this.tablePaste.debug(), domain: this.domain.debug(), navigation: this.navigation.debug(),
        comparison: comparison ? { status: comparison.status, generation: comparison.generation, workingRevision: comparison.working?.revision,
            referenceIsWorkingBuffer: comparison.baseline !== null && comparison.baseline.buffer === comparison.working?.buffer,
            progress: comparison.progress && { work: comparison.progress.work, readUnits: comparison.progress.readUnits,
                lineComparisons: comparison.progress.lineComparisons, lineEdits: comparison.progress.lineEdits },
            viewId: this.review!.working.view.id, foldGeneration: this.review!.working.view.folding.getSnapshot().generation, selection: this.review!.working.view.getSnapshot().selection, selectionSet: this.review!.working.view.getSnapshot().selectionSet,
            baseline: comparison.baseline && { version: comparison.baseline.version, epoch: comparison.baseline.epoch, length: comparison.baseline.buffer.length },
            hunks: comparison.hunks.length, pending: this.reviewTickets.map(ticket => ({ kind: ticket.kind, revision: ticket.capture.working.revision, current: ticket.isCurrent() })),
            result: this.reviewResult, work: this.review!.snapshot(), input: this.review!.working.snapshot(),
            discards: this.discardTickets.map(({ ticket, variantGeneration }) => ({ revision: ticket.capture.working.revision, current: ticket.isCurrent() && this.controller.variants.state.getSnapshot().generation === variantGeneration })),
            workingViewport: this.review!.working.viewport.snapshot(), referenceViewport: this.review!.referenceViewport()?.snapshot() } : null,
        views: [...this.mounted].map(([id, { editor, documentId }]) => ({ id, documentId, viewId: editor.view.id, foldGeneration: editor.view.folding.getSnapshot().generation,
            selection: editor.view.getSnapshot().selection, selectionSet: editor.view.getSnapshot().selectionSet, focused: editor.element.ownerDocument.activeElement === editor.element, metrics: editor.metrics() })) }; }
}
