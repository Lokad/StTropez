import { emptyList } from "../core/empty-list.ts";
import { colorPresentationMethod } from "../protocol/lsp-methods.ts";
import { languageReview } from "./language-review.ts";
import { changedDocument, type ChangedDocument } from "./language-command.ts";
import type { Observable } from "../core/observable.ts";
import { done, failed, refused, stale, type Outcome } from "../core/outcome.ts";
import { mapReplacementSelections } from "../core/selections.ts";
import { decodeLspColor } from "../protocol/lsp-features.ts";
import type { LspColor, LspColorPresentation, LspDocumentColor } from "../protocol/lsp-features.ts";
import { describeLspEdit, type LspWorkspaceEditNote } from "../protocol/lsp-workspace-edit.ts";
import { colorClient, type LspColorClient } from "../protocol/lsp-language.ts";
import type { LspDocumentOwner } from "../protocol/lsp-client.ts";
import type { LspPrepare } from "../protocol/lsp-workspace.ts";
import { isStaleRequest } from "../protocol/wire.ts";
import type { CapturedViewRequest } from "./captured-view.ts";
import { retainDocuments } from "./retained-documents.ts";
import { writableDocument } from "./edit-project.ts";
import { mountSwatches } from "./document-color-swatches.ts";
import type { TextEditor } from "./text-editor.ts";

export type DocumentColorChoice = LspDocumentColor & Readonly<{
    revision: number;
    presentations: (color: LspColor) => Promise<Outcome<readonly ColorPresentationChoice[]>>;
}>;
type Changes = readonly ChangedDocument[];
export type ColorPresentationChoice = ReturnType<typeof colorChoice>;
export type ColorPresentationReview = Readonly<{
    reference: DocumentColorChoice; proposed: LspColor; choice: ColorPresentationChoice;
    edits: LspColorPresentation["edits"]; notes: readonly LspWorkspaceEditNote[]; canApply: boolean; apply: () => Outcome<Changes>;
}>;
export type DocumentColorSnapshot = Readonly<{
    status: "idle" | "discovering" | "ready" | "previewing" | "presentations" | "review" | "applied" | "expired" | "failed" | "disposed";
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

function colorChoice(label: string, index: number,
    choose: (choice: ColorPresentationChoice, index: number, review: boolean) => Outcome<ColorPresentationReview | Changes>) {
    function select(options: Readonly<{ review: true }>): Outcome<ColorPresentationReview>;
    function select(options?: Readonly<{ review?: false }>): Outcome<Changes>;
    function select(options: Readonly<{ review?: boolean }>): Outcome<ColorPresentationReview | Changes>;
    function select(options?: Readonly<{ review?: boolean }>) {
        return choose(choice, index, options?.review === true);
    }
    const choice = Object.freeze({ label, select });
    return choice;
}

/** Review one provider color presentation and apply all its edits as one undo command. */
export function mountDocumentColors(editor: TextEditor, owner: LspDocumentOwner, options: DocumentColorControllerOptions): DocumentColorController {
    const { provider } = owner;
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
            swatches = mountSwatches(editor, owner, activate);
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
    function apply(p: Preview, edits: LspColorPresentation["edits"]): Outcome<Changes> {
        if (!writable()) return refused("not-writable");
        const { document, selectionSet } = p.capture;
        if (!p.capture.commit(() => {
            const result = workspace.edit({ documentId: document.id, expectedRevision: document.revision, edits,
                origin: "host", source: "color-presentation", history: { kind: "refactor" }, view,
                selectionSet: mapReplacementSelections(document.buffer.length, selectionSet, edits) });
            if (!result.applied) throw new Error(result.reason);
            return true;
        })) return stale;
        const updated = workspace.document(document.id);
        const changed = updated.revision !== document.revision;
        release();
        publish("applied", { changed });
        return done(changed ? Object.freeze([changedDocument(updated)]) : emptyList);
    }
    function choose(choice: ColorPresentationChoice, index: number, review: false, expected: ColorPresentationReview): Outcome<Changes>;
    function choose(choice: ColorPresentationChoice, index: number, review: boolean): Outcome<ColorPresentationReview | Changes>;
    function choose(choice: ColorPresentationChoice, index: number, review: boolean,
        expected?: ColorPresentationReview): Outcome<ColorPresentationReview | Changes> {
        scope.assertWritable();
        const j = active.job;
        try {
            const p = j?.preview, result = p?.result?.[index];
            const snapshot = state.get();
            if (!j || !p || !result || snapshot.presentations[index] !== choice || !current(j) || !p.capture.isCurrent()) return stale;
            if (expected && snapshot.review !== expected) return stale;
            if (expected?.canApply === false) return refused("not-writable");
            if (!review) return apply(p, result.edits);
            if (snapshot.review?.choice === choice) return done(snapshot.review);
            const doc = p.capture.document;
            const notes = Object.freeze(result.edits.map(edit => describeLspEdit(doc, doc.id, doc.title, edit)));
            const selected: ColorPresentationReview = Object.freeze({ reference: p.reference, proposed: p.proposed, choice,
                edits: result.edits, notes, canApply: writable(), apply: () => choose(choice, index, false, selected) });
            publish("review", { colors: snapshot.colors, presentations: snapshot.presentations, review: selected });
            return done(selected);
        } catch (error) {
            return j && active.job === j && !j.invalid ? fail(error) : stale;
        }
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
            const choices = Object.freeze(p.result.map((item, index) => colorChoice(item.label, index, choose)));
            publish("presentations", { colors, presentations: choices });
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
        const item: DocumentColorChoice = Object.freeze({ ...raw, revision, presentations: color => preview(item, index, color) }); return item;
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
            const client = colorClient(owner);
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
