import { Store } from "../core/observable.ts";
import { ownsTextSurface } from "../core/workspace.ts";
import type { DocumentSnapshot } from "../core/workspace.ts";
import { createLspNavigationClient } from "../protocol/lsp-navigation.ts";
import type { LspPrepare, LspWorkspace } from "../protocol/lsp-workspace.ts";
import { captureViewRequest } from "./captured-view.ts";
import { bindDefinitionPointer } from "./definition-pointer.ts";
import type { DefinitionHit } from "./definition-pointer.ts";
import type { TextEditor } from "./text-editor.ts";

type Client = ReturnType<typeof createLspNavigationClient>;
type Preview = Awaited<ReturnType<Client["prepareDefinition"]>>;
export type NavigationResult = Awaited<ReturnType<Client["run"]>>;
type Kind = "definition" | "references";
export type NavigationControllerOptions = Readonly<{
    documents?: () => readonly DocumentSnapshot[]; canCapture?: () => boolean;
    prepareRequest?: (kind: Kind) => LspPrepare | undefined;
    /** Handle a modifier click through the host's usual definition command. Call request synchronously to reuse its lookup. */
    onDefinition?: (offset: number) => void;
}>;
export type NavigationSnapshot = Readonly<{ status: "idle" | "pending" | "ready" | "empty" | "failed" | "disposed"; result: NavigationResult | null }>;
const idle: NavigationSnapshot = Object.freeze({ status: "idle", result: null });

/** A passive definition lookup can paint a link. Only an explicit request resolves its target URIs. */
export function createNavigationController(editor: TextEditor, provider: LspWorkspace, options: NavigationControllerOptions = {}) {
    const { workspace, view, tab } = editor;
    if (editor.signal.aborted || !ownsTextSurface(workspace, view, tab)) throw new Error("Navigation requires a live document view.");
    const notifications = workspace.createNotificationScope(), state = new Store(idle, notifications);
    const layer = editor.decorations.add({ name: "definition link", order: 110, minimap: false });
    const events = new AbortController(), subscribers = new Set<() => void>();
    const available = () => {
        const activity = editor.activity();
        return !events.signal.aborted && editor.element.isConnected && !editor.input.disabled && !activity.composing
            && !activity.pendingCommand && !activity.pendingInput && (options.canCapture?.() ?? true);
    };
    const capture = () => captureViewRequest(workspace, tab, view, { available });
    type Source = NonNullable<ReturnType<typeof capture>>;
    type Hover = { hit: DefinitionHit; client: Client; source: Source; reply: Promise<Preview>; result?: Preview };
    let hover: Hover | undefined, activation: Hover | undefined, explicit: Client | undefined, origin: Source | undefined;
    const publish = (status: NavigationSnapshot["status"], result: NavigationResult | null = null) => notifications.publish(state, Object.freeze({ status, result }));
    const release = (job?: Hover) => { job?.source.cancel(); job?.client.dispose(); };
    const leave = () => { if (hover) { const old = hover; hover = undefined; layer.clear(); release(old); } };
    const clearExplicit = () => { const client = explicit, source = origin; explicit = undefined; origin = undefined; source?.cancel(); client?.dispose(); };
    const cancel = () => { if (!events.signal.aborted) { notifications.assertWritable(); leave(); clearExplicit(); publish("idle"); } };
    const project = (source: Source) => options.documents?.() ?? [source.document];
    const inside = (offset: number, range: Readonly<{ from: number; to: number }>) => offset >= range.from && offset < range.to;
    const matches = (job: Hover | undefined, hit: DefinitionHit) => job && job.hit.revision === hit.revision && job.source.isCurrent()
        && inside(hit.offset, job.result?.originRange ?? job.hit) && (!job.result || job.result.isCurrent());
    function inspect(hit: DefinitionHit) {
        if (matches(hover, hit)) return;
        leave(); const source = capture(); if (!source || source.document.revision !== hit.revision) { source?.cancel(); return; }
        const client = createLspNavigationClient(provider);
        try {
            const reply = client.prepareDefinition(project(source), source.document.id, hit.offset, options.prepareRequest?.("definition"));
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
        leave(); clearExplicit();
        const source = prepared?.source ?? capture();
        if (!source || !source.isCurrent()) { release(prepared); throw new Error("Navigation source is unavailable."); }
        const client = prepared?.client ?? createLspNavigationClient(provider); explicit = client; origin = source;
        const abort = () => { if (origin === source) { clearExplicit(); publish("idle"); } };
        source.signal.addEventListener("abort", abort, { once: true });
        try {
            publish("pending");
            let result: NavigationResult;
            if (prepared) {
                const reply = await prepared.reply;
                if (!source.isCurrent() || !reply.isCurrent()) throw new Error("Definition link expired.");
                result = reply.originRange && !inside(offset, reply.originRange) && offset !== prepared.hit.offset
                    ? await client.run(project(source), source.document.id, offset, kind, includeDeclaration, options.prepareRequest?.(kind))
                    : await reply.resolve();
            } else result = await client.run(project(source), source.document.id, offset, kind, includeDeclaration, options.prepareRequest?.(kind));
            if (explicit !== client || !source.isCurrent() || !result.isCurrent()) throw new Error("Navigation source changed.");
            origin = undefined; source.cancel(); publish(result.locations.length ? "ready" : "empty", result); return result;
        } catch (error) {
            if (explicit === client) { clearExplicit(); publish("failed"); } throw error;
        } finally { source.signal.removeEventListener("abort", abort); }
    }
    bindDefinitionPointer(editor, inspect, leave, hit => {
        if (!matches(hover, hit)) inspect(hit);
        if (!hover) return;
        activation = hover; hover = undefined; layer.clear();
        try {
            if (options.onDefinition) options.onDefinition(hit.offset);
            else void request("definition", hit.offset).catch(() => {});
        } finally { const unused = activation; activation = undefined; release(unused); }
    }, events.signal);
    editor.input.addEventListener("compositionstart", cancel, { signal: events.signal });
    const stop = provider.subscribe(() => {
        const job = hover, result = state.get().result;
        if (job?.result && !job.result.isCurrent()) queueMicrotask(() => { if (hover === job) leave(); });
        if (result && !result.isCurrent()) queueMicrotask(() => { if (state.get().result === result) { clearExplicit(); publish("idle"); } });
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
    }, getDiagnostics: () => explicit?.snapshot() ?? null });
}
export type NavigationController = ReturnType<typeof createNavigationController>;
