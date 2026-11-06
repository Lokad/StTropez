import { mountEditingCandidate, mountTextEditor } from "../../src/browser/index.ts";
import type { MountedEditor, ViewportSnapshot, ViewState } from "../../src/browser/index.ts";
import type { DocumentId, DocumentView } from "../../src/index.ts";
import type { HostController } from "./controller.ts";

export type HostEditor = "native" | "candidate";
type BoundEditor = MountedEditor & Readonly<{ metrics: () => null | Readonly<{
    inputUnits: number; commits: number; composing: boolean; lastInputMs: number;
    viewport: ViewportSnapshot;
}> }>;
export function hostEditor(): HostEditor { return new URLSearchParams(location.search).get("editor") === "candidate" ? "candidate" : "native"; }

/** Stable refs own editor descendants; the controller and resource IDs survive every detach. */
export class ViewBindings {
    private readonly controller: HostController;
    private readonly mounted = new Map<string, { editor: BoundEditor; documentId: DocumentId }>();
    readonly editor: HostEditor;
    private readonly states = new Map<string, Map<DocumentId, ViewState>>();
    private readonly selections = new Map<string, Map<DocumentId, DocumentView>>();
    private mounts = 0;
    private destroys = 0;
    readonly primary: (host: HTMLDivElement | null) => void;
    readonly secondary: (host: HTMLDivElement | null) => void;
    constructor(controller: HostController, editor: HostEditor = "native") {
        this.controller = controller; this.editor = editor;
        this.primary = this.ref("primary", "Primary source");
        this.secondary = this.ref("secondary", "Secondary source");
    }
    private ref(id: "primary" | "secondary", ariaLabel: string): (host: HTMLDivElement | null) => void {
        return host => {
            this.detach(id);
            if (host === null) return;
            const workspace = this.controller.workspace, tabId = this.controller.viewTab(id);
            const tab = workspace.resolveTab(workspace.captureTab(tabId));
            if (tab?.surface.kind !== "text") throw new Error("Text view requires a text tab.");
            const documentId = tab.surface.documentId;
            const selections = this.selections.get(id) ?? new Map<DocumentId, DocumentView>();
            let view = selections.get(documentId);
            if (!view) { view = workspace.createDocumentView(documentId); selections.set(documentId, view); this.selections.set(id, selections); }
            const candidate = this.editor === "candidate" ? mountEditingCandidate(host, workspace, tabId, { ariaLabel, view }) : undefined;
            const mounted: BoundEditor = candidate ? { element: candidate.input, view, captureView: candidate.captureView,
                restoreView: candidate.restoreView, destroy: candidate.destroy,
                metrics: () => ({ ...candidate.snapshot(), viewport: candidate.viewport.snapshot() }) }
                : { ...mountTextEditor(host, workspace, tabId, { ariaLabel, view }), metrics: () => null };
            const listeners = new AbortController();
            mounted.element.addEventListener("sttropez-conflict", event => this.controller.captureInputConflict(documentId, (event as CustomEvent<unknown>).detail), { signal: listeners.signal });
            const editor: BoundEditor = { ...mounted, destroy: () => { try { mounted.destroy(); } finally { listeners.abort(); } } };
            const state = this.states.get(id)?.get(documentId); if (state) editor.restoreView({ ...state, ...view.getSnapshot().selection });
            this.mounted.set(id, { editor, documentId }); this.mounts++;
        };
    }
    private detach(id: string): void {
        const mounted = this.mounted.get(id); if (!mounted) return;
        const states = this.states.get(id) ?? new Map<DocumentId, ViewState>();
        states.set(mounted.documentId, mounted.editor.captureView()); this.states.set(id, states);
        mounted.editor.destroy(); this.mounted.delete(id); this.destroys++;
    }
    unmount(): void { for (const id of [...this.mounted.keys()]) this.detach(id); }
    dispose(): void {
        this.unmount(); for (const selections of this.selections.values()) for (const view of selections.values()) view.dispose();
        this.selections.clear(); this.states.clear();
    }
    debug() { return { editor: this.editor, mounts: this.mounts, destroys: this.destroys, activeViews: this.mounted.size,
        views: [...this.mounted].map(([id, { editor, documentId }]) => ({ id, documentId, viewId: editor.view.id,
            selection: editor.view.getSnapshot().selection, focused: editor.element.ownerDocument.activeElement === editor.element, metrics: editor.metrics() })) }; }
}
