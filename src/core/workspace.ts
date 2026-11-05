import { applyTextEdits } from "./changes.ts";
import type { TextEdit } from "./changes.ts";

export type DocumentId = string & { readonly documentId: unique symbol };
export type TabId = string & { readonly tabId: unique symbol };
export type PaneId = string;
export type ResourceKey = Readonly<{ scope: string; resource: string; variant: string }>;
export type DocumentSnapshot = Readonly<{
    id: DocumentId;
    key: ResourceKey;
    title: string;
    text: string;
    revision: number;
}>;
export type Surface = Readonly<
    { kind: "text"; documentId: DocumentId }
    | { kind: "panel"; documentId: DocumentId; panelType: string }
>;
export type TabSnapshot = Readonly<{
    id: TabId;
    paneId: PaneId;
    generation: number;
    surface: Surface;
}>;
export type WorkspaceSnapshot = Readonly<{
    revision: number;
    documents: readonly DocumentSnapshot[];
    tabs: readonly TabSnapshot[];
}>;
/** A tab guard survives moves, but expires on replacement or closure. */
export type TabTarget = Readonly<{ workspace: symbol; id: TabId; generation: number }>;
export type EditRequest = Readonly<{
    documentId: DocumentId;
    expectedRevision: number;
    edits: readonly TextEdit[];
    origin: "human" | "agent" | "host";
}>;
export type EditResult = Readonly<
    { applied: true; revision: number }
    | { applied: false; reason: "missing-document" | "stale-revision" }
>;

/** Headless workspace ownership. The host owns persistence, navigation and permissions. */
export class Workspace {
    private readonly lifetime = Symbol("workspace");
    private nextId = 0;
    private readonly listeners = new Set<() => void>();
    private snapshot: WorkspaceSnapshot = Object.freeze({
        revision: 0, documents: Object.freeze([]), tabs: Object.freeze([]),
    });

    /** Stable snapshots and subscriptions also fit useSyncExternalStore without a React dependency. */
    readonly getSnapshot = (): WorkspaceSnapshot => this.snapshot;
    readonly subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };

    createDocument(key: ResourceKey, title: string, text: string): DocumentId {
        if (this.snapshot.documents.some(d => d.key.scope === key.scope
            && d.key.resource === key.resource && d.key.variant === key.variant)) {
            throw new Error("Resource already has a document in this workspace.");
        }
        const id = `document-${++this.nextId}` as DocumentId;
        const document = Object.freeze({ id, key: Object.freeze({ ...key }), title, text, revision: 0 });
        this.publish([...this.snapshot.documents, document], this.snapshot.tabs);
        return id;
    }

    document(id: DocumentId): DocumentSnapshot {
        const document = this.snapshot.documents.find(d => d.id === id);
        if (!document) throw new Error("Unknown document.");
        return document;
    }

    open(surface: Surface, paneId: PaneId): TabId {
        this.document(surface.documentId);
        const id = `tab-${++this.nextId}` as TabId;
        const tab = Object.freeze({ id, paneId, generation: 0, surface: Object.freeze({ ...surface }) });
        this.publish(this.snapshot.documents, [...this.snapshot.tabs, tab]);
        return id;
    }

    move(id: TabId, paneId: PaneId): void {
        this.requireTab(id);
        this.publish(this.snapshot.documents, this.snapshot.tabs.map(tab =>
            tab.id === id ? Object.freeze({ ...tab, paneId }) : tab));
    }

    replace(id: TabId, surface: Surface): void {
        this.requireTab(id);
        this.document(surface.documentId);
        this.publish(this.snapshot.documents, this.snapshot.tabs.map(tab => tab.id === id
            ? Object.freeze({ ...tab, generation: tab.generation + 1, surface: Object.freeze({ ...surface }) })
            : tab));
    }

    close(id: TabId): void {
        this.requireTab(id);
        this.publish(this.snapshot.documents, this.snapshot.tabs.filter(tab => tab.id !== id));
    }

    /** Closing the last view does not implicitly discard unsaved document state. */
    releaseDocument(id: DocumentId): void {
        this.document(id);
        if (this.snapshot.tabs.some(tab => tab.surface.documentId === id)) {
            throw new Error("Close all document surfaces before releasing the document.");
        }
        this.publish(this.snapshot.documents.filter(d => d.id !== id), this.snapshot.tabs);
    }

    captureTab(id: TabId): TabTarget {
        const tab = this.requireTab(id);
        return Object.freeze({ workspace: this.lifetime, id, generation: tab.generation });
    }

    resolveTab(target: TabTarget): TabSnapshot | undefined {
        if (target.workspace !== this.lifetime) return undefined;
        return this.snapshot.tabs.find(tab => tab.id === target.id && tab.generation === target.generation);
    }

    edit(request: EditRequest): EditResult {
        const document = this.snapshot.documents.find(d => d.id === request.documentId);
        if (!document) return { applied: false, reason: "missing-document" };
        if (document.revision !== request.expectedRevision) return { applied: false, reason: "stale-revision" };
        const text = applyTextEdits(document.text, request.edits);
        if (text === document.text) return { applied: true, revision: document.revision };
        const next = Object.freeze({ ...document, text, revision: document.revision + 1 });
        this.publish(this.snapshot.documents.map(d => d.id === next.id ? next : d), this.snapshot.tabs);
        return { applied: true, revision: next.revision };
    }

    private requireTab(id: TabId): TabSnapshot {
        const tab = this.snapshot.tabs.find(t => t.id === id);
        if (!tab) throw new Error("Unknown tab.");
        return tab;
    }

    private publish(documents: readonly DocumentSnapshot[], tabs: readonly TabSnapshot[]): void {
        this.snapshot = Object.freeze({
            revision: this.snapshot.revision + 1,
            documents: Object.freeze([...documents]),
            tabs: Object.freeze([...tabs]),
        });
        for (const listener of [...this.listeners]) listener();
    }
}
