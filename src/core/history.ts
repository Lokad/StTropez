import type { TextBuffer } from "./text-buffer.ts";
import type { PositionMapping } from "./positions.ts";
import { composePositionMaps } from "./positions.ts";
import type { SelectionSet } from "./selections.ts";
export type { Selection } from "./selections.ts";

export type EditKind = "typing" | "delete" | "paste" | "composition" | "form" | "refactor" | "proposal" | "live" | "replace" | "canonical";
export type HistoryOptions = Readonly<{ maxGroups?: number; maxChanges?: number; maxChangedUnits?: number; maxSelectionRanges?: number }>;
export type HistorySnapshot = Readonly<{ undoDepth: number; redoDepth: number }>;
export type HistorySelection = Readonly<{ viewId: string; before: SelectionSet; after: SelectionSet }>;
export type HistoryChange = Readonly<{ documentId: string; before: TextBuffer; after: TextBuffer;
    mapping: PositionMapping; units: number; initiatingView: string | null; selections: readonly HistorySelection[] }>;
export type HistoryEntry = Readonly<{ id: number; origin: string; kind: EditKind; group: string | null;
    changes: readonly HistoryChange[]; steps: number; units: number }>;

const selectionRanges = (changes: readonly HistoryChange[]): number => changes.reduce((total, change) => total
    + change.selections.reduce((sum, view) => sum + view.before.ranges.length + view.after.ranges.length, 0), 0);
export function validateHistoryGroup(group: string | undefined): void {
    if (group !== undefined && !group) throw new TypeError("Expected a nonempty history group.");
}

