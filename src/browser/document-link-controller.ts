import { onAbort } from "./listen.ts";
import { emptyList } from "../core/empty-list.ts";
import { documentLinkMethod } from "../protocol/lsp-methods.ts";
import { languageReview } from "./language-review.ts";
import type { Observable } from "../core/observable.ts";
import { done, failed, refused, stale, type Outcome } from "../core/outcome.ts";
import type { DocumentId, DocumentSnapshot } from "../core/workspace.ts";
import type { LspDocumentLink } from "../protocol/lsp-features.ts";
import type { LspDocumentOwner } from "../protocol/lsp-client.ts";
import { documentRangeWatch } from "./document-range-watch.ts";
import { linkClient, type LspLinkClient } from "../protocol/lsp-language.ts";
import type { LspPrepare, LspWorkspace } from "../protocol/lsp-workspace.ts";
import { isStaleRequest } from "../protocol/wire.ts";
import type { CapturedViewRequest } from "./captured-view.ts";
import { retainDocuments } from "./retained-documents.ts";
import type { TextEditor } from "./text-editor.ts";

export type DocumentLinkChoice = Readonly<{
    from: number; to: number; tooltip: string; target: string | null; canResolve: boolean;
    open: (present: (uri: string) => void) => Promise<Outcome<string>>;
}>;
export type DocumentLinkSnapshot = Readonly<{
    status: "idle" | "pending" | "ready" | "resolving" | "expired" | "failed" | "disposed";
    links: readonly DocumentLinkChoice[]; message: string;
}>;
export type DocumentLinkControllerOptions = Readonly<{
    paint?: boolean;
    documents?: () => readonly DocumentSnapshot[]; canCapture?: (id: DocumentId) => boolean;
    prepareRequest?: () => LspPrepare | undefined;
}>;
export type DocumentLinkController = Observable<DocumentLinkSnapshot> & Readonly<{
    request: () => Promise<Outcome<readonly DocumentLinkChoice[]>>; cancel: () => void; dispose: () => void;
    setPaint: (enabled: boolean) => void;
    linkAt: (offset: number) => DocumentLinkChoice | undefined;
}>;
type Watched = { item: LspDocumentLink; isCurrent(): boolean };
type Job = {
    watched?: Watched | undefined;
    client: LspLinkClient; project: ReturnType<typeof retainDocuments>; source?: CapturedViewRequest;
    reply?: Awaited<ReturnType<LspLinkClient["run"]>["result"]>; connection?: ReturnType<LspWorkspace["getSnapshot"]>;
    invalid: boolean; timer?: number; failure?: ReturnType<typeof failed>;
};
const idle: DocumentLinkSnapshot = Object.freeze({ status: "idle", links: emptyList, message: "" });

const watchLinks = documentRangeWatch<LspDocumentLink>(documentLinkMethod, linkClient,
    ({ from, to }) => ({ from, to, className: "st-document-link" }), { order: 30 });

