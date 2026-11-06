import { createFindController } from "../../src/browser/index.ts";
import type { EditingCandidate, FindController, FindSnapshot } from "../../src/browser/index.ts";
import type { TabId, Workspace } from "../../src/index.ts";
import { createProviderController } from "../editing/provider-controller.ts";
import type { ProviderSnapshot } from "../editing/provider-controller.ts";
import { EditingPresentation } from "../editing/presentation.ts";
import { HostCell } from "../shared/observable.ts";

type Session = { id: string; editor: EditingCandidate; tab: TabId; presentation: EditingPresentation;
    provider: ReturnType<typeof createProviderController>; find?: FindController; stopFind?: () => void; initialized: boolean };
type LanguageSnapshot = Readonly<{ view: string | null; provider: ProviderSnapshot | null; find: FindSnapshot | null; query: string; replacement: string }>;

/** Host-owned tools follow an explicit mounted view; delayed commands never consult focus later. */
export class HostLanguageTools {
    private readonly workspace: Workspace;
    private readonly sessions = new Map<string, Session>();
    private active: Session | undefined;
    private readonly cell = new HostCell<LanguageSnapshot>({ view: null, provider: null, find: null, query: "", replacement: "" });
    readonly state = this.cell.observable;
    private queryElement: HTMLInputElement | null = null;
    private replacementElement: HTMLInputElement | null = null;
    readonly queryRef = (element: HTMLInputElement | null): void => { this.queryElement = element; };
    readonly replacementRef = (element: HTMLInputElement | null): void => { this.replacementElement = element; };
    private retired = { posted: 0, applied: 0, stale: 0, cancelled: 0, invalid: 0, failed: 0, postedUnits: 0 };
    constructor(workspace: Workspace) { this.workspace = workspace; }
    private publish(): void {
        this.cell.set({ ...this.cell.get(), view: this.active?.id ?? null, provider: this.active?.provider.state.getSnapshot() ?? null,
            find: this.active?.find?.state.getSnapshot() ?? null });
    }
    private activate(session: Session): void {
        if (this.active !== session) { this.active?.provider.cancel(); this.active?.find?.cancel(); this.active = session; }
        if (!session.initialized) { session.initialized = true; session.provider.connect(); }
        this.publish();
    }
    attach(id: string, tab: TabId, editor: EditingCandidate, presentation: EditingPresentation): () => void {
        if (this.sessions.has(id)) throw new Error("Language view already mounted.");
        const provider = createProviderController(this.workspace, tab, editor, { autoConnect: false });
        const session: Session = { id, tab, editor, presentation, provider, initialized: false }, listeners = new AbortController();
        this.sessions.set(id, session);
        const update = () => {
            const state = provider.state.getSnapshot(), previous = presentation.diagnostics;
            presentation.diagnostics = { revision: state.diagnosticRevision, ranges: state.diagnostics };
            if (previous?.revision !== state.diagnosticRevision || previous.ranges !== state.diagnostics) editor.viewport.invalidate();
            if (this.active === session) this.publish();
        };
        const unsubscribe = provider.state.subscribe(update);
        editor.input.addEventListener("focus", () => this.activate(session), { signal: listeners.signal });
        editor.input.addEventListener("keydown", event => {
            if (event.isComposing || editor.snapshot().composing || event.defaultPrevented) return;
            if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.code === "Space" || ["f", "h"].includes(event.key.toLowerCase()))) {
                event.preventDefault(); this.activate(session);
                if (event.code === "Space") provider.request();
                else { this.ensureFind(); const field = event.key.toLowerCase() === "h" ? this.replacementElement : this.queryElement; field?.focus(); field?.select(); }
            } else if (event.key === "F3") { event.preventDefault(); this.activate(session); this.ensureFind()?.next(event.shiftKey ? -1 : 1); }
            else if (event.altKey && event.key === "Enter" && provider.state.getSnapshot().offerText !== null) { event.preventDefault(); provider.apply("replace"); }
            else if (event.key === "Escape" && (provider.state.getSnapshot().pending || provider.state.getSnapshot().offerText !== null)) { event.preventDefault(); provider.cancel(); }
        }, { signal: listeners.signal });
        update(); let detached = false;
        return () => {
            if (detached) return; detached = true; unsubscribe(); listeners.abort(); session.stopFind?.(); session.find?.destroy();
            const counts = provider.snapshot(); for (const key of Object.keys(this.retired) as (keyof typeof this.retired)[]) this.retired[key] += counts[key];
            provider.destroy(); presentation.clear(); this.sessions.delete(id); if (this.active === session) this.active = undefined; this.publish();
        };
    }
    private ensureFind(): FindController | undefined {
        const session = this.active; if (!session) return;
        if (!session.find) {
            session.find = createFindController(this.workspace, session.tab, session.editor);
            const update = () => { const state = session.find!.state.getSnapshot(), previous = session.presentation.search;
                session.presentation.search = { revision: state.revision, ranges: state.preview };
                if (previous?.revision !== state.revision || previous.ranges !== state.preview) session.editor.viewport.invalidate();
                if (this.active === session) this.publish(); };
            session.stopFind = session.find.state.subscribe(update);
        }
        const state = session.find.state.getSnapshot(), query = this.cell.get().query;
        if (state.query !== query || state.status === "cancelled") session.find.setQuery(query);
        return session.find;
    }
    readonly request = (): void => { this.active?.provider.request(); };
    readonly insert = (): void => { this.active?.provider.apply("insert"); };
    readonly replace = (): void => { this.active?.provider.apply("replace"); };
    readonly cancel = (): void => { this.active?.provider.cancel(); };
    readonly disconnect = (): void => { this.active?.provider.disconnect(); };
    readonly reconnect = (): void => { if (this.active) { this.active.initialized = true; this.active.provider.connect(); } };
    readonly setQuery = (query: string): void => { this.cell.set({ ...this.cell.get(), query }); this.ensureFind(); };
    readonly setReplacement = (replacement: string): void => { this.cell.set({ ...this.cell.get(), replacement }); };
    readonly next = (): void => { this.ensureFind()?.next(); };
    readonly previous = (): void => { this.ensureFind()?.next(-1); };
    readonly replaceCurrent = (): void => { this.ensureFind()?.replaceCurrent(this.cell.get().replacement); };
    readonly replaceAll = (): void => { this.ensureFind()?.replaceAll(this.cell.get().replacement); };
    readonly cancelFind = (): void => { this.active?.find?.cancel(); this.active?.editor.focus(); };
    readonly focusEditor = (): void => { this.active?.editor.focus(); };
    selectDiagnostic(index: number): void { this.active?.provider.selectDiagnostic(index); }
    setDelay(value: number): void { this.active?.provider.setDelay(value); }
    faultNext(value: "malformed" | "failure"): void { this.active?.provider.faultNext(value); }
    debug() { return { active: this.active?.id ?? null, subscriptions: this.cell.count(), sessions: [...this.sessions.values()].map(s => ({ id: s.id, documentId: s.editor.view.documentId,
        viewId: s.editor.view.id, provider: s.provider.snapshot(), presentation: s.presentation.snapshot() })), retired: { ...this.retired } }; }
}
