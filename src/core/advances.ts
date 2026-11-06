import { joinTrees } from "./avl.ts";

const capacity = 256;
type Measure = Readonly<{ length: number; total: number; minimum: number; maximum: number; closed: boolean; height: number; nodes: number; leaves: number }>;
type Leaf = Measure & Readonly<{ kind: "leaf"; values: Readonly<Float64Array> }>;
type Branch = Measure & Readonly<{ kind: "branch"; left: Node; right: Node }>;
type Node = Leaf | Branch;
type Root = Node | null;
export type AdvanceCell = Readonly<{ index: number; from: number; to: number; advance: number }>;
export type AdvanceWindow = Readonly<{ cells: readonly AdvanceCell[]; truncated: boolean; visitedNodes: number; readValues: number }>;
export type AdvanceRetention = Readonly<{ versions: number; nodes: number; leaves: number; values: number }>;
export type AdvanceBuildSnapshot = Readonly<{ status: "building" | "ready" | "disposed"; length: number; total: number; result: AdvanceIndex | null }>;
export type AdvanceBuilder = Readonly<{ append: (values: ArrayLike<number>, from?: number, to?: number) => void;
    finish: () => AdvanceIndex; snapshot: () => AdvanceBuildSnapshot; dispose: () => void }>;

function finite(value: number): number { if (!Number.isFinite(value)) throw new RangeError("Advance geometry must be finite."); return value === 0 ? 0 : value; }
function range(length: number, from: number, to = from): void {
    if (![length, from, to].every(Number.isSafeInteger) || from < 0 || from > to || to > length) throw new RangeError("Invalid advance range.");
}
function leaf(values: ArrayLike<number>): Leaf {
    let total = 0, minimum = 0, maximum = 0, closed = false;
    for (let i = 0; i < values.length; i++) {
        const value = values[i]!;
        const next = finite(total + finite(value));
        if (next > maximum) { maximum = next; closed = false; }
        if (value === 0 && total === maximum) closed = true;
        minimum = Math.min(minimum, next); total = next;
    }
    finite(maximum - minimum);
    // The owned copy never escapes the private root and is never mutated after construction.
    return Object.freeze({ kind: "leaf", values: new Float64Array(values), length: values.length, total, minimum, maximum, closed, height: 1, nodes: 1, leaves: 1 });
}
function branch(left: Node, right: Node): Branch {
    const total = finite(left.total + right.total), rightMinimum = finite(left.total + right.minimum), rightMaximum = finite(left.total + right.maximum);
    const minimum = Math.min(left.minimum, rightMinimum), maximum = Math.max(left.maximum, rightMaximum), length = left.length + right.length, nodes = 1 + left.nodes + right.nodes;
    finite(maximum - minimum); if (!Number.isSafeInteger(length) || !Number.isSafeInteger(nodes)) throw new RangeError("Advance count is too large.");
    return Object.freeze({ kind: "branch", left, right, length, total, minimum, maximum,
        closed: left.maximum === maximum && left.closed || rightMaximum === maximum && right.closed,
        height: 1 + Math.max(left.height, right.height), nodes, leaves: left.leaves + right.leaves });
}
const join = (left: Root, right: Root): Root => joinTrees(left, right, branch);
function split(node: Root, offset: number): readonly [Root, Root] {
    if (!node) return [null, null]; if (offset === 0) return [null, node]; if (offset === node.length) return [node, null];
    if (node.kind === "leaf") return [leaf(node.values.slice(0, offset)), leaf(node.values.slice(offset))];
    if (offset < node.left.length) { const [a, b] = split(node.left, offset); return [a, join(b, node.right)]; }
    const [a, b] = split(node.right, offset - node.left.length); return [join(node.left, a), b];
}

let publish: (root: Root) => AdvanceIndex;

