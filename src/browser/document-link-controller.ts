import { Store } from "../core/observable.ts";
import type { Observable } from "../core/observable.ts";
import type { DocumentId, DocumentSnapshot } from "../core/workspace.ts";
import type { LspDocumentLink } from "../protocol/lsp-features.ts";
import { createLspLinkClient, type LspLinkClient } from "../protocol/lsp-language.ts";
import type { LspPrepare, LspWorkspace } from "../protocol/lsp-workspace.ts";
import { captureViewRequest } from "./captured-view.ts";
import type { CapturedViewRequest } from "./captured-view.ts";
import { retainDocuments } from "./retained-documents.ts";
import type { TextEditor } from "./text-editor.ts";

export type DocumentLinkOpenResult = Readonly<
    { status: "presented" | "expired" | "no-target" | "resolving" }
    | { status: "failed"; message: string }
>;
export type DocumentLinkChoice = Readonly<{
    from: number; to: number; tooltip: string; target: string | null; canResolve: boolean;
    open: (present: (uri: string) => void) => Promise<DocumentLinkOpenResult>;
}>;
export type DocumentLinkSnapshot = Readonly<{
    status: "idle" | "pending" | "ready" | "resolving" | "expired" | "failed" | "disposed";
    links: readonly DocumentLinkChoice[]; message: string;
}>;
export type DocumentLinkControllerOptions = Readonly<{
    documents?: () => readonly DocumentSnapshot[]; canCapture?: (id: DocumentId) => boolean;
    prepareRequest?: () => LspPrepare | undefined;
}>;
export type DocumentLinkController = Observable<DocumentLinkSnapshot> & Readonly<{
    request: () => Promise<void>; cancel: () => void; dispose: () => void;
    linkAt: (offset: number) => DocumentLinkChoice | undefined;
}>;
type Job = {
    client: LspLinkClient; project: ReturnType<typeof retainDocuments>; capture?: CapturedViewRequest<TextEditor["tab"]>;
    reply?: Awaited<ReturnType<LspLinkClient["run"]>["result"]>; connection?: ReturnType<LspWorkspace["getSnapshot"]>;
    invalid: boolean; timer?: number; failure?: string;
};
const empty: readonly DocumentLinkChoice[] = Object.freeze([]);
const expired = Object.freeze({ status: "expired" } as const);
const noTarget = Object.freeze({ status: "no-target" } as const);
const idle: DocumentLinkSnapshot = Object.freeze({ status: "idle", links: empty, message: "" });