/** Workspace-local history units shared by the participating documents. No I/O or clock policy. */
export class TextHistory {
    private readonly past = new Map<string, HistoryEntry[]>();
    private readonly future = new Map<string, HistoryEntry[]>();
    private readonly changed = new Set<string>();
    // Insertion order follows entry IDs; extending a group replaces its retained entry.
    private readonly retained = new Map<HistoryEntry, number>();
    private steps = 0;
    private units = 0;
    private selections = 0;
    private nextId = 0;
    private readonly last = new Map<string, HistoryEntry>();
    private readonly limits: Readonly<{ groups: number; changes: number; units: number; selections: number }>;
    constructor(options: HistoryOptions = {}) {
        this.limits = Object.freeze({ groups: options.maxGroups ?? 100, changes: options.maxChanges ?? 1_000, units: options.maxChangedUnits ?? 8_388_608,
            selections: options.maxSelectionRanges ?? 1_000_000 });
        if (Object.values(this.limits).some(value => !Number.isSafeInteger(value) || value < 0)) throw new RangeError("History limits must be nonnegative safe integers.");
    }
    snapshot(id: string): HistorySnapshot { return Object.freeze({ undoDepth: this.past.get(id)?.length ?? 0, redoDepth: this.future.get(id)?.length ?? 0 }); }
    /** Drain stack-depth changes, including indirect participants of clearing and eviction. */
    takeChangedDocuments(): readonly string[] {
        const ids = Object.freeze([...this.changed]); this.changed.clear(); return ids;
    }
    diagnostics(): Readonly<{ groups: number; changes: number; changedUnits: number }> {
        return Object.freeze({ groups: this.retained.size, changes: this.steps, changedUnits: this.units });
    }
    peek(id: string, direction: "undo" | "redo"): HistoryEntry | undefined { return (direction === "undo" ? this.past : this.future).get(id)?.at(-1); }
    available(entry: HistoryEntry, direction: "undo" | "redo"): boolean {
        return entry.changes.every(change => this.peek(change.documentId, direction) === entry);
    }
    seal(id: string): void { this.last.delete(id); }
    record(changes: readonly HistoryChange[], origin: string, kind: EditKind, group?: string): void {
        validateHistoryGroup(group);
        this.clearFuture(changes.map(change => change.documentId));
        const units = changes.reduce((total, change) => total + change.units, 0), previous = this.last.get(changes[0]!.documentId);
        if (!this.limits.groups || !this.limits.changes || units > this.limits.units || selectionRanges(changes) > this.limits.selections) {
            changes.forEach(change => this.forget(change.documentId)); return;
        }
        const first = changes[0], old = previous?.changes[0];
        if (group !== undefined && previous && first && old && changes.length === 1 && previous.changes.length === 1
            && previous.origin === origin && previous.kind === kind && previous.group === group && first.documentId === old.documentId
            && first.before === old.after && first.initiatingView === old.initiatingView
            && first.selections.length === old.selections.length && first.selections.every((view, i) => view.viewId === old.selections[i]!.viewId)
            && this.peek(first.documentId, "undo") === previous && previous.steps + 1 <= this.limits.changes && previous.units + units <= this.limits.units) {
            const change = Object.freeze({ ...old, after: first.after, mapping: composePositionMaps(old.mapping, first.mapping), units: old.units + first.units,
                selections: Object.freeze(old.selections.map((view, i) => Object.freeze({ ...view, after: first.selections[i]!.after }))) });
            const entry = Object.freeze({ ...previous, id: ++this.nextId, changes: Object.freeze([change]), steps: previous.steps + 1, units: previous.units + units });
            this.past.get(first.documentId)![this.past.get(first.documentId)!.length - 1] = entry; this.last.set(first.documentId, entry);
            this.discard(previous); this.retain(entry);
        } else {
            const entry = Object.freeze({ id: ++this.nextId, origin, kind, group: group ?? null, changes: Object.freeze([...changes]), steps: 1, units });
            for (const change of changes) { this.stack(this.past, change.documentId).push(entry); this.changed.add(change.documentId); }
            for (const change of changes) this.last.set(change.documentId, entry);
            this.retain(entry);
        }
        this.trim();
    }
    move(entry: HistoryEntry, direction: "undo" | "redo"): void {
        if (!this.available(entry, direction)) throw new Error("History unit is blocked by a later edit in a participating document.");
        const source = direction === "undo" ? this.past : this.future, target = direction === "undo" ? this.future : this.past;
        for (const change of entry.changes) {
            source.get(change.documentId)!.pop(); this.stack(target, change.documentId).push(entry); this.changed.add(change.documentId);
        }
        entry.changes.forEach(change => this.seal(change.documentId));
    }
    /** Clear both stacks for the entire component connected by retained multi-document units. */
    forget(id: string): void {
        const pending = [id], visited = new Set<string>();
        while (pending.length) {
            const current = pending.pop()!; if (visited.has(current)) continue; visited.add(current);
            for (const stack of [this.past.get(current), this.future.get(current)]) for (const entry of stack ?? []) {
                entry.changes.forEach(change => pending.push(change.documentId));
                this.discard(entry);
            }
        }
        visited.forEach(current => {
            if (this.past.get(current)?.length || this.future.get(current)?.length) this.changed.add(current);
            this.past.delete(current); this.future.delete(current); this.seal(current);
        });
    }
    private stack(map: Map<string, HistoryEntry[]>, id: string): HistoryEntry[] {
        let stack = map.get(id); if (!stack) { stack = []; map.set(id, stack); } return stack;
    }
    private clearFuture(ids: readonly string[]): void {
        const pending = [...ids], visited = new Set<string>();
        while (pending.length) {
            const id = pending.pop()!; if (visited.has(id)) continue; visited.add(id);
            const future = this.future.get(id);
            if (future?.length) this.changed.add(id);
            for (const entry of future ?? []) { entry.changes.forEach(change => pending.push(change.documentId)); this.discard(entry); }
            this.future.delete(id);
        }
    }
    private retain(entry: HistoryEntry): void {
        const selections = selectionRanges(entry.changes);
        this.retained.set(entry, selections); this.steps += entry.steps; this.units += entry.units; this.selections += selections;
    }
    private discard(entry: HistoryEntry): void {
        const selections = this.retained.get(entry); if (selections === undefined) return;
        this.retained.delete(entry); this.steps -= entry.steps; this.units -= entry.units; this.selections -= selections;
    }
    private trim(): void {
        while (this.retained.size > this.limits.groups || this.steps > this.limits.changes || this.units > this.limits.units || this.selections > this.limits.selections) {
            const entry = this.retained.keys().next().value!;
            for (const change of entry.changes) {
                const stack = this.past.get(change.documentId), index = stack?.indexOf(entry) ?? -1;
                if (index >= 0) { stack!.splice(index, 1); this.changed.add(change.documentId); }
            }
            if (entry.changes.some(change => this.future.get(change.documentId)?.includes(entry))) this.clearFuture(entry.changes.map(change => change.documentId));
            this.discard(entry);
            entry.changes.forEach(change => { if (this.last.get(change.documentId) === entry) this.seal(change.documentId); });
        }
    }
}
