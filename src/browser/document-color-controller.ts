import { emptyList } from "../core/empty-list.ts";
import { colorPresentationMethod } from "../protocol/lsp-methods.ts";
import { languageReview } from "./language-review.ts";
import { reviewApplied, reviewFailed, reviewRefused, type ReviewEditResult } from "./review-edit.ts";
import type { Observable } from "../core/observable.ts";
import { done, failed, refused, stale, type Outcome } from "../core/outcome.ts";
import { mapReplacementSelections } from "../core/selections.ts";
import { decodeLspColor } from "../protocol/lsp-features.ts";
import type { LspColor, LspColorPresentation, LspDocumentColor } from "../protocol/lsp-features.ts";
import { describeLspEdit, type LspWorkspaceEditNote } from "../protocol/lsp-workspace-edit.ts";
import { colorClient, type LspColorClient } from "../protocol/lsp-language.ts";
import type { LspDocumentOwner } from "../protocol/lsp-client.ts";
import type { LspPrepare, LspWorkspace } from "../protocol/lsp-workspace.ts";
import { isStaleRequest } from "../protocol/wire.ts";
import type { CapturedViewRequest } from "./captured-view.ts";
import { retainDocuments } from "./retained-documents.ts";
import { writableDocument } from "./edit-project.ts";
import { mountSwatches } from "./document-color-swatches.ts";
import type { TextEditor } from "./text-editor.ts";

export type DocumentColorChoice = LspDocumentColor & Readonly<{
    revision: number;
    preview: (color: LspColor) => Promise<Outcome<readonly ColorPresentationChoice[]>>;
}>;
export type ColorPresentationChoice = Readonly<{ label: string; select: () => ColorPresentationReview | undefined }>;
export type ColorPresentationReview = Readonly<{
    reference: DocumentColorChoice; proposed: LspColor; choice: ColorPresentationChoice;
    edits: LspColorPresentation["edits"]; notes: readonly LspWorkspaceEditNote[]; canApply: boolean; apply: () => ReviewEditResult;
}>;
export type DocumentColorSnapshot = Readonly<{
    status: "idle" | "discovering" | "ready" | "previewing" | "review" | "applied" | "expired" | "failed" | "disposed";
    colors: readonly DocumentColorChoice[]; presentations: readonly ColorPresentationChoice[]; review: ColorPresentationReview | null;
    message: string; changed: boolean;
}>;
export type DocumentColorControllerOptions = Readonly<{
    swatches?: boolean | ((item: LspDocumentColor) => void);
    canCapture?: () => boolean; prepareRequest?: (kind: "discovery" | "presentation") => LspPrepare | undefined;
}>;
export type DocumentColorController = Observable<DocumentColorSnapshot> & Readonly<{
    colorAt: (offset: number) => LspDocumentColor | undefined;
    setSwatches: (enabled: boolean) => void;
    request: () => Promise<Outcome<readonly DocumentColorChoice[]>>;
    dismissPreview: () => void; cancel: () => void; dispose: () => void;
}>;
type Capture = CapturedViewRequest<TextEditor["tab"]>;
type TimedRequest = { timeout?: ReturnType<typeof failed> };
type Preview = TimedRequest & { capture: Capture; reference: DocumentColorChoice; proposed: LspColor; result?: readonly LspColorPresentation[] };
type Job = TimedRequest & { client: LspColorClient; project: ReturnType<typeof retainDocuments>; source: Capture; invalid: boolean; timer?: number;
    reply?: Awaited<ReturnType<LspColorClient["run"]>["result"]>; registration?: number; preview?: Preview };
const idle: DocumentColorSnapshot = Object.freeze({ status: "idle", colors: emptyList, presentations: emptyList, review: null, message: "", changed: false });

/** Review one provider color presentation and apply all its edits as one undo command. */
export const createDocumentColorController: (editor: TextEditor, provider: LspWorkspace,
    options?: DocumentColorControllerOptions) => DocumentColorController = mountDocumentColors;

