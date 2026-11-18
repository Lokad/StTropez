import { test } from "node:test";
import { nextSeed } from "../fixtures/workloads.ts";
import assert from "node:assert/strict";
import { TextHistory } from "../src/core/history.ts";
import type { EditKind, HistoryChange, HistoryEntry, HistoryOptions } from "../src/core/history.ts";
import { TextBuffer, createSelectionSet } from "../src/index.ts";

type Change = Omit<HistoryChange, "mapping">;
type Row = Omit<HistoryEntry, "changes"> & { changes: readonly Change[]; direction: "undo" | "redo"; stamp: number };
const ranges = (changes: readonly Change[]) => changes.reduce((sum, change) => sum + (change.selection
    ? change.selection.before.ranges.length + change.selection.after.ranges.length : 0), 0);

/** Slow oracle: a global ledger, recomputed totals and fixed-point membership, without per-document stacks. */
class Ledger {
    rows: Row[] = [];
    last = new Map<string, number>();
    id = 0; stamp = 0;
    coverage = { grouped: 0, evictedUndo: 0, evictedRedo: 0, linkedClear: 0, moved: 0 };
    readonly limits: Required<HistoryOptions>;
    constructor(limits: Required<HistoryOptions>) { this.limits = limits; }
    peek(id: string, direction: "undo" | "redo") {
        return this.rows.filter(row => row.direction === direction && row.changes.some(change => change.documentId === id))
            .sort((a, b) => b.stamp - a.stamp)[0];
    }
    available(row: Row, direction: "undo" | "redo") { return row.changes.every(change => this.peek(change.documentId, direction) === row); }
    diagnostics() { return { groups: this.rows.length, changes: this.rows.reduce((sum, row) => sum + row.steps, 0),
        changedUnits: this.rows.reduce((sum, row) => sum + row.units, 0) }; }
    snapshot(id: string) { return { undoDepth: this.rows.filter(row => row.direction === "undo" && row.changes.some(change => change.documentId === id)).length,
        redoDepth: this.rows.filter(row => row.direction === "redo" && row.changes.some(change => change.documentId === id)).length }; }
    clear(ids: readonly string[], futureOnly: boolean) {
        const linked = new Set(ids), candidates = this.rows.filter(row => !futureOnly || row.direction === "redo");
        let size: number;
        do {
            size = linked.size;
            for (const row of candidates) if (row.changes.some(change => linked.has(change.documentId)))
                row.changes.forEach(change => linked.add(change.documentId));
        } while (linked.size !== size);
        if (linked.size > ids.length) this.coverage.linkedClear++;
        this.rows = this.rows.filter(row => (futureOnly && row.direction !== "redo") || !row.changes.some(change => linked.has(change.documentId)));
        if (!futureOnly) linked.forEach(id => this.last.delete(id));
    }
    move(row: Row, direction: "undo" | "redo") {
        this.coverage.moved++;
        row.direction = direction === "undo" ? "redo" : "undo"; row.stamp = ++this.stamp;
        row.changes.forEach(change => this.last.delete(change.documentId));
    }
    record(changes: readonly Change[], origin: string, kind: EditKind, group?: string) {
        this.clear(changes.map(change => change.documentId), true);
        const first = changes[0]!, units = changes.reduce((sum, change) => sum + change.units, 0);
        if (!this.limits.maxGroups || !this.limits.maxChanges || units > this.limits.maxChangedUnits || ranges(changes) > this.limits.maxSelectionRanges) {
            this.clear(changes.map(change => change.documentId), false); return;
        }
        const previous = this.rows.find(row => row.id === this.last.get(first.documentId)), old = previous?.changes[0];
        let content = changes, steps = 1, totalUnits = units;
        if (previous && old && changes.length === 1 && previous.changes.length === 1 && group !== undefined
            && previous.group === group && previous.kind === kind && previous.origin === origin
            && first.before === old.after && first.selection?.viewId === old.selection?.viewId
            && this.peek(first.documentId, "undo") === previous && previous.steps + 1 <= this.limits.maxChanges
            && previous.units + units <= this.limits.maxChangedUnits) {
            this.coverage.grouped++;
            content = [{ ...old, after: first.after, units: old.units + units,
                selection: old.selection && first.selection ? { ...old.selection, after: first.selection.after } : null }];
            steps += previous.steps; totalUnits += previous.units; this.rows = this.rows.filter(row => row !== previous);
        }
        const row: Row = { id: ++this.id, stamp: ++this.stamp, direction: "undo", origin, kind, group: group ?? null, changes: content, steps, units: totalUnits };
        this.rows.push(row); changes.forEach(change => this.last.set(change.documentId, row.id));
        while (true) {
            const totals = this.diagnostics();
            if (totals.groups <= this.limits.maxGroups && totals.changes <= this.limits.maxChanges
                && totals.changedUnits <= this.limits.maxChangedUnits && this.rows.reduce((sum, row) => sum + ranges(row.changes), 0) <= this.limits.maxSelectionRanges) break;
            const oldest = this.rows.reduce((a, b) => a.id < b.id ? a : b);
            this.coverage[oldest.direction === "undo" ? "evictedUndo" : "evictedRedo"]++;
            if (oldest.direction === "redo") this.clear(oldest.changes.map(change => change.documentId), true);
            else this.rows = this.rows.filter(row => row !== oldest);
            oldest.changes.forEach(change => { if (this.last.get(change.documentId) === oldest.id) this.last.delete(change.documentId); });
        }
    }
}

