import { Store } from "../core/observable.ts";
import type { Observable } from "../core/observable.ts";
import type { DocumentSnapshot } from "../core/workspace.ts";
import { createLspNavigationClient, type LspNavigationClient, type LspNavigationResult, type LspDefinitionPreview } from "../protocol/lsp-navigation.ts";
import type { LspLocation } from "../protocol/lsp-features.ts";
import type { LspPrepare, LspWorkspace } from "../protocol/lsp-workspace.ts";
import { captureViewRequest, sameEditAuthority } from "./captured-view.ts";
import { bindDefinitionPointer } from "./definition-pointer.ts";
import type { DefinitionHit } from "./definition-pointer.ts";
import type { TextEditor } from "./text-editor.ts";

export type NavigationDestination = Omit<LspLocation, "target"> & Readonly<{ document: LspLocation["target"]["document"] }>;
export type NavigationChoice = NavigationDestination & Readonly<{ index: number; open: (present: (destination: NavigationDestination) => void) => boolean }>;
export type NavigationPage = Readonly<{
    count: number; first: number; locations: readonly NavigationChoice[]; selected: NavigationChoice;
    previousPage: (() => NavigationPage) | null; nextPage: (() => NavigationPage) | null;
    moveSelection: (direction: -1 | 1) => NavigationPage;
}>;
export type NavigationResult = Readonly<{ count: number; locationAt: (index: number) => NavigationChoice | undefined;
    pageFor: (index?: number) => NavigationPage | undefined }>;
type Kind = "definition" | "references";
export type NavigationPointerLink = Readonly<{ from: number; to: number; open: () => void }>;
export type NavigationControllerOptions = Readonly<{
    documents?: () => readonly DocumentSnapshot[]; canCapture?: () => boolean;
    /** A view-bound chooser expires when its source caret or folded projection changes. */
    resultLifetime?: "document" | "view";
    prepareRequest?: (kind: Kind) => LspPrepare | undefined;
    /** Handle a modifier click through the host's usual definition command. Call request synchronously to reuse its lookup. */
    onDefinition?: (offset: number) => void;
    /** A document link at this UTF-16 offset takes precedence over a symbol under the pointer. */
    linkAt?: (offset: number) => NavigationPointerLink | undefined;
}>;
export type NavigationSnapshot = Readonly<{ status: "idle" | "pending" | "ready" | "empty" | "expired" | "failed" | "disposed"; result: NavigationResult | null }>;
export type NavigationController = Observable<NavigationSnapshot> & Readonly<{
    request: (kind?: Kind, offset?: number, includeDeclaration?: boolean) => Promise<NavigationResult>;
    cancel: () => void; dispose: () => void; getDiagnostics: () => ReturnType<LspNavigationClient["snapshot"]> | null;
}>;
const idle: NavigationSnapshot = Object.freeze({ status: "idle", result: null });

const navigationPageSize = 64;
function navigationResult(reply: LspNavigationResult, canOpen: () => boolean): NavigationResult {
    const count = reply.locations.length;
    function locationAt(index: number): NavigationChoice | undefined {
        if (!Number.isSafeInteger(index)) return;
        const location = reply.locations[index];
        if (!location) return;
        const { target, from, to, originRange, targetRange } = location;
        const destination = Object.freeze({ document: target.document, from, to, originRange, targetRange });
        return Object.freeze({ ...destination, index, open(present: (at: NavigationDestination) => void) {
            if (!canOpen()) return false;
            present(destination); return true;
        } });
    }
    function buildPage(index: number, preferredRow = index % navigationPageSize): NavigationPage {
        const first = index - index % navigationPageSize, end = Math.min(first + navigationPageSize, count);
        const locations = Object.freeze(Array.from({ length: end - first }, (_, row) => locationAt(first + row)!));
        function select(at: number, row: number): NavigationPage {
            return Object.freeze({ count, first, locations, selected: locations[at - first]!,
                previousPage: first > 0 ? () => buildPage(first - navigationPageSize + row, row) : null,
                nextPage: end < count ? () => buildPage(Math.min(end + row, count - 1), row) : null,
                moveSelection(direction: -1 | 1) {
                    if (direction !== -1 && direction !== 1) throw new RangeError("Expected a navigation direction of -1 or 1.");
                    const next = (at + direction + count) % count;
                    return next >= first && next < end ? select(next, next - first) : buildPage(next);
                } });
        }
        return select(index, preferredRow);
    }
    return Object.freeze({ count, locationAt, pageFor: (index = 0) =>
        Number.isSafeInteger(index) && index >= 0 && index < count ? buildPage(index) : undefined });
}