export function mountDocumentColors(editor: TextEditor, provider: LspWorkspace, options: DocumentColorControllerOptions = {},
    shared?: LspDocumentOwner): DocumentColorController {
    const { workspace, view, tab } = editor, win = editor.element.ownerDocument.defaultView!;
    const { scope, state, signal, active, available, capture, release, expire, mount } =
        languageReview<Job, DocumentColorSnapshot>(editor, "Document color", idle, options.canCapture,
            status => publish(status), j => j.preview?.capture.cancel());
    let swatches: ReturnType<typeof mountSwatches> | undefined;
    function setSwatches(enabled: boolean) {
        scope.assertWritable();
        if (signal.aborted || enabled === !!swatches) return;
        if (enabled) {
            const activate = typeof options.swatches === "function" ? options.swatches : undefined;
            swatches = mountSwatches(editor, provider, shared ?? provider, activate);
        } else {
            swatches?.dispose();
            swatches = undefined;
        }
    }
    const writable = () => writableDocument(editor, view.documentId);
    function publish(status: DocumentColorSnapshot["status"], patch: Partial<Omit<DocumentColorSnapshot, "status">> = {}) {
        scope.publish(state, Object.freeze({ ...idle, status, ...patch }));
    }
    function fail(error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        release();
        swatches?.clear();
        publish("failed", { message });
        return failed(error);
    }
    function current(j: Job) {
        return active.job === j && !j.invalid && available(view.documentId) && workspace.ownsDocumentView(view, tab) && (j.reply?.isCurrent() ?? j.source.isCurrent());
    }
    function startTimer(j: Job, call: TimedRequest) {
        win.clearTimeout(j.timer);
        j.timer = win.setTimeout(() => {
            if (active.job === j && !j.invalid && (call === j || j.preview === call)) {
                call.timeout = fail(new Error("Color provider request timed out."));
            }
        }, 30000);
    }
    function dismissPreview() {
        scope.assertWritable();
        const j = active.job, p = j?.preview;
        if (!j || !p) return;
        delete j.preview; win.clearTimeout(j.timer); p.capture.cancel();
        if (current(j)) publish("ready", { colors: state.get().colors });
        else expire(j);
    }
    function apply(review: ColorPresentationReview): ReviewEditResult {
        scope.assertWritable();
        const j = active.job, p = j?.preview;
        if (state.get().review !== review || !j || !p || !current(j)) return reviewRefused("expired");
        if (!review.canApply || !writable()) return reviewRefused("not-writable");
        const { document, selectionSet } = p.capture;
        try {
            if (!p.capture.commit(() => {
                const result = workspace.edit({ documentId: document.id, expectedRevision: document.revision, edits: review.edits,
                    origin: "host", source: "color-presentation", history: { kind: "refactor" }, view,
                    selectionSet: mapReplacementSelections(document.buffer.length, selectionSet, review.edits) });
                if (!result.applied) throw new Error(result.reason);
                return true;
            })) return reviewRefused("expired");
            const changed = workspace.document(document.id).revision !== document.revision;
            release(); publish("applied", { changed }); return reviewApplied;
        } catch (error) {
            if (active.job !== j || j.invalid) return reviewRefused("expired");
            fail(error);
            return reviewFailed(state.get().message);
        }
    }
    function select(choice: ColorPresentationChoice, index: number, presentations = state.get().presentations) {
        scope.assertWritable();
        const j = active.job, p = j?.preview, result = p?.result?.[index];
        if (!j || !p || !result || presentations[index] !== choice || !current(j) || !p.capture.isCurrent()) return;
        const selected = state.get().review;
        if (selected?.choice === choice) return selected;
        const doc = p.capture.document;
        const notes = Object.freeze(result.edits.map(edit => describeLspEdit(doc, doc.id, doc.title, edit)));
        const review: ColorPresentationReview = Object.freeze({ reference: p.reference, proposed: p.proposed, choice,
            edits: result.edits, notes, canApply: writable(), apply: () => apply(review) });
        publish("review", { colors: state.get().colors, presentations, review });
        return review;
    }
    function presentation(raw: LspColorPresentation, index: number): ColorPresentationChoice {
        const choice: ColorPresentationChoice = Object.freeze({ label: raw.label, select: () => select(choice, index) }); return choice;
    }
    async function preview(reference: DocumentColorChoice, index: number, value: LspColor): Promise<Outcome<readonly ColorPresentationChoice[]>> {
        scope.assertWritable();
        const j = active.job, { colors } = state.get();
        if (!j?.reply || colors[index] !== reference) return stale;
        let p: Preview | undefined;
        try {
            if (!current(j)) {
                expire(j);
                return stale;
            }
            let proposed: LspColor;
            try { proposed = decodeLspColor(value); } catch { return refused("invalid-color"); }
            dismissPreview();
            const source = capture();
            if (!source) {
                expire(j);
                return refused("unavailable-view");
            }
            p = j.preview = { capture: source, reference, proposed };
            source.signal.addEventListener("abort", () => {
                queueMicrotask(() => { if (active.job === j && j.preview === p && !j.invalid) dismissPreview(); });
            }, { once: true });
            startTimer(j, p);
            publish("previewing", { colors });
            p.result = await j.reply.presentations(j.reply.items[index]!, proposed, options.prepareRequest?.("presentation"), cancel => {
                if (source.signal.aborted) cancel();
                else source.signal.addEventListener("abort", cancel, { once: true });
                return () => source.signal.removeEventListener("abort", cancel);
            });
            if (j.preview !== p) return stale;
            if (!current(j)) {
                expire(j);
                return stale;
            }
            if (!source.isCurrent()) {
                dismissPreview();
                return stale;
            }
            win.clearTimeout(j.timer);
            const choices = Object.freeze(p.result.map(presentation));
            if (choices.length) select(choices[0]!, 0, choices);
            else publish("review", { colors, presentations: choices });
            return done(choices);
        } catch (error) {
            if (p?.timeout) return p.timeout;
            if (active.job !== j || j.invalid || p && (j.preview !== p || p.capture.signal.aborted)) return stale;
            if (isStaleRequest(error)) {
                dismissPreview();
                return stale;
            }
            return fail(error);
        }
    }
    function reference(raw: LspDocumentColor, index: number, revision: number): DocumentColorChoice {
        const item: DocumentColorChoice = Object.freeze({ ...raw, revision, preview: color => preview(item, index, color) }); return item;
    }
    async function request(): Promise<Outcome<readonly DocumentColorChoice[]>> {
        scope.assertWritable();
        if (signal.aborted) return stale;
        release();
        let source: Capture | undefined;
        let pending: Job | undefined;
        try {
            source = capture();
            if (!source) {
                publish("expired");
                return refused("unavailable-view");
            }
            const client = colorClient(shared ?? provider);
            const j: Job = { source, client, invalid: false,
                project: retainDocuments(workspace, available, () => expire(j)) };
            pending = active.job = j;
            j.project.include(source.document);
            source.signal.addEventListener("abort", () => { if (!j.reply) expire(j); }, { once: true });
            startTimer(j, j);
            publish("discovering");
            const reply = await client.run({ document: source.document, prepare: options.prepareRequest?.("discovery") }).result;
            if (!current(j) || !reply.isCurrent()) {
                expire(j);
                return stale;
            }
            j.reply = reply;
            j.registration = provider.getSnapshot().registrationVersion(colorPresentationMethod);
            source.cancel();
            win.clearTimeout(j.timer);
            const colors = Object.freeze(reply.items.map((item, index) => reference(item, index, j.source.document.revision)));
            swatches?.accept(j.source.document, reply.items);
            publish("ready", { colors });
            return done(colors);
        } catch (error) {
            if (pending?.timeout) return pending.timeout;
            if (!pending) source?.cancel();
            else if (active.job !== pending || pending.invalid || isStaleRequest(error)) {
                expire(pending);
                return stale;
            }
            return fail(error);
        }
    }
    const stop = provider.subscribe(() => {
        const j = active.job;
        if (!j?.reply || j.reply.isCurrent()) return;
        const connection = provider.getSnapshot();
        // A pending decoder reports its own error. Disconnects and withdrawn capabilities cancel the request immediately.
        if (!j.preview || j.preview.result || connection.phase !== "ready" || connection.registrationVersion(colorPresentationMethod) !== j.registration) expire(j);
    });
    const controls = mount(() => {
        stop();
        swatches?.dispose();
        swatches = undefined;
    });
    try { setSwatches(!!options.swatches); } catch (error) { controls.dispose(); throw error; }
    return Object.freeze({ ...controls, request, dismissPreview, setSwatches, colorAt: (offset: number) => swatches?.at(offset) });
}
