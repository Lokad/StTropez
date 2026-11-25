import { registerCommandPalette } from "./command-palette.ts";
import { focusSource, onSourceFocus } from "../../../examples/shared/source-focus.ts";
import { editRefusedEvent, inputConflictEvent, mountTextEditor, mountTextComparison } from "../../../src/browser/index.ts";
import type { EditRefusedDetail, TextEditor, TextComparison, ViewState } from "../../../src/browser/index.ts";
import type { ComparisonBaseline, ComparisonReversion, ComparisonTicket, DocumentId, DocumentView, Selection, TabId, TabTarget } from "../../../src/index.ts";
import type { HostController } from "./controller.ts";
import { EditingPresentation } from "../language/presentation.ts";
import { comparisonSettled, editorSettled } from "../readiness.ts";
import { CleanupScope } from "../../../examples/shared/cleanup-scope.ts";
import { linePrompt } from "../../../examples/shared/line-prompt.ts";
import { HostLanguageTools } from "./language.ts";
import { createNavigationHost } from "../../../examples/shared/language-host.ts";
import { hostLspFactories } from "../protocol/editor-provider.ts";
import type { NavigationFault } from "../language/navigation.ts";
import { fixtureRequests } from "../language/fixture-requests.ts";
import type { LspWorkspace } from "../../../src/protocol/index.ts";
import { HostHoverTools } from "../../../examples/shared/hover.ts";
import { HostTablePaste } from "../../../examples/shared/table-paste.ts";
import { HostDomainTools } from "./domain.ts";
import { HostNavigationTools } from "./navigation.ts";
import { HostProjectTools } from "./project.ts";
import { HostDocumentColors } from "./document-colors.ts";
import { HostDocumentLinks } from "./document-links.ts";
import { HostActionsTools } from "./code-actions.ts";
import { HostRenameTools } from "../../../examples/shared/rename.ts";
import { HostSignatureTools } from "./signature.ts";
import { mountInstructionWidget } from "./instruction-widget.ts";
import type { InstructionViewState } from "./instruction-widget.ts";

type ViewTool = Readonly<{ attach(id: string, tab: TabId, editor: TextEditor, presentation: EditingPresentation): () => void }>;