/** A passive definition lookup can paint a link. Only an explicit request resolves its target URIs. */
export function createNavigationController(editor: TextEditor, provider: LspWorkspace, options: NavigationControllerOptions = {}): NavigationController {
    const { workspace, view, tab } = editor;
    if (editor.signal.aborted || !workspace.ownsDocumentView(view, tab)) throw new Error("Navigation requires a live document view.");
    const notifications = workspace.createNotificationScope(), state = new Store(idle, notifications);
    const layer = editor.decorations.add({ name: "definition link", order: 110, minimap: false });
    const events = new AbortController(), subscribers = new Set<() => void>();
    const available = () => {
        const activity = editor.activity();
        return !events.signal.aborted && editor.element.isConnected && !editor.getSnapshot().disabled && !activity.composing
            && !activity.pendingCommand && !activity.pendingInput && (options.canCapture?.() ?? true);
    };
    const capture = () => captureViewRequest(workspace, tab, view, { available });
    type Source = NonNullable<ReturnType<typeof capture>>;
    type Hover = { hit: DefinitionHit; client: LspNavigationClient; source: Source; reply: Promise<LspDefinitionPreview>; result?: LspDefinitionPreview };
    type Request = { client: LspNavigationClient; source?: Source; stops: (() => void)[]; expired: boolean; reply?: LspNavigationResult };
    let hover: Hover | undefined, activation: Hover | undefined, explicit: Request | undefined;
    let markedLink: { hit: DefinitionHit; source: Source } | undefined;
    const publish = (status: NavigationSnapshot["status"], result: NavigationResult | null = null) => notifications.publish(state, Object.freeze({ status, result }));
    const release = (job?: Hover, reuse?: LspNavigationClient) => { job?.source.cancel(); if (job && job.client !== reuse) job.client.dispose(); };
    const leave = (reuse?: LspNavigationClient) => {
        if (!hover && !markedLink) return;
        const old = hover, link = markedLink;
        hover = undefined; markedLink = undefined;
        layer.clear(); release(old, reuse); link?.source.cancel();
    };
    const clearExplicit = (reuse?: LspNavigationClient) => {
        const job = explicit; explicit = undefined;
        if (!job) return;
        for (const stop of job.stops.splice(0)) stop();
        job.source?.cancel(); delete job.source; delete job.reply; if (job.client !== reuse) job.client.dispose();
    };
    const expire = (job: Request) => {
        if (explicit !== job || job.expired) return;
        job.expired = true;
        // A document observer cannot release the request's resource leases during delivery.
        queueMicrotask(() => { if (explicit === job) { clearExplicit(); publish("expired"); } });
    };
    const cancel = () => { if (!events.signal.aborted) { notifications.assertWritable(); leave(); clearExplicit(); publish("idle"); } };
    const project = (source: Source) => options.documents?.() ?? [source.document];
    const inside = (offset: number, range: Readonly<{ from: number; to: number }>) => offset >= range.from && offset < range.to;
    const matches = (job: Hover | undefined, hit: DefinitionHit) => job && job.hit.revision === hit.revision && job.source.isCurrent()
        && inside(hit.offset, job.result?.originRange ?? job.hit) && (!job.result || job.result.isCurrent());
    function inspect(hit: DefinitionHit) {
        if (hit.open) {
            if (markedLink?.hit.revision === hit.revision && markedLink.hit.from === hit.from && markedLink.hit.to === hit.to
                && markedLink.source.isCurrent()) return;
            leave();
            const source = capture(); if (!source) return;
            markedLink = { hit, source };
            source.signal.addEventListener("abort", () => { if (markedLink?.source === source) leave(); }, { once: true });
            layer.set(hit.revision, [{ from: hit.from, to: hit.to, className: "st-definition-link" }]);
            return;
        }
        if (matches(hover, hit)) return;
        const source = capture(); if (!source || source.document.revision !== hit.revision) { leave(); source?.cancel(); return; }
        const client = hover?.client ?? createLspNavigationClient(provider);
        leave(client);
        try {
            const reply = client.prepareDefinition({ document: source.document, project: project(source), offset: hit.offset, prepare: options.prepareRequest?.("definition") }).result;
            const job: Hover = { hit, client, source, reply }; hover = job;
            source.signal.addEventListener("abort", () => { if (hover === job) leave(); }, { once: true });
            void reply.then(result => {
                if (hover !== job || !source.isCurrent() || !result.isCurrent()) return;
                job.result = result;
                if (!result.hasTargets) return;
                const { from, to } = result.originRange ?? hit;
                if (from < to) layer.set(hit.revision, [{ from, to, className: "st-definition-link" }]);
            }).catch(() => { if (hover === job) leave(); });
        } catch { source.cancel(); client.dispose(); }
    }
    async function request(kind: Kind = "definition", offset = view.getSnapshot().selection.head, includeDeclaration = true): Promise<NavigationResult> {
        if (events.signal.aborted) throw new Error("Navigation controller is disposed.");
        notifications.assertWritable();
        const prepared = kind === "definition" && activation && inside(offset, activation.result?.originRange ?? activation.hit) ? activation : undefined;
        if (prepared) activation = undefined;
        const source = prepared?.source ?? capture();
        if (!source || !source.isCurrent()) { leave(); clearExplicit(); release(prepared); publish("expired"); throw new Error("Navigation source is unavailable."); }
        const client = prepared?.client ?? explicit?.client ?? hover?.client ?? createLspNavigationClient(provider);
        leave(client); clearExplicit(client);
        const job: Request = { client, source, stops: [], expired: false }; explicit = job;
        const abort = () => { if (job.source) expire(job); };
        source.signal.addEventListener("abort", abort, { once: true });
        job.stops.push(() => source.signal.removeEventListener("abort", abort));
        try {
            const documents = project(source);
            if (tab) job.stops.push(workspace.tabs.subscribe(() => { if (!workspace.ownsDocumentView(view, tab)) expire(job); }));
            for (const doc of documents) {
                const handle = workspace.observeDocument(doc.id), metadata = workspace.resourceForDocument(doc.id).metadata;
                const permission = metadata.getSnapshot();
                const changed = () => {
                    const current = handle.getSnapshot(), access = metadata.getSnapshot();
                    if (current?.revision !== doc.revision || current.buffer !== doc.buffer || !sameEditAuthority(permission, access)) expire(job);
                };
                job.stops.push(handle.subscribe(changed), metadata.subscribe(changed)); changed();
            }
            if (job.expired) throw new Error("Navigation project changed.");
            publish("pending");
            const query = () => client.run({ document: source.document, project: documents, offset, kind, includeDeclaration,
                prepare: options.prepareRequest?.(kind) }).result;
            let reply: LspNavigationResult;
            if (prepared) {
                const preview = await prepared.reply;
                if (!source.isCurrent() || !preview.isCurrent()) { expire(job); throw new Error("Definition link expired."); }
                reply = preview.originRange && !inside(offset, preview.originRange) && offset !== prepared.hit.offset
                    ? await query()
                    : await preview.resolve();
            } else reply = await query();
            if (explicit !== job || job.expired || !source.isCurrent() || !reply.isCurrent()) {
                expire(job); throw new Error("Navigation source changed.");
            }
            if (options.resultLifetime !== "view") { delete job.source; source.cancel(); }
            job.reply = reply;
            const result = navigationResult(reply, () => {
                notifications.assertWritable();
                return explicit === job && !job.expired && available() && workspace.ownsDocumentView(view, tab)
                    && (!job.source || job.source.isCurrent()) && reply.isCurrent();
            });
            publish(result.count ? "ready" : "empty", result); return result;
        } catch (error) {
            if (explicit === job) { clearExplicit(); publish(job.expired ? "expired" : "failed"); } throw error;
        }
    }
    bindDefinitionPointer(editor, inspect, leave, hit => {
        if (hit.open) {
            const current = markedLink?.source.isCurrent(); leave();
            if (current) hit.open();
            return;
        }
        if (!matches(hover, hit)) inspect(hit);
        if (!hover) return;
        activation = hover; hover = undefined; layer.clear();
        try {
            if (options.onDefinition) options.onDefinition(hit.offset);
            else void request("definition", hit.offset).catch(() => {});
        } finally { const unused = activation; activation = undefined; release(unused); }
    }, events.signal, options.linkAt);
    editor.onEditIntent(kind => { if (kind === "compositionstart") cancel(); else if (markedLink) leave(); }, events.signal);
    const stop = provider.subscribe(() => {
        const job = hover, request = explicit;
        if (job?.result && !job.result.isCurrent()) queueMicrotask(() => { if (hover === job) leave(); });
        if (request?.reply && !request.reply.isCurrent()) expire(request);
    });
    function dispose() {
        if (events.signal.aborted) return;
        events.abort(); stop(); leave(); clearExplicit(); layer.dispose(); editor.signal.removeEventListener("abort", dispose);
        publish("disposed"); for (const unsubscribe of subscribers) unsubscribe();
    }
    editor.signal.addEventListener("abort", dispose, { once: true });
    return Object.freeze({ request, cancel, dispose, getSnapshot: state.observable.getSnapshot, subscribe(listener: () => void) {
        if (events.signal.aborted) throw new Error("Navigation controller is disposed.");
        const stop = state.observable.subscribe(listener), unsubscribe = () => { stop(); subscribers.delete(unsubscribe); };
        subscribers.add(unsubscribe); return unsubscribe;
    }, getDiagnostics: () => explicit?.client.snapshot() ?? null });
}
