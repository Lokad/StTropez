import { joinTrees } from "./avl.ts";

export type DiffLine = Readonly<{ length: number; hash: number | undefined; token: string | undefined }>;
type Block = Readonly<{ kind: "leaf"; height: 1; size: number; entries: readonly DiffLine[] }>;
type Gap = Readonly<{ kind: "leaf"; height: 1; size: number; entries: undefined }>;
type Leaf = Block | Gap;
type Branch = Readonly<{ kind: "branch"; height: number; size: number; left: Node; right: Node }>;
type Node = Leaf | Branch;
type Root = Node | null;
type LocatedBlock = Readonly<{ from: number; entries: readonly DiffLine[] }>;
type Memo = { root: Root; last: LocatedBlock | undefined };
function leaf(entries: readonly DiffLine[]): Block {
    if (!entries.length || entries.length > 64) throw new RangeError("Invalid comparison line block.");
    return Object.freeze({ kind: "leaf", height: 1, size: entries.length, entries: Object.freeze([...entries]) });
}
const gap = (size: number): Gap => Object.freeze({ kind: "leaf", height: 1, size, entries: undefined });
const branch = (left: Node, right: Node): Branch => Object.freeze({ kind: "branch", height: Math.max(left.height, right.height) + 1,
    size: left.size + right.size, left, right });
const join = (left: Root, right: Root): Root => joinTrees(left, right, branch);
function split(root: Root, at: number): readonly [Root, Root] {
    if (!root || at === 0) return [null, root]; if (at === root.size) return [root, null];
    if (root.kind === "leaf") return root.entries ? [leaf(root.entries.slice(0, at)), leaf(root.entries.slice(at))] : [gap(at), gap(root.size - at)];
    if (at < root.left.size) { const [left, middle] = split(root.left, at); return [left, join(middle, root.right)]; }
    const [middle, right] = split(root.right, at - root.left.size); return [join(root.left, middle), right];
}

/** Sparse line slots. The private memo fills immutable nodes without changing source or row coordinates. */
export class DiffLines {
    readonly #memo: Memo;
    constructor(root: Root = null) { this.#memo = { root, last: undefined }; Object.freeze(this); }
    static gap(size: number): DiffLines {
        if (!Number.isSafeInteger(size) || size < 0) throw new RangeError("Invalid comparison line count.");
        return new DiffLines(size ? gap(size) : null);
    }
    get size(): number { return this.#memo.root?.size ?? 0; }
    concat(other: DiffLines): DiffLines { return new DiffLines(join(this.#memo.root, other.#memo.root)); }
    slice(from: number, to: number): DiffLines {
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > this.size) throw new RangeError("Invalid comparison line range.");
        const [left] = split(this.#memo.root, to), [, result] = split(left, from); return new DiffLines(result);
    }
    at(index: number): DiffLine | undefined {
        const block = this.#block(index); return block?.entries[index - block.from];
    }
    #block(index: number): LocatedBlock | undefined {
        if (!Number.isSafeInteger(index) || index < 0 || index >= this.size) throw new RangeError("Invalid comparison line.");
        const memo = this.#memo, last = memo.last;
        if (last && index >= last.from && index < last.from + last.entries.length) return last;
        let node = memo.root!, from = 0;
        while (node.kind === "branch") { if (index < node.left.size) node = node.left; else { index -= node.left.size; from += node.left.size; node = node.right; } }
        if (node.entries) { const block = { from, entries: node.entries }; memo.last = block; return block; }
        return undefined;
    }
    /** Exact known-row proof within the current immutable metadata leaves. Reads no source. */
    matching(other: DiffLines, from: number, to: number, otherFrom: number, otherTo: number, reverse: boolean, identity: (line: DiffLine) => number | undefined): number {
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || !Number.isSafeInteger(otherFrom) || !Number.isSafeInteger(otherTo)
            || from < 0 || to < from || to > this.size
            || otherFrom < 0 || otherTo < otherFrom || otherTo > other.size) throw new RangeError("Invalid comparison metadata range.");
        if (from === to || otherFrom === otherTo) return 0;
        const ai = reverse ? to - 1 : from, bi = reverse ? otherTo - 1 : otherFrom;
        const a = this.#block(ai), b = other.#block(bi);
        if (!a || !b) return 0;
        const same = (left: DiffLine | undefined, right: DiffLine | undefined) => {
            if (!left || !right || left.length !== right.length) return false;
            const a = identity(left), b = identity(right);
            return a !== undefined && b !== undefined ? a === b : left.token !== undefined && left.token === right.token;
        };
        const al = ai - a.from, bl = bi - b.from;
        if (!same(a.entries[al], b.entries[bl])) return 0;
        const maximum = Math.min(to - from, otherTo - otherFrom,
            reverse ? al + 1 : a.entries.length - al, reverse ? bl + 1 : b.entries.length - bl);
        const direction = reverse ? -1 : 1; let count = 1;
        while (count < maximum) {
            const av = a.entries[al + direction * count]!, bv = b.entries[bl + direction * count]!;
            if (!same(av, bv)) break;
            count++;
        }
        return count;
    }
    materialize(from: number, to: number, entries: readonly DiffLine[]): void {
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > this.size) throw new RangeError("Invalid comparison line range.");
        if (entries.length !== to - from) throw new RangeError("Invalid comparison metadata block.");
        const memo = this.#memo, [before] = split(memo.root, from), [, after] = split(memo.root, to), middle = leaf(entries);
        memo.root = join(join(before, middle), after); memo.last = { from, entries: middle.entries };
    }
}