function summary(entry: HistoryEntry | Row | undefined) {
    return entry && { id: entry.id, origin: entry.origin, kind: entry.kind, group: entry.group, steps: entry.steps, units: entry.units,
        changes: entry.changes.map(({ documentId, before, after, units, selection }) => ({ documentId, before, after, units, selection })) };
}

test("bounded history matches a recomputing ledger through grouping, linked movement, branching and every limit", t => {
    const coverage = { grouped: 0, evictedUndo: 0, evictedRedo: 0, linkedClear: 0, moved: 0 };
    for (const options of [{}, { maxGroups: 0 }, { maxChanges: 0 }, { maxChangedUnits: 0 }, { maxSelectionRanges: 0 },
        { maxGroups: 2 }, { maxChanges: 3 }, { maxChangedUnits: 9 }, { maxSelectionRanges: 6 }]) {
        const limits = { maxGroups: 12, maxChanges: 18, maxChangedUnits: 60, maxSelectionRanges: 32, ...options };
        const actual = new TextHistory(limits), expected = new Ledger(limits), ids = ["a", "b", "c", "d"];
        const buffers = new Map(ids.map(id => [id, TextBuffer.from("012345678901234567890123")]));
        let seed = 0x65ab19;
        const random = (bound: number) => { seed = nextSeed(seed); return Math.floor(seed / 0x100000000 * bound); };
        for (let step = 0; step < 1200; step++) {
            const id = ids[random(ids.length)]!, action = random(20);
            if (action < 12) {
                const members = action < 3 ? [id, ids[(ids.indexOf(id) + 1) % ids.length]!] : [id];
                const changes = members.map(documentId => {
                    const before = buffers.get(documentId)!, result = before.apply([{ from: 0, to: random(3), insert: "x".repeat(1 + random(9)) }]);
                    const selections = (buffer: TextBuffer) => createSelectionSet(buffer.length, Array.from({ length: 1 + random(4) }, (_, i) => ({ anchor: i * 2, head: i * 2 })));
                    const selection = action % 3 ? { viewId: documentId, before: selections(before), after: selections(result.buffer) } : null;
                    buffers.set(documentId, result.buffer);
                    return { documentId, before, after: result.buffer, mapping: result.mapping, units: result.changedUnits, selection };
                });
                const group = members.length === 1 && action % 2 ? "typing" : undefined;
                actual.record(changes, "human", "typing", group); expected.record(changes, "human", "typing", group);
            } else if (action < 18) {
                const direction = action < 15 ? "undo" : "redo", row = expected.peek(id, direction), entry = actual.peek(id, direction);
                assert.deepEqual(summary(entry), summary(row));
                if (row && entry) {
                    assert.equal(actual.available(entry, direction), expected.available(row, direction));
                    if (expected.available(row, direction)) {
                        actual.move(entry, direction); expected.move(row, direction);
                        row.changes.forEach(change => buffers.set(change.documentId, direction === "undo" ? change.before : change.after));
                    } else assert.throws(() => actual.move(entry, direction), /blocked/);
                }
            } else if (action === 18) { actual.forget(id); expected.clear([id], false); }
            else { actual.seal(id); expected.last.delete(id); }
            assert.deepEqual(actual.diagnostics(), expected.diagnostics(), `totals at step ${step}, ${JSON.stringify(options)}`);
            for (const id of ids) {
                assert.deepEqual(actual.snapshot(id), expected.snapshot(id));
                for (const direction of ["undo", "redo"] as const) assert.deepEqual(summary(actual.peek(id, direction)), summary(expected.peek(id, direction)));
            }
            actual.takeChangedDocuments();
        }
        ids.forEach(id => actual.forget(id)); assert.deepEqual(actual.diagnostics(), { groups: 0, changes: 0, changedUnits: 0 });
        for (const key of Object.keys(coverage) as (keyof typeof coverage)[]) coverage[key] += expected.coverage[key];
    }
    t.diagnostic(JSON.stringify(coverage)); for (const count of Object.values(coverage)) assert.ok(count > 0);
});

test("history admission, eviction and diagnostics do not recount unrelated retained entries", t => {
    const history = new TextHistory({ maxGroups: 1001, maxChanges: 2000 });
    const before = TextBuffer.from("a"), result = before.apply([{ from: 1, to: 1, insert: "b" }]);
    let selectionReads = 0;
    for (let i = 0; i < 1000; i++) history.record([Object.freeze({ documentId: String(i), before, after: result.buffer, mapping: result.mapping,
        units: 1, get selection() { selectionReads++; return null; } })], "human", "replace");
    const change = { documentId: "new", before, after: result.buffer, mapping: result.mapping, units: 1, selection: null };
    selectionReads = 0; history.record([change], "human", "replace"); const admission = selectionReads;
    selectionReads = 0; history.record([{ ...change, documentId: "last" }], "human", "replace"); const eviction = selectionReads;
    selectionReads = 0; const totals = history.diagnostics(), diagnostics = selectionReads;
    t.diagnostic(JSON.stringify({ admission, eviction, diagnostics }));
    assert.deepEqual({ admission, eviction, diagnostics }, { admission: 0, eviction: 0, diagnostics: 0 });
    assert.deepEqual(totals, { groups: 1001, changes: 1001, changedUnits: 1001 });
    assert.equal(history.snapshot("0").undoDepth, 0); assert.equal(history.snapshot("1").undoDepth, 1);
});
