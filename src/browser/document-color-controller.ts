import { Store } from "../core/observable.ts";
import type { Observable } from "../core/observable.ts";
import { mapReplacementSelections } from "../core/selections.ts";
import { ownsTextSurface } from "../core/workspace.ts";
import { decodeLspColor } from "../protocol/lsp-features.ts";
import type { LspColor, LspColorPresentation, LspDocumentColor } from "../protocol/lsp-features.ts";
import { createLspColorClient } from "../protocol/lsp-language.ts";
import type { LspPrepare, LspWorkspace } from "../protocol/lsp-workspace.ts";
import { captureViewRequest } from "./captured-view.ts";
import type { CapturedViewRequest } from "./captured-view.ts";
import { retainDocuments } from "./retained-documents.ts";
import type { TextEditor } from "./text-editor.ts";

export type DocumentColorChoice = LspDocumentColor & Readonly<{ revision: number; preview: (color: LspColor) => Promise<void> }>;
export type ColorPresentationChoice = Readonly<{ label: string; select: () => void }>;
export type ColorPresentationReview = Readonly<{
    reference: DocumentColorChoice; proposed: LspColor; choice: ColorPresentationChoice;
    edits: LspColorPresentation["edits"]; canApply: boolean; apply: () => boolean;
}>;
export type DocumentColorSnapshot = Readonly<{
    status: "idle" | "discovering" | "ready" | "previewing" | "review" | "applied" | "expired" | "failed" | "disposed";
    colors: readonly DocumentColorChoice[]; presentations: readonly ColorPresentationChoice[]; review: ColorPresentationReview | null;
    message: string; changed: boolean;
}>;
export type DocumentColorControllerOptions = Readonly<{
    canCapture?: () => boolean; prepareRequest?: (kind: "discovery" | "presentation") => LspPrepare | undefined;
}>;
export type DocumentColorController = Observable<DocumentColorSnapshot> & Readonly<{
    request: () => Promise<void>; dismissPreview: () => void; cancel: () => void; dispose: () => void;
}>;
type Client = ReturnType<typeof createLspColorClient>;
type Capture = CapturedViewRequest<TextEditor["tab"]>;
type Preview = { capture: Capture; reference: DocumentColorChoice; proposed: LspColor; result?: readonly LspColorPresentation[] };
type Job = { client: Client; documents: ReturnType<typeof retainDocuments>; source: Capture; invalid: boolean; timer?: number;
    reply?: Awaited<ReturnType<Client["run"]>["result"]>; registration?: number; preview?: Preview };
const empty = Object.freeze([]);
const idle: DocumentColorSnapshot = Object.freeze({ status: "idle", colors: empty, presentations: empty, review: null, message: "", changed: false });

