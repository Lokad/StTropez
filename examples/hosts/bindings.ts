import { inputConflictEvent, mountTextEditor, mountTextComparison } from "../../src/browser/index.ts";
import type { TextEditor, TextComparison, ViewportSnapshot, ViewState } from "../../src/browser/index.ts";
import type { ComparisonBaseline, ComparisonReversion, ComparisonTicket, DocumentId, DocumentView, Selection, TabId, TabTarget, Workspace } from "../../src/index.ts";
import type { HostController } from "./controller.ts";
import { EditingPresentation } from "../shared/language/presentation.ts";
import { comparisonSettled, editorSettled } from "../shared/readiness.ts";
import { CleanupScope } from "../shared/cleanup-scope.ts";
import { linePrompt } from "../shared/line-prompt.ts";
import { HostLanguageTools } from "./language.ts";
import { hostLspFactories } from "../../fixtures/protocol/editor-provider.ts";
import type { LspWorkspace } from "../../src/protocol/index.ts";
import { HostHoverTools } from "./hover.ts";
import { HostTablePaste } from "./table-paste.ts";
import { HostDomainTools } from "./domain.ts";
import { HostNavigationTools } from "./navigation.ts";
import { HostProjectTools } from "./project.ts";
import { HostDocumentColors } from "./document-colors.ts";
import { HostDocumentLinks } from "./document-links.ts";
import { HostActionsTools } from "./code-actions.ts";
import { HostRenameTools } from "./rename.ts";
import { HostSignatureTools } from "./signature.ts";
import { mountInstructionWidget } from "./instruction-widget.ts";
import type { InstructionViewState } from "./instruction-widget.ts";

export type HostEditor = "native" | "candidate";
export type NativeEditorMount = (host: HTMLElement, workspace: Workspace, tabId: TabId,
    options: Readonly<{ ariaLabel?: string; view?: DocumentView }>) => Readonly<{ element: HTMLTextAreaElement; view: DocumentView;
        captureView: () => ViewState; restoreView: (state: ViewState) => void; dispose: () => void }>;
type BoundEditor = ReturnType<NativeEditorMount> & Readonly<{ metrics: () => null | ReturnType<TextEditor["snapshot"]> & Readonly<{ viewport: ViewportSnapshot }> }>;
type ViewTool = Readonly<{ attach(id: string, tab: TabId, editor: TextEditor, presentation: EditingPresentation): () => void }>;
export function hostEditor(): HostEditor { return new URLSearchParams(location.search).get("editor") === "candidate" ? "candidate" : "native"; }

