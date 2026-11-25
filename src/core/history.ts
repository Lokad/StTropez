import { isNonNegativeInteger } from "./bounds.ts";
import { appendStep, finishSteps, type StepRun, type TextStep } from "./text-transaction.ts";
import type { SelectionSet } from "./selections.ts";
export type { Selection } from "./selections.ts";

export type EditKind = "typing" | "delete" | "paste" | "composition" | "form" | "refactor" | "proposal" | "live" | "replace" | "canonical";
export type HistoryOptions = Readonly<{ maxGroups?: number; maxChanges?: number; maxChangedUnits?: number; maxSelectionRanges?: number }>;
export type HistorySnapshot = Readonly<{ undoDepth: number; redoDepth: number }>;
export type HistorySelection = Readonly<{ viewId: string; before: SelectionSet; after: SelectionSet }>;
export type HistoryChange = TextStep & Readonly<{ documentId: string;
    units: number; initiatingView: string | null; selections: readonly HistorySelection[] }>;
export type HistoryEntry = Readonly<{ id: number; origin: string; kind: EditKind; group: string | null;
    changes: readonly HistoryChange[]; steps: number; units: number }>;

const selectionRanges = (change: HistoryChange): number => change.selections.reduce((sum, view) =>
    sum + view.before.ranges.length + view.after.ranges.length, 0);

function textStep({ before, after, mapping, parts }: HistoryChange): TextStep {
    return { before, after, mapping, parts };
}

type StoredEntry = HistoryEntry & { run?: StepRun };
type Slot = { entry: StoredEntry; units: number; selections: number };
class DocumentHistory {
    // [start, cursor) can be undone. [cursor, start + slots.size) can be redone.
    readonly slots = new Map<number, Slot>();
    start = 0;
    cursor = 0;
    steps = 0;
    units = 0;
    selections = 0;
    last: StoredEntry | undefined;
    put(entry: StoredEntry, change: HistoryChange): void {
        const selections = selectionRanges(change);
        this.slots.set(this.cursor++, { entry, units: change.units, selections });
        this.steps += entry.steps; this.units += change.units; this.selections += selections;
        this.last = entry;
    }
    remove(index: number): StoredEntry {
        const { entry, units, selections } = this.slots.get(index)!;
        this.slots.delete(index);
        this.steps -= entry.steps; this.units -= units; this.selections -= selections;
        if (this.last === entry) this.last = undefined;
        return entry;
    }
}
export function validateHistoryGroup(group: string | undefined): void {
    if (group !== undefined && !group) throw new TypeError("Expected a nonempty history group.");
}