/** Persistent signed advances. Ordinals and coordinates are independent of source offsets and glyph identities. */
export class AdvanceIndex {
    readonly #root: Root;
    private constructor(root: Root) { this.#root = root; Object.freeze(this); }
    static from(values: ArrayLike<number>): AdvanceIndex {
        const length = values.length; range(length, 0, length); const builder = createAdvanceBuilder();
        for (let from = 0; from < length; from += capacity) builder.append(values, from, Math.min(length, from + capacity));
        return builder.finish();
    }
    /** Bounded append calls copy inputs; finish publishes an already-built immutable root. */
    static builder(): AdvanceBuilder { return createAdvanceBuilder(); }
    get length(): number { return this.#root?.length ?? 0; }
    get total(): number { return this.#root?.total ?? 0; }
    get minimum(): number { return this.#root?.minimum ?? 0; }
    get maximum(): number { return this.#root?.maximum ?? 0; }
    prefix(end: number): number {
        range(this.length, end); if (end === this.length) return this.total;
        let node = this.#root, result = 0;
        while (node?.kind === "branch") { if (end < node.left.length) node = node.left; else { end -= node.left.length; result += node.left.total; node = node.right; } }
        if (node) for (let i = 0; i < end; i++) result += node.values[i]!; return result === 0 ? 0 : result;
    }
    at(index: number): number {
        range(this.length, index, index + 1); let node = this.#root!;
        while (node.kind === "branch") { if (index < node.left.length) node = node.left; else { index -= node.left.length; node = node.right; } }
        return node.values[index]!;
    }
    slice(from: number, to = this.length): AdvanceIndex {
        range(this.length, from, to); if (from === 0 && to === this.length) return this;
        const [, rest] = split(this.#root, from), [selected] = split(rest, to - from); return new AdvanceIndex(selected);
    }
    replace(from: number, to: number, replacement: AdvanceIndex): AdvanceIndex {
        range(this.length, from, to); if (!(replacement instanceof AdvanceIndex)) throw new TypeError("Expected an advance index.");
        if (from === to && replacement.length === 0 || from === 0 && to === this.length && replacement === this) return this;
        const [left, rest] = split(this.#root, from), [, right] = split(rest, to - from);
        return new AdvanceIndex(join(join(left, replacement.#root), right));
    }
    window(low: number, high: number, limit = 512): AdvanceWindow {
        finite(low); finite(high); if (low >= high || !Number.isSafeInteger(limit) || limit < 1 || limit > 4096) throw new RangeError("Invalid advance window.");
        const cells: AdvanceCell[] = []; let visitedNodes = 0, readValues = 0, truncated = false;
        const visit = (node: Root, origin: number, index: number): void => {
            if (!node || truncated) return; visitedNodes++;
            const maximum = origin + node.maximum;
            if (origin + node.minimum >= high || maximum < low || maximum === low && !node.closed) return;
            if (node.kind === "branch") { visit(node.left, origin, index); visit(node.right, origin + node.left.total, index + node.left.length); return; }
            let position = origin;
            for (let i = 0; i < node.values.length; i++) {
                const advance = node.values[i]!, end = position + advance; readValues++;
                const hit = position === end ? position >= low && position < high : Math.min(position, end) < high && Math.max(position, end) > low;
                if (hit) { if (cells.length === limit) { truncated = true; return; } cells.push(Object.freeze({ index: index + i, from: position, to: end, advance })); } position = end;
            }
        }; visit(this.#root, 0, 0);
        return Object.freeze({ cells: Object.freeze(cells), truncated, visitedNodes, readValues });
    }
    diagnostics(): Readonly<{ length: number; height: number; nodes: number; leaves: number; values: number; capacity: number }> {
        return Object.freeze({ length: this.length, height: this.#root?.height ?? 0, nodes: this.#root?.nodes ?? 0, leaves: this.#root?.leaves ?? 0, values: this.length, capacity });
    }
    static retained(versions: readonly AdvanceIndex[]): AdvanceRetention {
        const seen = new Set<Node>(); let leaves = 0, values = 0;
        const visit = (node: Root): void => { if (!node || seen.has(node)) return; seen.add(node); if (node.kind === "branch") { visit(node.left); visit(node.right); } else { leaves++; values += node.length; } };
        for (const version of versions) visit(version.#root); return Object.freeze({ versions: versions.length, nodes: seen.size, leaves, values });
    }
    /** Internal builder publication; no mutable node escapes through the public facade. */
    static { publish = (root: Root) => new AdvanceIndex(root); }
}

export function createAdvanceBuilder(): AdvanceBuilder {
    let root: Root = null, complete: Root = null, pending: number[] = [], busy = false;
    let state: AdvanceBuildSnapshot = Object.freeze({ status: "building", length: 0, total: 0, result: null });
    const writable = () => { if (busy || state.status !== "building") throw new Error("Advance builder is unavailable."); };
    return Object.freeze({
        append: (values: ArrayLike<number>, from = 0, to?: number) => {
            writable(); busy = true;
            try {
                const sourceLength = values.length, end = to ?? sourceLength; range(sourceLength, from, end);
                if (end - from > capacity) throw new RangeError("Append at most 256 advances per step."); if (from === end) return;
                let nextRoot = root, nextPending = [...pending];
                for (let i = from; i < end; i++) { nextPending.push(finite(values[i]!)); if (nextPending.length === capacity) { nextRoot = join(nextRoot, leaf(nextPending)); nextPending = []; } }
                const next = join(nextRoot, nextPending.length ? leaf(nextPending) : null);
                root = nextRoot; pending = nextPending; complete = next;
                state = Object.freeze({ status: "building", length: next!.length, total: next!.total, result: null });
            } finally { busy = false; }
        },
        finish: () => { if (busy || state.status === "disposed") throw new Error("Advance builder is unavailable."); if (state.result) return state.result;
            const result = publish(complete); root = null; complete = null; pending = []; state = Object.freeze({ status: "ready", length: result.length, total: result.total, result }); return result; },
        snapshot: () => state,
        dispose: () => { if (busy) throw new Error("Advance builder is busy."); if (state.status === "disposed") return; root = null; complete = null; pending = []; state = Object.freeze({ status: "disposed", length: 0, total: 0, result: null }); }
    });
}
