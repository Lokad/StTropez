import type { DocumentSnapshot, EditRequest } from "../core/workspace.ts";
import type { SelectionSet } from "../core/selections.ts";
import { stale } from "../core/outcome.ts";
import { captureViewRequest, editorReadyForRequest } from "./captured-view.ts";
import type { TextEditor } from "./text-editor.ts";

type OperationCall<T> = PromiseLike<T> | Readonly<{ result: PromiseLike<T>; cancel: () => void }>;
type OperationEdit = Pick<EditRequest, "edits" | "selection" | "selectionSet" | "source" | "history">;
export type EditorOperation = Readonly<{
    document: DocumentSnapshot; selectionSet: SelectionSet; signal: AbortSignal;
    step: <T>(call: OperationCall<T>, deliver?: (value: T) => void | PromiseLike<void>) => Promise<T>;
    /** Stage one edit for the captured document. It commits when the callback finishes current. */
    apply: (edit: OperationEdit) => boolean;
}>;
export type EditorOperationOptions = Readonly<{ write?: boolean; signal?: AbortSignal }>;
export type EditorOperationOutcome<T> = Readonly<{ status: "completed"; value: T } | { status: "stale" }>;

/** A private interruption unwinds the callback at its await. Callers receive a typed outcome. */
export async function runEditorOperation<T>(editor: TextEditor, options: EditorOperationOptions,
    work: (op: EditorOperation) => T | PromiseLike<T>): Promise<EditorOperationOutcome<T>> {
    const { write = false, signal } = options;
    if (signal?.aborted || editor.signal.aborted) return stale;
    const available = () => editorReadyForRequest(editor) && (!write || editor.getSnapshot().readOnlyReason === null);
    const capture = captureViewRequest(editor.workspace, editor.tab, editor.view, { available, ...(write ? { editOrigin: "human" } : {}) });
    if (!capture) return stale;
    const lifetime = new AbortController(), guards: (() => boolean)[] = [];
    let pendingEdit: OperationEdit | undefined;
    const cancel = () => lifetime.abort();
    const current = () => {
        if (lifetime.signal.aborted) return false;
        if (capture.isCurrent() && guards.every(check => check())) return true;
        cancel(); return false;
    };
    const requireCurrent = () => { if (!current()) throw stale; };
    const step = async <R>(call: OperationCall<R>, deliver?: (value: R) => void | PromiseLike<void>): Promise<R> => {
        let remote = "result" in call ? call : undefined;
        const promise = Promise.resolve("result" in call ? call.result : call);
        let interrupt: (() => void) | undefined;
        try {
            const interruption = new Promise<never>((_, reject) => {
                interrupt = () => {
                    try { remote?.cancel(); } catch (error) { reject(error); return; }
                    reject(stale);
                };
                if (lifetime.signal.aborted) interrupt();
                else lifetime.signal.addEventListener("abort", interrupt, { once: true });
            });
            const pending = Promise.race([promise, interruption]);
            if (!current()) cancel();
            const result = await pending;
            remote = undefined;
            if (result && typeof result === "object" && "isCurrent" in result && typeof result.isCurrent === "function") {
                const check = result.isCurrent.bind(result) as () => boolean;
                guards.push(check);
            }
            requireCurrent();
            if (deliver) {
                const delivered = deliver(result);
                if (delivered) await Promise.race([delivered, interruption]);
                requireCurrent();
            }
            return result;
        } finally { if (interrupt) lifetime.signal.removeEventListener("abort", interrupt); }
    };
    try {
        capture.signal.addEventListener("abort", cancel, { once: true, signal: lifetime.signal });
        const listener = { once: true, signal: lifetime.signal };
        editor.signal.addEventListener("abort", cancel, listener);
        signal?.addEventListener("abort", cancel, listener);
        editor.onEditIntent(kind => { if (kind === "compositionstart") cancel(); }, lifetime.signal);
        if (!current()) return stale;
        const op: EditorOperation = Object.freeze({ document: capture.document, selectionSet: capture.selectionSet, signal: lifetime.signal, step,
            apply: edit => {
                if (!write || pendingEdit || !current()) return false;
                const { edits, source, history, selection, selectionSet } = edit;
                pendingEdit = structuredClone({ edits, ...(source !== undefined ? { source } : {}), ...(history ? { history } : {}),
                    ...(selection ? { selection } : {}), ...(selectionSet ? { selectionSet } : {}) });
                return true;
            } });
        const interrupted = new Promise<never>((_, reject) => lifetime.signal.addEventListener("abort", () => reject(stale), { once: true }));
        const run = async () => work(op);
        let value: T;
        try { value = await Promise.race([run(), interrupted]); }
        catch (error) { if (error === stale || !current()) return stale; throw error; }
        if (!current()) return stale;
        const edit = pendingEdit;
        if (edit && !capture.commit(() => editor.workspace.edit({ ...edit, documentId: capture.document.id,
            expectedRevision: capture.document.revision, origin: "human", view: editor.view }).applied)) return stale;
        return Object.freeze({ status: "completed", value });
    } finally { cancel(); pendingEdit = undefined; guards.length = 0; capture.cancel(); }
}
