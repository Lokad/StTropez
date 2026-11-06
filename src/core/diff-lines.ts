import { joinTrees } from "./avl.ts";

export type DiffLine = Readonly<{ length: number; hash: number | undefined; token: string | undefined }>;
type Block = Readonly<{ kind: "leaf"; height: 1; size: number; entries: readonly DiffLine[] }>;
type Gap = Readonly<{ kind: "leaf"; height: 1; size: number; entries: undefined }>;
type Leaf = Block | Gap;
type Branch = Readonly<{ kind: "branch"; height: number; size: number; left: Node; right: Node }>;
type Node = Leaf | Branch;
type Root = Node | null;
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

/** Sparse line slots. Memoization never changes the captured source or row coordinates. */
export class DiffLines {
    #root: Root;
    #last: Readonly<{ from: number; entries: readonly DiffLine[] }> | undefined;
    constructor(root: Root = null) { this.#root = root; Object.freeze(this); }
    static gap(size: number): DiffLines {
        if (!Number.isSafeInteger(size) || size < 0) throw new RangeError("Invalid comparison line count.");
        return new DiffLines(size ? gap(size) : null);
    }
    get size(): number { return this.#root?.size ?? 0; }
    concat(other: DiffLines): DiffLines { return new DiffLines(join(this.#root, other.#root)); }
    slice(from: number, to: number): DiffLines {
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > this.size) throw new RangeError("Invalid comparison line range.");
        const [left] = split(this.#root, to), [, result] = split(left, from); return new DiffLines(result);
    }
    at(index: number): DiffLine | undefined {
        if (!Number.isSafeInteger(index) || index < 0 || index >= this.size) throw new RangeError("Invalid comparison line.");
        if (this.#last && index >= this.#last.from && index < this.#last.from + this.#last.entries.length) return this.#last.entries[index - this.#last.from];
        let node = this.#root!, from = 0;
        while (node.kind === "branch") { if (index < node.left.size) node = node.left; else { index -= node.left.size; from += node.left.size; node = node.right; } }
        if (node.entries) { this.#last = { from, entries: node.entries }; return node.entries[index]; }
        return undefined;
    }
    materialize(from: number, to: number, entries: readonly DiffLine[]): void {
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > this.size) throw new RangeError("Invalid comparison line range.");
        if (entries.length !== to - from) throw new RangeError("Invalid comparison metadata block.");
        const [before] = split(this.#root, from), [, after] = split(this.#root, to), middle = leaf(entries);
        this.#root = join(join(before, middle), after); this.#last = { from, entries: middle.entries };
    }
}