/** Stable refs own editor descendants; the controller and resource IDs survive every detach. */
export class ViewBindings {
    private readonly controller: HostController;
    private commandSource: TextEditor | undefined;
    private instructionMount: ReturnType<typeof mountInstructionWidget> | undefined;
    private readonly instructionMemory: InstructionViewState = { generation: 0, fields: {}, focus: undefined };
    private readonly stopInputCapture: () => void;
    private readonly stopDocumentCleanup: () => void;
    private readonly mounted = new Map<string, { editor: TextEditor; documentId: DocumentId; dispose: () => void }>();
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
    private readonly locationHistory: ReturnType<typeof createNavigationHost>["history"];
    readonly locationStatus: ReturnType<typeof createNavigationHost>["locationStatus"];
    readonly switchLocations: () => void;
    readonly project: HostProjectTools;
    readonly signature: HostSignatureTools;
    readonly rename: HostRenameTools;
    readonly renameRequests = fixtureRequests<NavigationFault>("rename");
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
            host.addEventListener(editRefusedEvent, event => {
                const { reason } = (event as CustomEvent<EditRefusedDetail>).detail;
                status.textContent = reason === "edit-locked" ? "The source is locked for editing."
                    : event.target === review.panes.reference.element ? "The comparison reference is read-only." : "This source is read-only.";
            }, { signal: listeners.signal });
            const saveTarget = this.controller.workspace.tabs.capture(this.controller.viewTab("primary"));
            this.attachTools(scope, "comparison", this.controller.viewTab("primary"), review.panes.working, presentation);
            scope.defer(() => referencePresentation.clear());
            const reference = review.panes.reference;
            reference.decorations.addProvider({ order: 0, provide: referencePresentation.decorate });
            scope.defer(this.language.attachReferenceFind("reference", reference, referencePresentation, () => review.controller.getSnapshot().baseline, saveTarget));
            const state = this.states.get("comparison")?.get(view.documentId);
            if (state) review.panes.working.restoreView(state, { selection: "current" });
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
            review.panes.working.element.addEventListener(inputConflictEvent, event => this.controller.captureInputConflict(documentId, (event as CustomEvent<unknown>).detail), { signal: listeners.signal });
            this.registerPaneCommands(review.panes.working, saveTarget, scope);
            this.registerPaneCommands(reference, saveTarget, scope);
            scope.defer(this.controller.comparisonReference.subscribe(() => this.updateReference()));
            this.reviewScope = scope;
        } catch (error) { scope.rollback(error); }
    };
    private ownsSaveTarget(target: TabTarget): boolean {
        const tab = this.controller.workspace.tabs.resolve(target);
        return tab?.surface.kind === "text" && tab.surface.documentId === this.controller.source.documentId;
    }
    readonly openCommands = (): void => { (this.commandSource ?? this.mounted.get("primary")?.editor)?.commands.run("host.commands"); };
    private registerPaneCommands(editor: TextEditor, target: TabTarget, scope: CleanupScope): void {
        const events = new AbortController();
        onSourceFocus(editor, events.signal, () => { this.commandSource = editor; });
        scope.defer(() => { events.abort(); if (this.commandSource === editor) this.commandSource = undefined; });
        scope.defer(registerCommandPalette(editor));
        scope.defer(editor.commands.register({ id: "source.save", label: "Save source",
            enabled: () => this.ownsSaveTarget(target), run: () => this.controller.save() },
            { keys: ["Mod+s"], shared: true, repeat: false }).dispose);
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
    private composing(): boolean { return this.review?.panes.working.activity().composing === true || [...this.mounted.values()].some(value => value.editor.activity().composing); }
    readonly beginDiscard = (): void => {
        if (!this.review) return;
        for (const { ticket } of this.discardTickets.splice(0)) ticket.cancel();
        if (this.composing() || this.review.controller.getSnapshot().status !== "ready") {
            this.reviewResult = "Finish composition and wait for the review before discarding changes."; this.reviewStatus!.textContent = this.reviewResult; return;
        }
        const { disabled, readOnlyReason } = this.review.panes.working.getSnapshot();
        if (disabled || readOnlyReason) {
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
        const editor = id === "comparison" ? this.review?.panes.working : this.mounted.get(id)?.editor;
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
    configureSource(id: "primary" | "secondary" | "comparison", configuration: import("../../../src/index.ts").LanguageConfiguration): boolean {
        const editor = id === "comparison" ? this.review?.panes.working : this.mounted.get(id)?.editor;
        return editor?.configure({ language: configuration }) ?? false;
    }
    constructor(controller: HostController) {
        this.controller = controller;
        this.tablePaste = new HostTablePaste();
        this.domain = new HostDomainTools(controller.workspace, documentId => !this.tablePaste.hasPendingInput(documentId) && !(this.review?.panes.working.view.documentId === documentId && (this.review.panes.working.activity().pendingInput || this.review.panes.working.activity().composing))
            && ![...this.mounted.values()].some(value => { const activity = value.editor.activity(); return value.documentId === documentId && (activity.pendingInput || activity.composing); }));
        const canCapture = (documentId: DocumentId) => {
            const busy = (activity: ReturnType<TextEditor["activity"]> | undefined) => activity && (activity.pendingInput || activity.pendingCommand || activity.composing);
            return !this.tablePaste.hasPendingInput(documentId) && !(this.review?.panes.working.view.documentId === documentId && busy(this.review.panes.working.activity())) && ![...this.mounted.values()].some(value => value.documentId === documentId && busy(value.editor.activity()));
        };
        const lsp = hostLspFactories(controller.workspace, this.renameRequests.take);
        this.lspOwner = lsp.owner;
        const reconnectProvider = () => { void lsp.owner.reconnect().catch(controller.reportError); };
        this.language = new HostLanguageTools(controller.workspace, { canCapture, providerFactory: lsp.provider });
        this.hover = new HostHoverTools(kind => { if (kind === "pointer") return !this.signature?.state.getSnapshot().visible; this.signature?.dismiss(); return true; }, { ...lsp.hover, canCapture });
        const present = (document: DocumentId) => this.presentNavigationDocument(document);
        const languageHost = createNavigationHost({ workspace: controller.workspace, canCapture, present, reconnect: reconnectProvider });
        this.locationHistory = languageHost.history;
        this.locationStatus = languageHost.locationStatus;
        this.switchLocations = languageHost.switchLocations;
        this.links = new HostDocumentLinks(languageHost, lsp.links);
        this.navigation = new HostNavigationTools(languageHost, { ...lsp.navigation, linkAt: (editor, offset) => this.links.linkAt(editor, offset) });
        this.project = new HostProjectTools(languageHost, lsp.project, lsp.owner);
        this.colors = new HostDocumentColors(languageHost, lsp.colors);
        this.actions = new HostActionsTools(languageHost, lsp.actions, this.project);
        this.rename = new HostRenameTools(languageHost, lsp.rename);
        this.signature = new HostSignatureTools(canCapture, this.hover, lsp.signature, reconnectProvider);
        this.tools = [this.language, this.signature, this.tablePaste, this.domain, this.navigation, this.project,
            this.rename, this.actions, this.links, this.colors];
        this.stopInputCapture = controller.registerInputCaptureGuard(() => !this.instructionMount?.hasPendingInput() && !this.tablePaste.hasPendingInput(controller.source.documentId) && !this.review?.panes.working.activity().pendingInput
            && ![...this.mounted.values()].some(value => value.editor.activity().pendingInput),
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
    private presentNavigationDocument(documentId: DocumentId): TextEditor | undefined {
        const editor = this.mounted.get("secondary")?.editor;
        if (!editor?.tab) return;
        const host = editor.element.closest<HTMLDivElement>(".editor-host"), activity = editor.activity();
        if (!host?.isConnected || activity.disposed || activity.composing || activity.pendingInput || activity.pendingCommand
            || this.tablePaste.hasPendingInput(editor.view.documentId)) return;
        const { workspace, tab } = editor;
        if (!workspace.ownsDocumentView(editor.view, tab) || !workspace.observeDocument(documentId).getSnapshot()) return;
        if (editor.view.documentId === documentId) return editor;
        // Explicit host lifecycle: replace this captured pane synchronously; React owns only its stable ref.
        this.detach("secondary"); workspace.tabs.replace(tab.id, { kind: "text", documentId }); this.secondary(host);
        return this.mounted.get("secondary")?.editor;
    }
    private ref(id: "primary" | "secondary", ariaLabel: string): (host: HTMLDivElement | null) => void {
        return host => {
            this.detach(id);
            if (host === null) return;
            const workspace = this.controller.workspace, tabId = this.controller.viewTab(id);
            const tab = workspace.tabs.resolve(workspace.tabs.capture(tabId));
            if (tab?.surface.kind !== "text") throw new Error("Text view requires a text tab.");
            const documentId = tab.surface.documentId;
            const view = this.retainedView(id, documentId);
            const scope = new CleanupScope();
            try {
                const listeners = new AbortController(); scope.defer(() => listeners.abort());
                const presentation = new EditingPresentation();
                const surface = id === "primary" ? host.ownerDocument.createElement("div") : host;
                if (surface !== host) { surface.className = "host-instruction-source"; host.append(surface); scope.defer(() => surface.remove()); }
                const editor = mountTextEditor(surface, workspace, tabId, { ariaLabel, view, requestLine: linePrompt(surface.ownerDocument) });
                scope.defer(editor.dispose);
                const lane = surface !== host ? host.ownerDocument.createElement("div") : undefined;
                if (lane) { lane.className = "host-instruction-lane"; lane.hidden = true; host.append(lane); scope.defer(() => lane.remove()); }
                const instruction = lane ? mountInstructionWidget(host, lane, editor, this.controller, tabId, this.instructionMemory) : undefined;
                if (instruction) {
                    this.instructionMount = instruction;
                    scope.defer(() => { if (this.instructionMount === instruction) this.instructionMount = undefined; instruction.dispose(); });
                }
                this.attachTools(scope, id, tabId, editor, presentation);
                const original = this.controller.source.documentId;
                if (id === "secondary" && documentId !== original) {
                    const bar = host.ownerDocument.createElement("div"), title = host.ownerDocument.createElement("strong");
                    const back = host.ownerDocument.createElement("button"), note = host.ownerDocument.createElement("span");
                    bar.className = "host-file-heading"; title.textContent = workspace.document(documentId).title;
                    back.type = "button"; back.textContent = "Show original source";
                    bar.append(title, back, note); host.prepend(bar); scope.defer(() => bar.remove());
                    back.addEventListener("click", () => {
                        if (this.mounted.get(id)?.editor !== editor) return;
                        const restored = this.presentNavigationDocument(original);
                        if (restored) focusSource(restored);
                        else note.textContent = "Finish the current edit to switch files.";
                    }, { signal: listeners.signal });
                }
                const feedback = host.ownerDocument.createElement("output");
                feedback.className = "host-edit-feedback"; feedback.setAttribute("aria-label", ariaLabel + " edit feedback");
                host.append(feedback); scope.defer(() => feedback.remove());
                editor.element.addEventListener(editRefusedEvent, event => {
                    const { reason } = (event as CustomEvent<EditRefusedDetail>).detail;
                    feedback.textContent = reason === "edit-locked" ? "This source is locked for editing." : "This source is read-only.";
                }, { signal: listeners.signal });
                editor.element.addEventListener("focusout", () => { feedback.textContent = ""; }, { signal: listeners.signal });
                editor.element.addEventListener(inputConflictEvent, event => this.controller.captureInputConflict(documentId, (event as CustomEvent<unknown>).detail), { signal: listeners.signal });
                const saveTarget = workspace.tabs.capture(tabId);
                this.registerPaneCommands(editor, saveTarget, scope);
                const state = this.states.get(id)?.get(documentId); if (state) editor.restoreView(state, { selection: "current" });
                this.mounted.set(id, { editor, documentId, dispose: scope.dispose }); this.mounts++;
            } catch (error) { scope.rollback(error); }
        };
    }
    private attachTools(scope: CleanupScope, id: string, tab: TabId, editor: TextEditor, presentation: EditingPresentation): void {
        editor.decorations.addProvider({ order: 0, provide: presentation.decorate });
        for (const tool of this.tools) scope.defer(tool.attach(id, tab, editor, presentation));
    }
    private detach(id: string): void {
        const mounted = this.mounted.get(id); if (!mounted) return;
        this.retainState(id, mounted.documentId, mounted.editor.captureView());
        try { mounted.dispose(); }
        finally {
            this.mounted.delete(id); this.destroys++;
            // The language binding releases its document lease after observer delivery.
            queueMicrotask(() => this.controller.collectLoadedDocument());
        }
    }
    readonly anchorInstruction = (): void => {
        const current = this.mounted.get("primary"); if (!current || current.documentId !== this.controller.source.documentId || !this.controller.canCaptureRecovery()) return;
        this.controller.instruction.anchor(current.editor.view.getSnapshot().selection.head);
    };
    readonly insertInstruction = (): void => {
        const current = this.mounted.get("primary"); if (!current || current.documentId !== this.controller.source.documentId || !this.controller.canCaptureRecovery()) return;
        const d = this.controller.workspace.document(current.documentId), at = d.buffer.offsetAt(d.buffer.lineAt(current.editor.view.getSnapshot().selection.head));
        const firstEnd = d.buffer.lineCount > 1 ? d.buffer.offsetAt(1) : 0, tail = d.buffer.slice(Math.max(0, firstEnd - 2), firstEnd), eol = tail.endsWith("\r\n") ? "\r\n" : tail.endsWith("\r") ? "\r" : "\n";
        const result = this.controller.workspace.edit({ documentId: d.id, expectedRevision: d.revision, origin: "human", edits: [{ from: at, to: at,
            insert: '// @transfer {"destination":"target.csv","batchSize":"1000"}' + eol }], history: { kind: "form" }, view: current.editor.view });
        if (result.applied) { this.controller.instruction.anchor(at); current.editor.viewport.revealOffset(at); }
    };
    unmount(): void { for (const id of [...this.mounted.keys()]) this.detach(id); }
    dispose(): void {
        this.stopInputCapture(); this.stopDocumentCleanup();
        this.comparison(null); this.unmount(); this.colors.dispose(); this.links.dispose(); this.actions.dispose(); this.rename.dispose(); this.signature.dispose(); this.project.dispose(); this.navigation.dispose(); this.domain.dispose(); for (const selections of this.selections.values()) for (const view of selections.values()) view.dispose();
        this.selections.clear(); this.states.clear(); this.referenceState = undefined; this.language.clearRetainedView();
        this.locationHistory.dispose(); this.lspOwner?.dispose();
        this.controller.collectLoadedDocument();
    }
    settled(): boolean {
        for (const { editor } of this.mounted.values()) if (!editorSettled(editor)) return false;
        return !this.review || comparisonSettled(this.review);
    }
    debug() {
        const comparison = this.review?.controller.getSnapshot();
        return { lsp: this.lspOwner?.snapshot() ?? null, instruction: this.instructionMount?.debug() ?? null, mounts: this.mounts, destroys: this.destroys, activeViews: this.mounted.size, language: this.language.debug(), hover: this.hover.debug(), tablePaste: this.tablePaste.debug(), domain: this.domain.debug(), navigation: this.navigation.debug(), project: this.project.debug(), rename: this.rename.debug(), actions: this.actions.debug(), links: this.links.debug(), colors: this.colors.debug(), signature: this.signature.debug(),
        comparison: comparison ? { status: comparison.status, generation: comparison.generation, workingRevision: comparison.working?.revision,
            referenceIsWorkingBuffer: comparison.baseline !== null && comparison.baseline.buffer === comparison.working?.buffer,
            progress: comparison.progress && { work: comparison.progress.work, readUnits: comparison.progress.readUnits,
                lineEdits: comparison.progress.lineEdits },
            viewId: this.review!.panes.working.view.id, foldGeneration: this.review!.panes.working.view.folding.getSnapshot().generation, selection: this.review!.panes.working.view.getSnapshot().selection, selectionSet: this.review!.panes.working.view.getSnapshot().selectionSet,
            baseline: comparison.baseline && { version: comparison.baseline.version, epoch: comparison.baseline.epoch, length: comparison.baseline.buffer.length },
            hunks: comparison.hunks.length, pending: this.reviewTickets.map(ticket => ({ kind: ticket.kind, revision: ticket.capture.working.revision, current: ticket.isCurrent() })),
            result: this.reviewResult, work: this.review!.getDiagnostics(), input: this.review!.panes.working.getDiagnostics(), referenceInput: this.review!.panes.reference.getDiagnostics(),
            discards: this.discardTickets.map(({ ticket, variantGeneration }) => ({ revision: ticket.capture.working.revision, current: ticket.isCurrent() && this.controller.variants.state.getSnapshot().generation === variantGeneration })),
            workingViewport: this.review!.panes.working.viewport.getDiagnostics(), referenceViewport: this.review!.panes.reference.viewport.getDiagnostics() } : null,
        views: [...this.mounted].map(([id, { editor, documentId }]) => ({ id, documentId, viewId: editor.view.id, foldGeneration: editor.view.folding.getSnapshot().generation,
            selection: editor.view.getSnapshot().selection, selectionSet: editor.view.getSnapshot().selectionSet, focused: editor.getSnapshot().focused, metrics: { ...editor.getDiagnostics(), viewport: editor.viewport.getDiagnostics() } })) }; }
}
