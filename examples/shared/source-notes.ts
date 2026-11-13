import { anchoredRange } from "../../src/index.ts";
import type { AnchoredRange, DocumentId, Workspace } from "../../src/index.ts";
import { HostCell } from "./observable.ts";

export type SourceNote = Readonly<{ id: number; text: string; range: AnchoredRange }>;
/** Host metadata, tracked through the public transaction maps; it is never inserted into source. */
export class HostSourceNotes {
    private readonly workspace: Workspace;
    private readonly document: DocumentId;
    private readonly stop: () => void;
    private serial = 0;
    private disposed = false;
    private readonly cell: HostCell<Readonly<{ revision: number | null; notes: readonly SourceNote[] }>>;
    readonly state;
    constructor(workspace: Workspace, document: DocumentId) {
        this.workspace = workspace; this.document = document;
        this.cell = new HostCell({ revision: workspace.document(document).revision, notes: [] }); this.state = this.cell.observable;
        this.stop = workspace.observeDocument(document).subscribe(() => {
            const next = workspace.observeDocument(document).getSnapshot(), previous = this.cell.get();
            if (next?.revision === previous.revision) return;
            const notes = next?.change?.previousRevision === previous.revision ? previous.notes.flatMap(note => {
                const range = next.change!.mapping.mapRange(note.range); return range ? [Object.freeze({ ...note, range })] : [];
            }) : [];
            this.cell.set({ revision: next?.revision ?? null, notes });
        });
    }
    add(revision: number, from: number, to: number, text: string): boolean {
        if (this.disposed || this.cell.get().revision !== revision || this.cell.get().notes.length >= 64) return false;
        const doc = this.workspace.document(this.document); if (doc.revision !== revision) return false;
        const range = anchoredRange(doc.buffer.length, from, to, { onDelete: "invalidate" });
        this.cell.set({ revision, notes: [...this.cell.get().notes, { id: ++this.serial, text: text.slice(0, 120), range }] }); return true;
    }
    clear(): void { if (!this.disposed) this.cell.set({ ...this.cell.get(), notes: [] }); }
    dispose(): void { if (this.disposed) return; this.clear(); this.disposed = true; this.stop(); }
}