/** Workspace-local history units shared by the participating documents. No I/O or clock policy. */
export class TextHistory {
    readonly #documents = new Map<string, DocumentHistory>();
    readonly #changed = new Set<string>();
    readonly #retained = new Set<HistoryEntry>();
    #steps = 0;
    #units = 0;
    #nextId = 0;
    readonly #limits: Readonly<{ groups: number; changes: number; units: number; selections: number }>;
    constructor(options: HistoryOptions = {}) {
        this.#limits = { groups: options.maxGroups ?? Number.MAX_SAFE_INTEGER, changes: options.maxChanges ?? Number.MAX_SAFE_INTEGER,
            units: options.maxChangedUnits ?? 8_388_608, selections: options.maxSelectionRanges ?? 1_000_000 };
        if (Object.values(this.#limits).some(value => !isNonNegativeInteger(value))) throw new RangeError("History limits must be nonnegative safe integers.");
    }
    snapshot(id: string): HistorySnapshot {
        const doc = this.#documents.get(id), undoDepth = doc ? doc.cursor - doc.start : 0;
        return Object.freeze({ undoDepth, redoDepth: (doc?.slots.size ?? 0) - undoDepth });
    }
    takeChangedDocuments(): readonly string[] {
        const ids = Object.freeze([...this.#changed]); this.#changed.clear(); return ids;
    }
    diagnostics(): Readonly<{ groups: number; changes: number; changedUnits: number }> {
        return Object.freeze({ groups: this.#retained.size, changes: this.#steps, changedUnits: this.#units });
    }
    peek(id: string, direction: "undo" | "redo"): HistoryEntry | undefined {
        const doc = this.#documents.get(id);
        return doc?.slots.get(direction === "undo" ? doc.cursor - 1 : doc.cursor)?.entry;
    }
    available(entry: HistoryEntry, direction: "undo" | "redo"): boolean {
        return entry.changes.every(change => this.peek(change.documentId, direction) === entry);
    }
    seal(id: string): void {
        const doc = this.#documents.get(id); if (doc) doc.last = undefined;
    }
    record(changes: readonly HistoryChange[], origin: string, kind: EditKind, group?: string): void {
        validateHistoryGroup(group);
        const ids = changes.map(change => change.documentId);
        this.#clear(ids, true);
        if (!this.#limits.groups || !this.#limits.changes || changes.some(change =>
            change.units > this.#limits.units || selectionRanges(change) > this.#limits.selections)) {
            for (const id of ids) {
                const top = this.peek(id, "undo");
                if (top) this.#trimThrough(id, top.id);
            }
            return;
        }
        const first = changes[0]!, doc = this.#documents.get(first.documentId), previous = doc?.last, old = previous?.changes[0];
        let entry: StoredEntry;
        if (group !== undefined && previous && old && changes.length === 1 && previous.changes.length === 1
            && previous.origin === origin && previous.kind === kind && previous.group === group
            && first.before === old.after && first.initiatingView === old.initiatingView
            && first.selections.length === old.selections.length && first.selections.every((view, i) => view.viewId === old.selections[i]!.viewId)
            && previous.steps < this.#limits.changes && previous.units + first.units <= this.#limits.units
            && old.selections.reduce((sum, view, i) => sum + view.before.ranges.length + first.selections[i]!.after.ranges.length, 0) <= this.#limits.selections) {
            const run = appendStep(previous.run ?? { size: 1, step: textStep(old) }, textStep(first));
            let joined: TextStep | undefined;
            const step = () => joined ??= finishSteps(run);
            const change = Object.freeze({ ...first, before: old.before,
                get mapping() { return step().mapping; }, get parts() { return step().parts; },
                units: old.units + first.units, selections: Object.freeze(old.selections.map((view, i) => Object.freeze({ ...view, after: first.selections[i]!.after }))) });
            entry = Object.freeze({ ...previous, id: ++this.#nextId, changes: Object.freeze([change]), steps: previous.steps + 1, units: change.units, run });
            this.#discard(doc.remove(--doc.cursor));
        } else {
            const units = changes.reduce((sum, change) => sum + change.units, 0);
            entry = Object.freeze({ id: ++this.#nextId, origin, kind, group: group ?? null, changes: Object.freeze([...changes]), steps: 1, units });
            ids.forEach(id => this.#changed.add(id));
        }
        this.#retained.add(entry); this.#steps += entry.steps; this.#units += entry.units;
        for (const change of entry.changes) {
            let owner = this.#documents.get(change.documentId);
            if (!owner) this.#documents.set(change.documentId, owner = new DocumentHistory());
            owner.put(entry, change);
        }
        for (const id of ids) {
            const owner = this.#documents.get(id)!;
            while (owner.slots.size > this.#limits.groups || owner.steps > this.#limits.changes
                || owner.units > this.#limits.units || owner.selections > this.#limits.selections) {
                this.#trimThrough(id, owner.slots.get(owner.start)!.entry.id);
            }
        }
    }
    move(entry: HistoryEntry, direction: "undo" | "redo"): void {
        if (!this.available(entry, direction)) throw new Error("History unit is blocked by a later edit in a participating document.");
        for (const { documentId } of entry.changes) {
            const doc = this.#documents.get(documentId)!;
            doc.cursor += direction === "undo" ? -1 : 1; doc.last = undefined; this.#changed.add(documentId);
        }
    }
    forget(id: string): void { this.#clear([id], false); }
    #clear(ids: readonly string[], futureOnly: boolean): void {
        const pending = new Set(ids);
        for (const id of pending) {
            const doc = this.#documents.get(id); if (!doc) continue;
            const end = doc.start + doc.slots.size, from = futureOnly ? doc.cursor : doc.start;
            if (from < end) this.#changed.add(id);
            for (let i = from; i < end; i++) {
                const entry = doc.remove(i); this.#discard(entry);
                for (const change of entry.changes) pending.add(change.documentId);
            }
            if (!doc.slots.size) this.#documents.delete(id);
        }
    }
    /** Losing a shared undo also cuts off older entries behind it, but keeps newer edits and redo reachable. */
    #trimThrough(documentId: string, through: number): void {
        const pending = [{ documentId, through }];
        while (pending.length) {
            const cut = pending.pop()!, doc = this.#documents.get(cut.documentId)!;
            while (doc.start < doc.cursor && doc.slots.get(doc.start)!.entry.id <= cut.through) {
                const entry = doc.remove(doc.start++); this.#discard(entry); this.#changed.add(cut.documentId);
                for (const change of entry.changes) if (change.documentId !== cut.documentId) {
                    pending.push({ documentId: change.documentId, through: entry.id });
                }
            }
        }
    }
    #discard(entry: HistoryEntry): void {
        if (this.#retained.delete(entry)) { this.#steps -= entry.steps; this.#units -= entry.units; }
    }
}