/** Stable refs own editor descendants; the controller and resource IDs survive every detach. */
export class ViewBindings {
    private readonly controller: HostController;
    private readonly mountNative: NativeEditorMount | undefined;
    private instructionMount: ReturnType<typeof mountInstructionWidget> | undefined;
    private readonly instructionMemory: InstructionViewState = { generation: 0, fields: {}, focus: undefined };
    private readonly stopInputCapture: () => void;
    private readonly stopDocumentCleanup: () => void;
    private readonly mounted = new Map<string, { editor: BoundEditor; documentId: DocumentId; candidate: TextEditor | undefined }>();
    readonly editor: HostEditor;
    private readonly lspOwner: LspWorkspace | undefined;
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
    readonly project: HostProjectTools;
    readonly signature: HostSignatureTools;
    readonly rename: HostRenameTools;
    readonly actions: HostActionsTools;
    readonly links: HostDocumentLinks;
    readonly colors: HostDocumentColors;
    private readonly tools: readonly ViewTool[];
    private reviewScope: CleanupScope | undefined;
    private referenceState: Readonly<{ baseline: ComparisonBaseline; state: ViewState }> | undefined;
    private reviewStatus: HTMLOutputElement | undefined;
    private readonly reviewTickets: ComparisonTicket[] = [];
    private readonly discardTickets: { ticket: ComparisonReversion; variantGeneration: number }[] = [];
    private referenceSerial = 0;
    private reviewResult = "No reference command";
    private referenceGeneration = -1;
    private reviewScrollLinked = false;
    private reviewRowsAligned = false;
    readonly primary: (host: HTMLDivElement | null) => void;
    readonly secondary: (host: HTMLDivElement | null) => void;
    readonly comparison = (host: HTMLDivElement | null): void => {
        for (const ticket of this.reviewTickets.splice(0)) ticket.cancel();
        for (const { ticket } of this.discardTickets.splice(0)) ticket.cancel();
        if (this.review) {
            const review = this.review.getSnapshot();
            this.reviewScrollLinked = review.scrollLinked;
            this.reviewRowsAligned = review.alignment.enabled;
            const baseline = this.review.controller.getSnapshot().baseline, reference = this.review.panes.reference;
            if (baseline) this.referenceState = { baseline, state: reference.captureView() };
            if (this.review.controller.getSnapshot().working) this.retainState("comparison", this.review.panes.working.view.documentId, this.review.panes.working.captureView());
        }
        const previous = this.reviewScope; this.reviewScope = undefined; previous?.dispose();
        if (!host) return;
        const scope = new CleanupScope();
        try {
            // Destruction can emit recovery for unfinished input. Keep these listeners
            // alive until the editor has released that input, including during rollback.
            const listeners = new AbortController(); scope.defer(() => listeners.abort());
            const status = host.ownerDocument.createElement("output"); status.setAttribute("aria-label", "Reference operation status");
            status.textContent = this.reviewResult; host.append(status); this.reviewStatus = status;
            scope.defer(() => { if (this.reviewStatus === status) this.reviewStatus = undefined; status.remove(); });
            const publication = this.controller.comparisonReference.getSnapshot(), baseline = publication.baseline;
            this.referenceGeneration = publication.generation;
            const view = this.retainedView("comparison", this.controller.source.documentId);
            const presentation = new EditingPresentation(), referencePresentation = new EditingPresentation();
            const review = mountTextComparison(host, this.controller.workspace, this.controller.viewTab("primary"),
                baseline, { ariaLabel: "Source review", view, requestLine: linePrompt(host.ownerDocument), scrollLinked: this.reviewScrollLinked, rowsAligned: this.reviewRowsAligned });
            this.review = review;
            scope.defer(() => { if (this.review === review) this.review = undefined; review.dispose(); });
            const saveTarget = this.controller.workspace.captureTab(this.controller.viewTab("primary"));
            this.attachTools(scope, "comparison", this.controller.viewTab("primary"), review.panes.working, presentation);
            scope.defer(() => referencePresentation.clear());
            const reference = review.panes.reference;
            reference.decorations.addProvider({ name: "syntax", order: 0, provide: referencePresentation.decorate });
            scope.defer(this.language.attachReferenceFind("reference", reference, referencePresentation, () => review.controller.getSnapshot().baseline, saveTarget));
            const state = this.states.get("comparison")?.get(view.documentId);
            if (state) review.panes.working.restoreView(this.restoreState(state, view));
            if (this.referenceState?.baseline.buffer === baseline.buffer && this.referenceState.baseline.version === baseline.version) {
                // The new private document holds the same immutable bytes. Translate only anchors
                // captured at the saved revision, including an anchor inside aligned-row padding.
                const { folding: saved, verticalAnchor, horizontalAnchor, ...state } = this.referenceState.state;
                const revision = reference.view.getSnapshot().revision;
                reference.restoreView({ ...state,
                    ...(saved && { folding: { ...saved, documentId: reference.view.documentId, revision } }),
                    ...(verticalAnchor && verticalAnchor.revision === saved?.revision && { verticalAnchor: { ...verticalAnchor, revision } }),
                    ...(horizontalAnchor && horizontalAnchor.revision === saved?.revision && { horizontalAnchor: { ...horizontalAnchor, revision } }) });
            } else this.referenceState = undefined;
            const documentId = review.panes.working.view.documentId;
            review.panes.working.input.addEventListener(inputConflictEvent, event => this.controller.captureInputConflict(documentId, (event as CustomEvent<unknown>).detail), { signal: listeners.signal });
            const working = review.panes.working;
            this.bindSaveShortcut(working.input, this.controller.viewTab("primary"), () => working.activity().composing, listeners.signal);
            reference.input.addEventListener("keydown", event => this.handleSaveShortcut(event, reference.input, saveTarget, () => reference.activity().composing), { signal: listeners.signal });
            scope.defer(this.controller.comparisonReference.subscribe(() => this.updateReference()));
            this.reviewScope = scope;
        } catch (error) { scope.rollback(error); }
    };
    private bindSaveShortcut(input: HTMLTextAreaElement, tabId: TabId, composing: () => boolean, signal: AbortSignal): void {
        const target = this.controller.workspace.captureTab(tabId);
        input.addEventListener("keydown", event => this.handleSaveShortcut(event, input, target, composing), { signal });
    }
    private handleSaveShortcut(event: KeyboardEvent, input: HTMLElement, target: TabTarget, composing: () => boolean): void {
        if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "s"
            || event.defaultPrevented || event.isComposing || !input.isConnected
            || (input.closest("button,input,select,textarea") ?? input).matches(":disabled") || composing()) return;
        const tab = this.controller.workspace.resolveTab(target);
        if (tab?.surface.kind !== "text" || tab.surface.documentId !== this.controller.source.documentId) return;
        event.preventDefault();
        if (!event.repeat) this.controller.save();
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
    private composing(): boolean { return this.review?.panes.working.activity().composing === true || [...this.mounted.values()].some(value => value.candidate?.activity().composing); }
    readonly beginDiscard = (): void => {
        if (!this.review) return;
        for (const { ticket } of this.discardTickets.splice(0)) ticket.cancel();
        if (this.composing() || this.review.controller.getSnapshot().status !== "ready") {
            this.reviewResult = "Finish composition and wait for the review before discarding changes."; this.reviewStatus!.textContent = this.reviewResult; return;
        }
        if (this.review.panes.working.input.disabled || this.review.panes.working.input.readOnly) {
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
    onSourceRender(id: "primary" | "secondary" | "comparison", listener: () => void): () => void {
        const editor = id === "comparison" ? this.review?.panes.working : this.mounted.get(id)?.candidate;
        if (!editor) throw new Error("Source viewport is not mounted.");
        return editor.viewport.onRender(listener);
    }
    selectSource(id: "primary" | "secondary", revision: number, selection: Selection): boolean {
        return this.mounted.get(id)?.editor.view.setSelection(revision, selection) ?? false;
    }
    selectSourceSet(id: "primary" | "secondary" | "comparison", revision: number, ranges: readonly Selection[], primary = 0): boolean {
        const view = id === "comparison" ? this.review?.panes.working.view : this.mounted.get(id)?.editor.view;
        return view?.setSelections(revision, ranges, primary) ?? false;
    }
    configureSource(id: "primary" | "secondary" | "comparison", configuration: import("../../src/index.ts").LanguageConfiguration): boolean {
        const editor = id === "comparison" ? this.review?.panes.working : this.mounted.get(id)?.candidate;
        return editor?.configure({ language: configuration }) ?? false;
    }
    constructor(controller: HostController, editor: HostEditor = "candidate", mountNative?: NativeEditorMount) {
        if (editor === "native" && !mountNative) throw new Error("The native source control requires a fixture mount.");
        this.controller = controller; this.editor = editor; this.mountNative = mountNative;
        this.tablePaste = new HostTablePaste(controller.workspace, editor === "candidate");
        this.domain = new HostDomainTools(controller.workspace, documentId => !this.tablePaste.hasPendingInput(documentId) && !(this.review?.panes.working.view.documentId === documentId && (this.review.panes.working.activity().pendingInput || this.review.panes.working.activity().composing))
            && ![...this.mounted.values()].some(value => { const activity = value.candidate?.activity(); return value.documentId === documentId && (activity?.pendingInput || activity?.composing); }));
        const canCapture = (documentId: DocumentId) => {
            const busy = (activity: ReturnType<TextEditor["activity"]> | undefined) => activity && (activity.pendingInput || activity.pendingCommand || activity.composing);
            return !this.tablePaste.hasPendingInput(documentId) && !(this.review?.panes.working.view.documentId === documentId && busy(this.review.panes.working.activity())) && ![...this.mounted.values()].some(value => value.documentId === documentId && busy(value.candidate?.activity()));
        };
        const lsp = hostLspFactories(controller.workspace);
        this.lspOwner = lsp.owner;
        const reconnectProvider = () => { void lsp.owner.reconnect().catch(controller.reportError); };
        this.language = new HostLanguageTools(controller.workspace, (event, field, target, composing) => this.handleSaveShortcut(event, field, target, composing), { canCapture, providerFactory: lsp.provider });
        this.hover = new HostHoverTools(controller.workspace, kind => { if (kind === "pointer") return !this.signature?.state.getSnapshot().visible; this.signature?.dismiss(); return true; }, { createController: lsp.hover, canCapture });
        this.navigation = new HostNavigationTools(controller.workspace, canCapture, documentId => this.presentNavigationDocument(documentId), lsp.navigation, reconnectProvider);
        this.project = new HostProjectTools(controller.workspace, canCapture, documentId => this.presentNavigationDocument(documentId), lsp.project, lsp.owner, undefined, reconnectProvider);
        this.colors = new HostDocumentColors(controller.workspace, canCapture, documentId => this.presentNavigationDocument(documentId), lsp.colors, reconnectProvider);
        this.links = new HostDocumentLinks(controller.workspace, canCapture, documentId => this.presentNavigationDocument(documentId), lsp.links, reconnectProvider);
        this.actions = new HostActionsTools(controller.workspace, canCapture, documentId => this.presentNavigationDocument(documentId), lsp.actions, this.project, lsp.owner, reconnectProvider);
        this.rename = new HostRenameTools(controller.workspace, canCapture, documentId => this.presentNavigationDocument(documentId), lsp.rename, reconnectProvider);
        this.signature = new HostSignatureTools(controller.workspace, canCapture, () => this.hover.dismiss(), lsp.signature,
            () => { const provider = this.language.state.getSnapshot().provider; return !!provider && (provider.pending || provider.offerText !== null); }, reconnectProvider);
        this.tools = [this.language, this.hover, this.tablePaste, this.domain, this.navigation, this.project,
            this.signature, this.rename, this.actions, this.links, this.colors];
        this.stopInputCapture = controller.registerInputCaptureGuard(() => !this.instructionMount?.hasPendingInput() && !this.tablePaste.hasPendingInput(controller.source.documentId) && !this.review?.panes.working.activity().pendingInput
            && ![...this.mounted.values()].some(value => value.candidate?.activity().pendingInput),
            documentId => this.selections.get("primary")?.get(documentId) ?? this.selections.get("comparison")?.get(documentId) ?? this.selections.get("secondary")?.get(documentId));
        this.stopDocumentCleanup = controller.registerDetachedDocumentCleanup(documentId => {
            if ([...this.mounted.values()].some(value => value.documentId === documentId) || this.review?.panes.working.view.documentId === documentId) return;
            for (const selections of this.selections.values()) { selections.get(documentId)?.dispose(); selections.delete(documentId); }
            for (const states of this.states.values()) states.delete(documentId);
        });
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
    private presentNavigationDocument(documentId: DocumentId): TextEditor | undefined {
        if (this.editor !== "candidate") return;
        const previous = this.mounted.get("secondary"), host = previous?.editor.element.closest<HTMLDivElement>(".editor-host"), activity = previous?.candidate?.activity();
        if (!previous || !host?.isConnected || activity?.composing || activity?.pendingInput || activity?.pendingCommand) return;
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
            const scope = new CleanupScope();
            try {
                const listeners = new AbortController(); scope.defer(() => listeners.abort());
                const presentation = new EditingPresentation();
                const surface = id === "primary" && this.editor === "candidate" ? host.ownerDocument.createElement("div") : host;
                if (surface !== host) { surface.className = "host-instruction-source"; host.append(surface); scope.defer(() => surface.remove()); }
                const candidate = this.editor === "candidate" ? mountTextEditor(surface, workspace, tabId, { ariaLabel, view, requestLine: linePrompt(surface.ownerDocument) }) : undefined;
                const mounted: BoundEditor = candidate ? { element: candidate.input, view, captureView: candidate.captureView,
                    restoreView: candidate.restoreView, dispose: candidate.dispose,
                    metrics: () => ({ ...candidate.snapshot(), viewport: candidate.viewport.snapshot() }) }
                    : { ...this.mountNative!(host, workspace, tabId, { ariaLabel, view }), metrics: () => null };
                scope.defer(mounted.dispose);
                const lane = surface !== host ? host.ownerDocument.createElement("div") : undefined;
                if (lane) { lane.className = "host-instruction-lane"; lane.hidden = true; host.append(lane); scope.defer(() => lane.remove()); }
                const instruction = lane && candidate ? mountInstructionWidget(host, lane, candidate, this.controller, tabId, this.instructionMemory) : undefined;
                if (instruction) {
                    this.instructionMount = instruction;
                    scope.defer(() => { if (this.instructionMount === instruction) this.instructionMount = undefined; instruction.dispose(); });
                }
                if (candidate) this.attachTools(scope, id, tabId, candidate, presentation);
                mounted.element.addEventListener(inputConflictEvent, event => this.controller.captureInputConflict(documentId, (event as CustomEvent<unknown>).detail), { signal: listeners.signal });
                this.bindSaveShortcut(mounted.element, tabId, () => candidate?.activity().composing ?? false, listeners.signal);
                const editor: BoundEditor = { ...mounted, dispose: scope.dispose };
                const state = this.states.get(id)?.get(documentId); if (state) editor.restoreView(this.restoreState(state, view));
                this.mounted.set(id, { editor, documentId, candidate }); this.mounts++;
            } catch (error) { scope.rollback(error); }
        };
    }
    private attachTools(scope: CleanupScope, id: string, tab: TabId, editor: TextEditor, presentation: EditingPresentation): void {
        editor.decorations.addProvider({ name: "syntax", order: 0, provide: presentation.decorate });
        for (const tool of this.tools) scope.defer(tool.attach(id, tab, editor, presentation));
    }
    private detach(id: string): void {
        const mounted = this.mounted.get(id); if (!mounted) return;
        this.retainState(id, mounted.documentId, mounted.editor.captureView());
        try { mounted.editor.dispose(); }
        finally { this.mounted.delete(id); this.destroys++; this.controller.collectLoadedDocument(); }
    }
    readonly anchorInstruction = (): void => {
        const current = this.mounted.get("primary"); if (!current?.candidate || current.documentId !== this.controller.source.documentId || !this.controller.canCaptureRecovery()) return;
        this.controller.instruction.anchor(current.editor.view.getSnapshot().selection.head);
    };
    readonly insertInstruction = (): void => {
        const current = this.mounted.get("primary"); if (!current?.candidate || current.documentId !== this.controller.source.documentId || !this.controller.canCaptureRecovery()) return;
        const d = this.controller.workspace.document(current.documentId), at = d.buffer.offsetAt(d.buffer.lineAt(current.editor.view.getSnapshot().selection.head));
        const firstEnd = d.buffer.lineCount > 1 ? d.buffer.offsetAt(1) : 0, tail = d.buffer.slice(Math.max(0, firstEnd - 2), firstEnd), eol = tail.endsWith("\r\n") ? "\r\n" : tail.endsWith("\r") ? "\r" : "\n";
        const result = this.controller.workspace.edit({ documentId: d.id, expectedRevision: d.revision, origin: "human", edits: [{ from: at, to: at,
            insert: '// @transfer {"destination":"target.csv","batchSize":"1000"}' + eol }], history: { kind: "form" }, view: current.editor.view });
        if (result.applied) { this.controller.instruction.anchor(at); current.candidate.viewport.revealOffset(at); }
    };
    unmount(): void { for (const id of [...this.mounted.keys()]) this.detach(id); }
    dispose(): void {
        this.stopInputCapture(); this.stopDocumentCleanup();
        this.comparison(null); this.unmount(); this.colors.dispose(); this.links.dispose(); this.actions.dispose(); this.rename.dispose(); this.signature.dispose(); this.project.dispose(); this.navigation.dispose(); this.domain.dispose(); for (const selections of this.selections.values()) for (const view of selections.values()) view.dispose();
        this.selections.clear(); this.states.clear(); this.referenceState = undefined; this.language.clearRetainedView();
        this.lspOwner?.dispose();
        this.controller.collectLoadedDocument();
    }
    settled(): boolean {
        for (const { candidate } of this.mounted.values()) if (candidate && !editorSettled(candidate)) return false;
        return !this.review || comparisonSettled(this.review);
    }
    debug() {
        const comparison = this.review?.controller.getSnapshot();
        return { lsp: this.lspOwner?.snapshot() ?? null, instruction: this.instructionMount?.debug() ?? null, editor: this.editor, mounts: this.mounts, destroys: this.destroys, activeViews: this.mounted.size, language: this.language.debug(), hover: this.hover.debug(), tablePaste: this.tablePaste.debug(), domain: this.domain.debug(), navigation: this.navigation.debug(), project: this.project.debug(), rename: this.rename.debug(), actions: this.actions.debug(), links: this.links.debug(), colors: this.colors.debug(), signature: this.signature.debug(),
        comparison: comparison ? { status: comparison.status, generation: comparison.generation, workingRevision: comparison.working?.revision,
            referenceIsWorkingBuffer: comparison.baseline !== null && comparison.baseline.buffer === comparison.working?.buffer,
            progress: comparison.progress && { work: comparison.progress.work, readUnits: comparison.progress.readUnits,
                lineEdits: comparison.progress.lineEdits },
            viewId: this.review!.panes.working.view.id, foldGeneration: this.review!.panes.working.view.folding.getSnapshot().generation, selection: this.review!.panes.working.view.getSnapshot().selection, selectionSet: this.review!.panes.working.view.getSnapshot().selectionSet,
            baseline: comparison.baseline && { version: comparison.baseline.version, epoch: comparison.baseline.epoch, length: comparison.baseline.buffer.length, exports: comparison.baseline.buffer.readMetrics().textExports },
            hunks: comparison.hunks.length, pending: this.reviewTickets.map(ticket => ({ kind: ticket.kind, revision: ticket.capture.working.revision, current: ticket.isCurrent() })),
            result: this.reviewResult, work: this.review!.getDiagnostics(), input: this.review!.panes.working.snapshot(), referenceInput: this.review!.panes.reference.snapshot(),
            discards: this.discardTickets.map(({ ticket, variantGeneration }) => ({ revision: ticket.capture.working.revision, current: ticket.isCurrent() && this.controller.variants.state.getSnapshot().generation === variantGeneration })),
            workingViewport: this.review!.panes.working.viewport.snapshot(), referenceViewport: this.review!.panes.reference.viewport.snapshot() } : null,
        views: [...this.mounted].map(([id, { editor, documentId }]) => ({ id, documentId, viewId: editor.view.id, foldGeneration: editor.view.folding.getSnapshot().generation,
            selection: editor.view.getSnapshot().selection, selectionSet: editor.view.getSnapshot().selectionSet, focused: editor.element.ownerDocument.activeElement === editor.element, metrics: editor.metrics() })) }; }
}
