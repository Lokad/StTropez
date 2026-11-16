import { TextBuffer, Workspace, WorkspaceCommands } from "sttropez";
import type { ComparisonBaseline, SaveOutcome, SaveResponse, SaveSubmission, Selection } from "sttropez";
import { mountEditingCandidate, mountTextComparison } from "sttropez/browser";
import type { EditingCandidate, TextComparison } from "sttropez/browser";

/** A host-owned local fixture. Every editor/model import resolves from the restored package. */
export function mountPackagedPilot(host: HTMLElement, original: string) {
    const owner = host.ownerDocument, win = owner.defaultView!;
    const errors: string[] = [], workspace = new Workspace({ onListenerError: error => errors.push(String(error)) });
    const initial = TextBuffer.from(original), source = workspace.createTextResourceFromBuffer(
        { scope: "package-pilot", resource: "source", variant: "working" }, "Packaged source", { buffer: initial, serverVersion: "v0" });
    const tab = workspace.open({ kind: "text", documentId: source.documentId }, "source");
    const primaryView = workspace.createDocumentView(source.documentId), peerView = workspace.createDocumentView(source.documentId, { anchor: 12, head: 3 });
    const reviewView = workspace.createDocumentView(source.documentId, { anchor: 2, head: 2 });
    const root = owner.createElement("section"), heading = owner.createElement("h1"), controls = owner.createElement("div");
    heading.textContent = "Restored editor and review pilot"; controls.className = "pilot-controls";
    const button = (label: string, action: () => void) => { const node = owner.createElement("button"); node.type = "button"; node.textContent = label;
        node.addEventListener("click", action, { signal: listeners.signal }); controls.append(node); return node; };
    const listeners = new AbortController(), status = owner.createElement("output"), message = owner.createElement("output"), progress = owner.createElement("progress");
    status.className = message.className = "pilot-status"; status.setAttribute("aria-label", "Source status"); message.setAttribute("aria-label", "Save result");
    progress.setAttribute("aria-label", "Background activity"); progress.max = 100;
    const editors = owner.createElement("div"); editors.className = "pilot-editors";
    const editorHost = (label: string) => { const section = owner.createElement("section"), title = owner.createElement("h2"), node = owner.createElement("div");
        title.textContent = label; node.className = "pilot-editor"; section.append(title, node); editors.append(section); return node; };
    const primaryHost = editorHost("Source"), peerHost = editorHost("Independent source view"), comparisonHost = owner.createElement("div");
    root.append(heading, controls, status, message, progress, editors, comparisonHost); host.append(root);
    let primary: EditingCandidate | undefined, peer: EditingCandidate | undefined, comparison: TextComparison | undefined;
    let unsubscribeComparison = () => {}, mounts = 0, disposed = false, released = false, background = 0, pendingCommands = 0, reportedFailures = 0, trustedInputEvents = 0, untrustedInputEvents = 0;
    root.addEventListener("input", event => { if (event.isTrusted) trustedInputEvents++; else untrustedInputEvents++; }, { signal: listeners.signal });
    let reviewedVersion: string | null = null, remote: ComparisonBaseline | null = null, savedReference: ComparisonBaseline | null = null;
    let resultMessage = "Ready", lastOutcome: Readonly<{ kind: string; submittedRevision?: number; serverVersion?: string; canonicalApplied?: boolean }> | null = null;
    type Pending = { submission: SaveSubmission<string>; resolve: (response: SaveResponse<string>) => void; reject: (error: Error) => void };
    const pending = new Map<string, Pending>();
    const commands = new WorkspaceCommands(workspace, () => { reportedFailures++; });
    function readSource() { const document = workspace.document(source.documentId), metadata = source.metadata.getSnapshot();
        return Object.freeze({ id: source.id, documentId: source.documentId, revision: document.revision, length: document.buffer.length,
            exports: document.buffer.readMetrics().textExports, serverVersion: metadata.serverVersion, dirty: metadata.dirty, saveStatus: metadata.saveStatus }); }
    let terminalSource: ReturnType<typeof readSource> | undefined;
    const setText = (element: HTMLElement, value: string) => { if (element.textContent !== value) element.textContent = value; };
    function render() {
        if (disposed) return; const state = readSource();
        setText(status, `Server ${state.serverVersion} · local revision ${state.revision} · ${state.dirty ? "unsaved changes" : "saved"}`);
        setText(message, resultMessage); save.disabled = pendingCommands !== 0; review.disabled = pendingCommands !== 0 || remote === null;
        reviewedSave.disabled = pendingCommands !== 0 || reviewedVersion === null || comparison?.controller.getSnapshot().status !== "ready";
        showSaved.disabled = pendingCommands !== 0 || savedReference === null;
    }
    function refreshReference(value: ComparisonBaseline): boolean {
        if (!comparison || disposed) return false; const ticket = comparison.controller.beginRefresh();
        try { return ticket.complete(value); } finally { ticket.finish(); }
    }
    function startSave(reviewed: boolean): void {
        if (disposed || pendingCommands || reviewed && reviewedVersion === null) return;
        const document = workspace.document(source.documentId), capturedBuffer = document.buffer, expected = reviewedVersion;
        pendingCommands++; resultMessage = "Saving captured source"; render();
        let command: Promise<SaveOutcome<string>>;
        const port = { save: (submission: SaveSubmission<string>) => new Promise<SaveResponse<string>>((resolve, reject) => {
            pending.set(submission.id, { submission, resolve, reject }); render();
        }) };
        try { command = reviewed ? commands.save(source, port, { target: workspace.captureResource(source.id), expectedRevision: document.revision, expectedServerVersion: expected! }) : commands.save(source, port); }
        catch (error) { pendingCommands--; errors.push(String(error)); render(); return; }
        void command.then(outcome => {
            if (outcome.kind === "saved") {
                const receipt = outcome.receipt;
                savedReference = Object.freeze({ buffer: receipt.savedValue === receipt.submission.value ? capturedBuffer : TextBuffer.from(receipt.savedValue), version: `saved:${receipt.serverVersion}` });
                reviewedVersion = null; remote = null; resultMessage = "Saved captured source; later edits are retained";
                lastOutcome = Object.freeze({ kind: outcome.kind, submittedRevision: receipt.submission.revision, serverVersion: receipt.serverVersion, canonicalApplied: receipt.canonicalApplied });
            } else if (outcome.kind === "conflict") {
                resultMessage = `Conflict with ${outcome.serverVersion}; review remote source`; lastOutcome = Object.freeze({ kind: outcome.kind, serverVersion: outcome.serverVersion });
            } else { resultMessage = "Save failed; corrections are retained for retry"; lastOutcome = Object.freeze({ kind: "failed" }); }
        }).catch(error => errors.push(String(error))).finally(() => { pendingCommands--; render(); });
    }
    const save = button("Save source", () => startSave(false));
    const review = button("Review remote source", () => { if (remote && refreshReference(remote)) { reviewedVersion = "v1"; resultMessage = "Reviewing remote v1; local source is retained"; render(); } });
    const reviewedSave = button("Save reviewed source", () => startSave(true));
    const showSaved = button("Show saved reference", () => { if (savedReference) refreshReference(savedReference); });
    function mountViews(baseline: ComparisonBaseline): void {
        primary = mountEditingCandidate(primaryHost, workspace, tab, { view: primaryView, ariaLabel: "Primary source" });
        peer = mountEditingCandidate(peerHost, workspace, tab, { view: peerView, ariaLabel: "Secondary source" });
        comparison = mountTextComparison(comparisonHost, workspace, tab, baseline, { view: reviewView, ariaLabel: "Source review" });
        unsubscribeComparison = comparison.controller.subscribe(render); mounts++;
    }
    function unmountViews(): void { unsubscribeComparison(); comparison?.destroy(); primary?.destroy(); peer?.destroy(); primary = peer = undefined; comparison = undefined; }
    mountViews(Object.freeze({ buffer: initial, version: "saved:v0" }));
    const subscriptions = [workspace.observeDocument(source.documentId).subscribe(render), source.metadata.subscribe(render)];
    const timer = win.setInterval(() => { background++; progress.value = background % 100; }, 50); render();
    const fixture = {
        onSourceRender: (id: "primary" | "secondary" | "comparison", listener: () => void) => {
            const editor = id === "primary" ? primary : id === "secondary" ? peer : comparison?.working;
            if (!editor) throw new Error("Source viewport is not mounted.");
            return editor.viewport.onRender(listener);
        },
        snapshot: () => {
            const c = comparison?.controller.getSnapshot(), document = released ? null : workspace.document(source.documentId);
            const views = [["primary", primary], ["secondary", peer]] as const;
            return Object.freeze({ source: released ? terminalSource! : readSource(), history: released ? Object.freeze({ undoDepth: 0, redoDepth: 0 }) : workspace.observeHistory(source.documentId).getSnapshot(),
                activity: Object.freeze({ background }), pendingCommands, reportedFailures, lastOutcome, disposed, released, trustedInputEvents, untrustedInputEvents,
                errors: Object.freeze([...errors]), diagnostics: workspace.diagnostics(),
                pendingSaves: Object.freeze([...pending.values()].map(({ submission: s }) => Object.freeze({ id: s.id, resourceId: s.target.id, revision: s.revision, length: s.value.length, expectedServerVersion: s.expectedServerVersion }))),
                bindings: Object.freeze({ activeViews: views.filter(([, editor]) => editor).length, mounts,
                    views: Object.freeze(views.flatMap(([id, editor]) => editor ? [Object.freeze({ id, viewId: editor.view.id, documentId: editor.view.documentId,
                        selection: editor.view.getSnapshot().selection, metrics: Object.freeze({ ...editor.snapshot(), viewport: editor.viewport.snapshot() }) })] : [])),
                    comparison: c && comparison ? Object.freeze({ status: c.status, generation: c.generation, baseline: c.baseline ? Object.freeze({ version: c.baseline.version, epoch: c.baseline.epoch, length: c.baseline.buffer.length }) : null,
                        workingRevision: c.working?.revision, referenceIsWorkingBuffer: c.baseline?.buffer === document?.buffer, viewId: reviewView.id, selection: reviewView.getSnapshot().selection,
                        hunks: c.hunks.length, hunkRanges: c.hunks, progress: c.progress, work: comparison.snapshot(), input: comparison.working.snapshot(), workingViewport: comparison.working.viewport.snapshot(), referenceViewport: comparison.referenceViewport()?.snapshot() }) : null }) });
        },
        range: (from: number, to: number) => workspace.document(source.documentId).buffer.slice(from, to),
        referenceRange: (from: number, to: number) => comparison!.controller.getSnapshot().baseline!.buffer.slice(from, to),
        selectSource: (id: "primary" | "secondary", revision: number, selection: Selection) => (id === "primary" ? primaryView : peerView).setSelection(revision, selection),
        pendingRange: (id: string, from: number, to: number) => pending.get(id)!.submission.value.slice(from, to),
        respond: (id: string, kind: "conflict" | "failure" | "saved" | "canonical", serverVersion?: string) => {
            const request = pending.get(id); if (!request) return false; pending.delete(id);
            if (kind === "failure") request.reject(new Error("Simulated save failure"));
            else if (kind === "conflict") { remote = Object.freeze({ buffer: TextBuffer.from("remote " + original), version: "remote:v1" }); request.resolve({ kind: "conflict", serverVersion: "v1" }); }
            else request.resolve(kind === "canonical" ? { kind: "saved", serverVersion: serverVersion ?? "v3", canonical: request.submission.value + "\r\ncanonical server reply" } : { kind: "saved", serverVersion: serverVersion ?? "v2" });
            return true;
        },
        remount: () => {
            if (!primary || !peer || !comparison || disposed) return false;
            const active = owner.activeElement, focus = active === primary.input ? "primary" : active === peer.input ? "secondary" : active === comparison.working.input ? "comparison" : null;
            const states = [primary.captureView(), peer.captureView(), comparison.working.captureView()] as const, baseline = comparison.controller.getSnapshot().baseline!;
            unmountViews(); mountViews(baseline);
            primary!.restoreView(states[0]); peer!.restoreView(states[1]); comparison!.working.restoreView(states[2]);
            if (focus === "primary") primary!.focus(); else if (focus === "secondary") peer!.focus(); else if (focus === "comparison") comparison!.working.focus();
            return true;
        },
        dispose: () => {
            if (disposed) return; disposed = true; win.clearInterval(timer); listeners.abort(); subscriptions.forEach(unsubscribe => unsubscribe()); unmountViews();
            primaryView.dispose(); peerView.dispose(); reviewView.dispose(); workspace.close(tab); root.remove();
            // Unsaved source remains owned by this host after a late failure, with no view/listener lease.
        },
        release: () => {
            if (!disposed || pendingCommands || pending.size) throw new Error("Settle pending commands before explicitly releasing retained source.");
            if (released) return; terminalSource = readSource();
            workspace.releaseResource(source.id, true); released = true;
        }
    };
    return Object.freeze(fixture);
}

Object.assign(window, { mountPackagedPilot: (text: string) => {
    const host = document.getElementById("pilot"); if (!host) throw new Error("Missing packaged pilot host.");
    const fixture = mountPackagedPilot(host, text); Object.assign(window, { hostFixture: fixture }); return fixture.snapshot();
} });