/** Discover links for one editor. Only a current user action hands an opaque target to the host. */
export function createDocumentLinkController(editor: TextEditor, provider: LspWorkspace, options: DocumentLinkControllerOptions = {}): DocumentLinkController {
    const { workspace, view, tab } = editor, win = editor.element.ownerDocument.defaultView!;
    if (editor.signal.aborted || !workspace.ownsDocumentView(view, tab)) throw new Error("Document links require a live document view.");
    const scope = workspace.createNotificationScope(), state = new Store(idle, scope), events = new AbortController(), observers = new Set<() => void>();
    let job: Job | undefined;
    const available = (id: DocumentId) => {
        const activity = editor.activity();
        return !events.signal.aborted && editor.element.isConnected && !editor.getSnapshot().disabled && !activity.composing
            && !activity.pendingInput && !activity.pendingCommand && (options.canCapture?.(id) ?? true);
    };
    const capture = () => captureViewRequest(workspace, tab, view, { available: () => available(view.documentId) });
    function publish(status: DocumentLinkSnapshot["status"], links = empty, message = "") {
        scope.publish(state, Object.freeze({ status, links, message }));
    }
    function release() {
        const previous = job; job = undefined;
        if (previous) { win.clearTimeout(previous.timer); previous.capture?.cancel(); previous.project.dispose(); previous.client.dispose(); }
    }
    function expire(j: Job) {
        if (job !== j || j.invalid) return;
        j.invalid = true;
        queueMicrotask(() => { if (job === j) { release(); publish("expired"); } });
    }
    function captureCurrent(j: Job) {
        if (job !== j || j.invalid || !workspace.ownsDocumentView(view, tab) || !available(view.documentId)
            || j.capture && !j.capture.isCurrent()) return false;
        if (options.canCapture) for (const id of j.project.documents.keys()) if (!options.canCapture(id)) return false;
        return true;
    }
    function current(j: Job) { return captureCurrent(j) && (!j.reply || j.reply.isCurrent()); }
    function providerChanged(j: Job) {
        const connection = provider.getSnapshot();
        return j.connection && (connection.phase !== "ready" || connection.epoch !== j.connection.epoch
            || connection.registrationGeneration !== j.connection.registrationGeneration);
    }
    function fail(j: Job, error: unknown) {
        if (job !== j) return;
        if (!captureCurrent(j) || providerChanged(j)) { expire(j); return; }
        j.failure = error instanceof Error ? error.message : "Document link request failed.";
        release(); publish("failed", empty, j.failure);
    }
    function bindCapture(j: Job, source: NonNullable<Job["capture"]>) {
        j.capture = source;
        source.signal.addEventListener("abort", () => { if (j.capture === source) expire(j); }, { once: true });
        j.timer = win.setTimeout(() => fail(j, new Error("Document link request timed out.")), 30000);
    }
    function finishCapture(j: Job) {
        win.clearTimeout(j.timer);
        const source = j.capture; delete j.capture; source?.cancel();
    }
    function choice(item: LspDocumentLink, index: number): DocumentLinkChoice {
        // A retained row only knows its identity and slot. It cannot open a later row at that slot.
        const result: DocumentLinkChoice = Object.freeze({ from: item.from, to: item.to, target: item.target,
            tooltip: item.tooltip, canResolve: item.target === null && !!item.resolve,
            open: present => open(result, index, present) });
        return result;
    }
    async function open(selected: DocumentLinkChoice, index: number, present: (uri: string) => void): Promise<DocumentLinkOpenResult> {
        scope.assertWritable();
        const j = job, before = state.get();
        if (!j?.reply || before.links[index] !== selected) return expired;
        if (!current(j)) { expire(j); return expired; }
        if (before.status === "resolving") return Object.freeze({ status: "resolving" });
        let target = selected.target;
        if (target === null) {
            if (!selected.canResolve) return noTarget;
            const source = capture();
            if (!source) return expired;
            bindCapture(j, source); publish("resolving", before.links);
            try {
                const resolved = await j.reply.resolve(j.reply.items[index]!);
                if (!current(j)) { expire(j); return expired; }
                finishCapture(j);
                const links = before.links.slice(); links[index] = choice(resolved, index);
                publish("ready", Object.freeze(links)); target = resolved.target;
            } catch (error) {
                fail(j, error);
                return j.failure === undefined ? expired : Object.freeze({ status: "failed", message: j.failure });
            }
        }
        if (!current(j)) return expired;
        if (target === null) return noTarget;
        present(target);
        return Object.freeze({ status: "presented" });
    }
    async function request() {
        scope.assertWritable();
        if (events.signal.aborted) return;
        release();
        const source = capture();
        if (!source) { publish("expired"); return; }
        let client: LspLinkClient;
        try { client = createLspLinkClient(provider); }
        catch (error) { source.cancel(); publish("failed", empty, String(error)); return; }
        const j: Job = { client, project: retainDocuments(workspace, available, () => expire(j)), invalid: false }; job = j;
        try {
            bindCapture(j, source); j.project.include(source.document);
            for (const doc of options.documents?.() ?? []) j.project.include(doc);
            publish("pending");
            j.reply = await client.run({ document: source.document, prepare: options.prepareRequest?.() }).result;
            if (!current(j)) { expire(j); return; }
            j.connection = provider.getSnapshot();
            finishCapture(j); publish("ready", Object.freeze(j.reply.items.map(choice)));
        } catch (error) { fail(j, error); }
    }
    function cancel() { scope.assertWritable(); if (!events.signal.aborted) { release(); publish("idle"); } }
    const stop = provider.subscribe(() => {
        const j = job;
        // A malformed resolve reply invalidates the protocol result before its rejection reaches open().
        if (j?.reply && !j.reply.isCurrent() && (!j.capture || providerChanged(j))) expire(j);
    });
    editor.onEditIntent(() => { if (job) cancel(); }, events.signal);
    function dispose() {
        if (events.signal.aborted) return;
        scope.assertWritable(); events.abort(); stop(); release(); editor.signal.removeEventListener("abort", dispose);
        publish("disposed"); for (const unsubscribe of observers) unsubscribe();
    }
    editor.signal.addEventListener("abort", dispose, { once: true });
    function linkAt(offset: number) {
        const snapshot = state.get();
        if (!Number.isSafeInteger(offset) || !job || snapshot.status !== "ready" || !current(job)) return;
        return snapshot.links.find(link => link.from <= offset && offset < link.to);
    }
    return Object.freeze({ request, cancel, dispose, linkAt, getSnapshot: state.observable.getSnapshot, subscribe(listener: () => void) {
        if (events.signal.aborted) throw new Error("Document link controller is disposed.");
        const off = state.observable.subscribe(listener), unsubscribe = () => { off(); observers.delete(unsubscribe); };
        observers.add(unsubscribe); return unsubscribe;
    } });
}