/** Discover links for one editor. Only a current user action hands an opaque target to the host. */
export function mountDocumentLinks(editor: TextEditor, owner: LspDocumentOwner, options: DocumentLinkControllerOptions): DocumentLinkController {
    const { provider } = owner;
    const { workspace, view } = editor, win = editor.element.ownerDocument.defaultView!;
    const { scope, state, signal, active, available, capture, release, expire, mount } =
        languageReview<Job, DocumentLinkSnapshot>(editor, "Document link", idle, options.canCapture,
            status => publish(status));
    function publish(status: DocumentLinkSnapshot["status"], links: readonly DocumentLinkChoice[] = emptyList, message = "") {
        scope.publish(state, Object.freeze({ status, links, message }));
    }
    function captureCurrent(j: Job) {
        return active.job === j && !j.invalid && workspace.ownsDocumentView(view) && available(view.documentId)
            && (!j.watched || j.watched.isCurrent()) && (!j.source || j.source.isCurrent())
            && j.project.allows(options);
    }
    function current(j: Job) { return captureCurrent(j) && (!j.reply || j.reply.isCurrent()); }
    function providerChanged(j: Job) {
        const connection = provider.getSnapshot();
        return j.connection && (connection.phase !== "ready" || connection.epoch !== j.connection.epoch
            || connection.registrationVersion(documentLinkMethod) !== j.connection.registrationVersion(documentLinkMethod));
    }
    function fail(j: Job | undefined, error: unknown): Outcome<never> {
        if (j?.failure) return j.failure;
        if (j) {
            try {
                if (isStaleRequest(error) || !captureCurrent(j) || providerChanged(j)) {
                    expire(j);
                    return stale;
                }
            } catch (captureError) { error = captureError; }
        }
        const failure = failed(error);
        if (j) {
            j.failure = failure;
            release();
        }
        publish("failed", emptyList, error instanceof Error ? error.message : "Document link request failed.");
        return failure;
    }
    function bindCapture(j: Job, source: NonNullable<Job["source"]>) {
        j.source = source;
        onAbort(source.signal, () => { if (j.source === source) expire(j); });
        j.timer = win.setTimeout(() => fail(j, new Error("Document link request timed out.")), 30000);
    }
    function finishCapture(j: Job) {
        win.clearTimeout(j.timer);
        const source = j.source; delete j.source; source?.cancel();
    }
    function start(watched?: Watched) {
        release();
        const source = capture();
        if (!source) {
            publish("expired");
            return refused("unavailable-view");
        }
        let pending: Job | undefined;
        try {
            const client = linkClient(owner, watched);
            const j: Job = { client, watched, invalid: false,
                project: retainDocuments(workspace, available, () => expire(j)) };
            pending = active.job = j;
            bindCapture(j, source);
            j.project.capture(source.document, options.documents?.());
            return j;
        } catch (error) {
            if (!pending) source.cancel();
            return fail(pending, error);
        }
    }
    function choice(item: LspDocumentLink, index: number, watched?: Watched): DocumentLinkChoice {
        const result: DocumentLinkChoice = Object.freeze({ from: item.from, to: item.to, target: item.target,
            tooltip: item.tooltip, canResolve: item.target === null && !!item.resolve,
            open: present => open(result, index, present, watched) });
        return result;
    }
    async function open(selected: DocumentLinkChoice, index: number, present: (uri: string) => void,
        watched?: Watched): Promise<Outcome<string>> {
        scope.assertWritable();
        const beforeJob = active.job;
        let j: Job | undefined;
        const before = state.get();
        let target = selected.target;
        try {
            if (watched) {
                if (!watched.isCurrent()) return stale;
                if (beforeJob?.watched === watched && before.status === "resolving") return refused("resolving");
                const job = start(watched);
                if ("status" in job) return job;
                j = job;
                j.connection = provider.getSnapshot();
            } else {
                j = beforeJob;
                if (!j?.reply || before.links[index] !== selected) return stale;
                if (before.status === "resolving") return refused("resolving");
            }
            if (!current(j)) { expire(j); return stale; }
            if (target === null && selected.canResolve) {
                const source = j.source ?? capture();
                if (!source) return refused("unavailable-view");
                if (!j.source) bindCapture(j, source);
                publish("resolving", watched ? emptyList : before.links);
                const resolved = watched ? (await j.client.run({ document: source.document }).result).items[0]!
                    : await j.reply!.resolve(j.reply!.items[index]!);
                if (!current(j)) { expire(j); return stale; }
                finishCapture(j);
                if (!watched) {
                    const links = before.links.slice();
                    links[index] = choice(resolved, index);
                    publish("ready", Object.freeze(links));
                    if (!current(j)) return stale;
                }
                target = resolved.target;
            }
            if (watched) {
                release();
                publish("idle");
            }
        } catch (error) { return fail(j, error); }
        if (target === null) return refused("no-target");
        try { present(target); } catch (error) { return failed(error); }
        return done(target);
    }
    async function request(): Promise<Outcome<readonly DocumentLinkChoice[]>> {
        scope.assertWritable();
        if (signal.aborted) return stale;
        let pending: Job | undefined;
        try {
            const j = start();
            if ("status" in j) return j;
            pending = j;
            publish("pending");
            j.reply = await j.client.run({ document: j.source!.document, prepare: options.prepareRequest?.() }).result;
            if (!current(j)) { expire(j); return stale; }
            j.connection = provider.getSnapshot();
            finishCapture(j);
            const links = Object.freeze(j.reply.items.map((item, index) => choice(item, index)));
            publish("ready", links);
            return done(links);
        } catch (error) {
            return fail(pending, error);
        }
    }
    const stop = provider.subscribe(() => {
        const j = active.job;
        // A malformed resolve reply invalidates the protocol result before its rejection reaches open().
        if (!j) return;
        if (j.watched ? providerChanged(j) : j.reply && !j.reply.isCurrent() && (!j.source || providerChanged(j))) expire(j);
    });
    let paint: ReturnType<typeof watchLinks> | undefined;
    let choices = new WeakMap<LspDocumentLink, DocumentLinkChoice>();
    const controls = mount(() => {
        stop();
        paint?.dispose();
        paint = undefined;
    });
    function setPaint(enabled: boolean) {
        scope.assertWritable();
        if (signal.aborted || enabled === !!paint) return;
        if (enabled) paint = watchLinks(editor, owner);
        else {
            if (active.job?.watched) expire(active.job);
            paint?.dispose();
            paint = undefined;
            choices = new WeakMap();
        }
    }
    try { setPaint(!!options.paint); } catch (error) { controls.dispose(); throw error; }
    function linkAt(offset: number) {
        if (!Number.isSafeInteger(offset)) return;
        const snapshot = state.get();
        if (active.job?.reply && snapshot.status === "ready" && current(active.job)) {
            const choice = snapshot.links.find(link => link.from <= offset && offset < link.to);
            if (choice) return choice;
        }
        const mounted = paint;
        const item = mounted?.at(offset);
        if (mounted && item) {
            let found = choices.get(item);
            if (!found) {
                found = choice(item, 0, { item, isCurrent: () => paint === mounted && mounted.at(offset) === item });
                choices.set(item, found);
            }
            return found;
        }
    }
    return Object.freeze({ ...controls, request, linkAt, setPaint });
}