/** Review one provider color presentation and apply all its edits as one undo command. */
export function createDocumentColorController(editor: TextEditor, provider: LspWorkspace, options: DocumentColorControllerOptions = {}): DocumentColorController {
    const { workspace, view, tab } = editor, win = editor.element.ownerDocument.defaultView!;
    if (!ownsTextSurface(workspace, view, tab) || editor.signal.aborted) throw new Error("Document colors require a live document view.");
    const scope = workspace.createNotificationScope(), state = new Store(idle, scope), events = new AbortController(), observers = new Set<() => void>();
    let job: Job | undefined;
    function available() {
        const a = editor.activity();
        return !events.signal.aborted && editor.element.isConnected && !editor.getSnapshot().disabled && !a.composing && !a.pendingInput
            && !a.pendingCommand && (options.canCapture?.() ?? true);
    }
    const capture = () => captureViewRequest(workspace, tab, view, { available });
    function writable() {
        const metadata = workspace.resourceForDocument(view.documentId).metadata.getSnapshot();
        return editor.getSnapshot().readOnlyReason === null && metadata.editLock === null && metadata.capabilities.edit.includes("human") && metadata.capabilities.edit.includes("host");
    }
    function publish(status: DocumentColorSnapshot["status"], patch: Partial<Omit<DocumentColorSnapshot, "status">> = {}) {
        scope.publish(state, Object.freeze({ ...idle, status, ...patch }));
    }
    function release() {
        const j = job; job = undefined;
        if (!j) return;
        win.clearTimeout(j.timer); j.preview?.capture.cancel(); j.source.cancel(); j.documents.dispose(); j.client.dispose();
    }
    function expire(j: Job) {
        if (job !== j || j.invalid) return;
        j.invalid = true;
        queueMicrotask(() => { if (job === j) { release(); publish("expired"); } });
    }
    function fail(j: Job, error: unknown) {
        if (job !== j || j.invalid) return;
        release(); publish("failed", { message: error instanceof Error ? error.message : String(error) });
    }
    function current(j: Job) {
        return job === j && !j.invalid && available() && ownsTextSurface(workspace, view, tab) && (j.reply?.isCurrent() ?? j.source.isCurrent());
    }
    function startTimer(j: Job) {
        win.clearTimeout(j.timer); j.timer = win.setTimeout(() => fail(j, new Error("Color provider request timed out.")), 30000);
    }
    function dismissPreview() {
        scope.assertWritable();
        const j = job, p = j?.preview;
        if (!j || !p) return;
        // A pending follow-up uses the discovery lane. Disposing it cancels the wire request.
        if (!p.result) { release(); publish("expired"); return; }
        delete j.preview; p.capture.cancel(); publish("ready", { colors: state.get().colors });
    }
    function apply(review: ColorPresentationReview): boolean {
        scope.assertWritable();
        const j = job, p = j?.preview;
        if (state.get().review !== review || !review.canApply || !j || !p || !current(j) || !writable()) return false;
        const { document, selectionSet } = p.capture;
        try {
            if (!p.capture.commit(() => {
                const result = workspace.edit({ documentId: document.id, expectedRevision: document.revision, edits: review.edits,
                    origin: "host", source: "color-presentation", history: { kind: "refactor" }, view,
                    selectionSet: mapReplacementSelections(document.buffer.length, selectionSet, review.edits) });
                if (!result.applied) throw new Error(result.reason);
                return true;
            })) return false;
            const changed = workspace.document(document.id).revision !== document.revision;
            release(); publish("applied", { changed }); return true;
        } catch (error) { fail(j, error); return false; }
    }
    function select(choice: ColorPresentationChoice, index: number, presentations = state.get().presentations) {
        scope.assertWritable();
        const j = job, p = j?.preview, result = p?.result?.[index];
        if (!j || !p || !result || presentations[index] !== choice || !current(j) || !p.capture.isCurrent()) return;
        if (state.get().review?.choice === choice) return;
        const review: ColorPresentationReview = Object.freeze({ reference: p.reference, proposed: p.proposed, choice,
            edits: result.edits, canApply: writable(), apply: () => apply(review) });
        publish("review", { colors: state.get().colors, presentations, review });
    }
    function presentation(raw: LspColorPresentation, index: number): ColorPresentationChoice {
        const choice: ColorPresentationChoice = Object.freeze({ label: raw.label, select: () => select(choice, index) }); return choice;
    }
    async function preview(reference: DocumentColorChoice, index: number, value: LspColor) {
        scope.assertWritable();
        const j = job, { colors } = state.get();
        if (!j?.reply || colors[index] !== reference || !current(j) || j.preview && !j.preview.result) return;
        const proposed = decodeLspColor(value);
        dismissPreview();
        const source = capture();
        if (!source) { expire(j); return; }
        const p: Preview = { capture: source, reference, proposed }; j.preview = p;
        source.signal.addEventListener("abort", () => {
            queueMicrotask(() => { if (job === j && j.preview === p && !j.invalid) dismissPreview(); });
        }, { once: true });
        try {
            startTimer(j); publish("previewing", { colors });
            p.result = await j.reply.presentations(j.reply.items[index]!, proposed, options.prepareRequest?.("presentation"));
            if (job !== j || j.preview !== p || j.invalid) return;
            if (!current(j)) { expire(j); return; }
            if (!source.isCurrent()) { dismissPreview(); return; }
            win.clearTimeout(j.timer);
            const choices = Object.freeze(p.result.map(presentation));
            if (choices.length) select(choices[0]!, 0, choices);
            else publish("review", { colors });
        } catch (error) { fail(j, error); }
    }
    function reference(raw: LspDocumentColor, index: number, revision: number): DocumentColorChoice {
        const item: DocumentColorChoice = Object.freeze({ ...raw, revision, preview: color => preview(item, index, color) }); return item;
    }
    async function request() {
        scope.assertWritable(); if (events.signal.aborted) return;
        release(); const source = capture();
        if (!source) { publish("expired"); return; }
        let client: Client;
        try { client = createLspColorClient(provider); } catch (error) { source.cancel(); publish("failed", { message: String(error) }); return; }
        const j: Job = { source, client, invalid: false, documents: retainDocuments(workspace, available, () => expire(j)) }; job = j;
        try {
            j.documents.include(source.document);
            source.signal.addEventListener("abort", () => { if (!j.reply) expire(j); }, { once: true });
            startTimer(j); publish("discovering");
            const reply = await client.run({ document: source.document, prepare: options.prepareRequest?.("discovery") }).result;
            if (!current(j) || !reply.isCurrent()) { expire(j); return; }
            j.reply = reply; j.registration = provider.getSnapshot().registrationGeneration; source.cancel(); win.clearTimeout(j.timer);
            publish("ready", { colors: Object.freeze(reply.items.map((item, index) => reference(item, index, source.document.revision))) });
        } catch (error) { fail(j, error); }
    }
    function cancel() { scope.assertWritable(); if (!events.signal.aborted) { release(); publish("idle"); } }
    const stop = provider.subscribe(() => {
        const j = job;
        if (!j?.reply || j.reply.isCurrent()) return;
        const connection = provider.getSnapshot();
        // A pending decoder reports its own error. Disconnects and withdrawn capabilities cancel the request immediately.
        if (!j.preview || j.preview.result || connection.phase !== "ready" || connection.registrationGeneration !== j.registration) expire(j);
    });
    editor.onEditIntent(() => { if (job) cancel(); }, events.signal);
    function dispose() {
        if (events.signal.aborted) return;
        scope.assertWritable(); events.abort(); stop(); release(); editor.signal.removeEventListener("abort", dispose);
        publish("disposed"); for (const unsubscribe of observers) unsubscribe();
    }
    events.signal.addEventListener("abort", provider.retainFeatures("textDocument/documentColor", "textDocument/colorPresentation"), { once: true });
    editor.signal.addEventListener("abort", dispose, { once: true });
    return Object.freeze({ request, dismissPreview, cancel, dispose, getSnapshot: state.observable.getSnapshot, subscribe(listener: () => void) {
        if (events.signal.aborted) throw new Error("Document color controller is disposed.");
        const off = state.observable.subscribe(listener), unsubscribe = () => { off(); observers.delete(unsubscribe); };
        observers.add(unsubscribe); return unsubscribe;
    } });
}
