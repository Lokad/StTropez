import { validateTextEdits } from "../src/core/changes.ts";
import { TextBuffer } from "../src/core/text-buffer.ts";

/** Development probes only. No candidate is selected by this file's presence or name. */
export interface Storage {
    readonly length: number;
    readonly lineCount: number;
    replace(from: number, to: number, insert: string): Storage;
    slice(from: number, to: number): string;
    lineAt(offset: number): number;
    offsetAt(line: number): number;
    text(): string;
}
const chunkSize = 2_048;
type Backing = Readonly<{ text: string; lines: readonly number[] }>;
type Payload = Readonly<{ backing: Backing; from: number; length: number; firstLine: number; breaks: number }>;
type Leaf = Readonly<{ kind: "leaf"; payload: Payload; length: number; breaks: number; height: 1 }>;
type Branch = Readonly<{ kind: "branch"; left: Tree; right: Tree; length: number; breaks: number; height: number }>;
type Tree = Leaf | Branch;
type Root = Tree | null;
type Mode = "chunk" | "piece";

function lowerBound(values: readonly number[], target: number): number {
    let low = 0, high = values.length;
    while (low < high) { const middle = (low + high) >>> 1; if (values[middle]! < target) low = middle + 1; else high = middle; }
    return low;
}
function backing(text: string): Backing {
    const lines: number[] = [];
    for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) lines.push(index);
    return Object.freeze({ text, lines: Object.freeze(lines) });
}
function leaf(buffer: Backing, from: number, length: number): Leaf {
    const firstLine = lowerBound(buffer.lines, from), breaks = lowerBound(buffer.lines, from + length) - firstLine;
    return Object.freeze({ kind: "leaf", payload: Object.freeze({ backing: buffer, from, length, firstLine, breaks }), length, breaks, height: 1 });
}
function branch(left: Tree, right: Tree): Branch {
    return Object.freeze({ kind: "branch", left, right, length: left.length + right.length,
        breaks: left.breaks + right.breaks, height: 1 + Math.max(left.height, right.height) });
}
function balanced(left: Tree, right: Tree): Tree {
    if (left.height > right.height + 1) {
        if (left.kind !== "branch") throw new Error("Invalid left height.");
        if (left.left.height >= left.right.height) return branch(left.left, branch(left.right, right));
        if (left.right.kind !== "branch") throw new Error("Invalid left rotation.");
        return branch(branch(left.left, left.right.left), branch(left.right.right, right));
    }
    if (right.height > left.height + 1) {
        if (right.kind !== "branch") throw new Error("Invalid right height.");
        if (right.right.height >= right.left.height) return branch(branch(left, right.left), right.right);
        if (right.left.kind !== "branch") throw new Error("Invalid right rotation.");
        return branch(branch(left, right.left.left), branch(right.left.right, right.right));
    }
    return branch(left, right);
}
function join(left: Root, right: Root): Root {
    if (left === null) return right;
    if (right === null) return left;
    if (left.height > right.height + 1) {
        if (left.kind !== "branch") throw new Error("Invalid tree.");
        return balanced(left.left, join(left.right, right)!);
    }
    if (right.height > left.height + 1) {
        if (right.kind !== "branch") throw new Error("Invalid tree.");
        return balanced(join(left, right.left)!, right.right);
    }
    return branch(left, right);
}
function build(text: string, mode: Mode): Root {
    if (!text.length) return null;
    if (mode === "piece") return leaf(backing(text), 0, text.length);
    const leaves: Tree[] = [];
    for (let offset = 0; offset < text.length; offset += chunkSize) {
        const part = text.slice(offset, offset + chunkSize);
        leaves.push(leaf(backing(part), 0, part.length));
    }
    const assemble = (from: number, to: number): Tree => {
        if (to - from === 1) return leaves[from]!;
        const middle = (from + to) >>> 1; return branch(assemble(from, middle), assemble(middle, to));
    };
    return assemble(0, leaves.length);
}
function split(root: Root, offset: number, mode: Mode): readonly [Root, Root] {
    if (root === null) return [null, null];
    if (offset === 0) return [null, root];
    if (offset === root.length) return [root, null];
    if (root.kind === "leaf") {
        const part = root.payload;
        if (mode === "piece") return [leaf(part.backing, part.from, offset), leaf(part.backing, part.from + offset, part.length - offset)];
        const text = part.backing.text.slice(part.from, part.from + part.length);
        return [build(text.slice(0, offset), mode), build(text.slice(offset), mode)];
    }
    if (offset < root.left.length) {
        const [left, middle] = split(root.left, offset, mode); return [left, join(middle, root.right)];
    }
    const [middle, right] = split(root.right, offset - root.left.length, mode); return [join(root.left, middle), right];
}
function range(length: number, from: number, to = from): void {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > length) throw new RangeError("Invalid UTF-16 range.");
}
function read(root: Root, from: number, to: number, parts: string[]): void {
    if (!root || from === to) return;
    if (root.kind === "leaf") {
        parts.push(root.payload.backing.text.slice(root.payload.from + from, root.payload.from + to)); return;
    }
    const middle = root.left.length;
    if (from < middle) read(root.left, from, Math.min(to, middle), parts);
    if (to > middle) read(root.right, Math.max(0, from - middle), to - middle, parts);
}

/** Persistent AVL rope of bounded string chunks; physical string backing is engine-owned. */
export class ChunkTree implements Storage {
    private readonly root: Root;
    protected readonly mode: Mode;
    constructor(text: string, root?: Root, mode: Mode = "chunk") {
        this.mode = mode; this.root = root === undefined ? build(text, mode) : root; Object.freeze(this);
    }
    get length(): number { return this.root?.length ?? 0; }
    get lineCount(): number { return 1 + (this.root?.breaks ?? 0); }
    replace(from: number, to: number, insert: string): Storage {
        validateTextEdits(this.length, [{ from, to, insert }]);
        if (to - from === insert.length && this.slice(from, to) === insert) return this;
        const [left, rest] = split(this.root, from, this.mode), [, right] = split(rest, to - from, this.mode);
        return new ChunkTree("", join(join(left, build(insert, this.mode)), right));
    }
    slice(from: number, to: number): string { range(this.length, from, to); const parts: string[] = []; read(this.root, from, to, parts); return parts.join(""); }
    text(): string { return this.slice(0, this.length); }
    lineAt(offset: number): number {
        range(this.length, offset);
        let node = this.root, count = 0;
        while (node?.kind === "branch") {
            if (offset < node.left.length) node = node.left;
            else { offset -= node.left.length; count += node.left.breaks; node = node.right; }
        }
        return node ? count + lowerBound(node.payload.backing.lines, node.payload.from + offset) - node.payload.firstLine : count;
    }
    offsetAt(line: number): number {
        if (!Number.isSafeInteger(line) || line < 0 || line >= this.lineCount) throw new RangeError("Invalid line.");
        if (line === 0) return 0;
        let node = this.root!, offset = 0;
        while (node.kind === "branch") {
            if (line <= node.left.breaks) node = node.left;
            else { line -= node.left.breaks; offset += node.left.length; node = node.right; }
        }
        return offset + node.payload.backing.lines[node.payload.firstLine + line - 1]! - node.payload.from + 1;
    }
    /** Deterministic shape checks and logical retention; not an estimate of V8 object sizes. */
    inspect(nodes: Set<object>, buffers: Set<object>): Readonly<{ height: number; length: number; nodes: number }> {
        const visit = (node: Root): void => {
            if (!node || nodes.has(node)) return;
            nodes.add(node);
            if (node.kind === "leaf") { buffers.add(node.payload.backing); return; }
            if (Math.abs(node.left.height - node.right.height) > 1 || node.height !== 1 + Math.max(node.left.height, node.right.height)
                || node.length !== node.left.length + node.right.length || node.breaks !== node.left.breaks + node.right.breaks) throw new Error("Unbalanced or inconsistent tree.");
            visit(node.left); visit(node.right);
        };
        visit(this.root); return Object.freeze({ height: this.root?.height ?? 0, length: this.length, nodes: nodes.size });
    }
}

/** Adapter exercises the actual selected implementation, not a separate piece-tree fallback. */
export class PieceTree implements Storage {
    private readonly buffer: TextBuffer;
    constructor(text: string, buffer = TextBuffer.from(text)) { this.buffer = buffer; Object.freeze(this); }
    get length(): number { return this.buffer.length; }
    get lineCount(): number { return this.buffer.lineCount; }
    replace(from: number, to: number, insert: string): Storage {
        const buffer = this.buffer.replace(from, to, insert); return buffer === this.buffer ? this : new PieceTree("", buffer);
    }
    slice(from: number, to: number): string { return this.buffer.slice(from, to); }
    lineAt(offset: number): number { return this.buffer.lineAt(offset); }
    offsetAt(line: number): number { return this.buffer.offsetAt(line); }
    text(): string { return this.buffer.text(); }
    inspect(_nodes: Set<object>, _buffers: Set<object>) {
        const diagnostics = this.buffer.diagnostics();
        return { ...diagnostics, nodes: diagnostics.retention.nodes };
    }
    static retained(stores: readonly PieceTree[]) { return TextBuffer.retained(stores.map(store => store.buffer)); }
}

const flatLines = new WeakMap<FlatString, readonly number[]>();
export class FlatString implements Storage {
    private readonly value: string;
    constructor(text: string) { this.value = text; Object.freeze(this); }
    get length(): number { return this.value.length; }
    private lines(): readonly number[] {
        let lines = flatLines.get(this);
        if (!lines) { lines = backing(this.value).lines; flatLines.set(this, lines); }
        return lines;
    }
    get lineCount(): number { return 1 + this.lines().length; }
    replace(from: number, to: number, insert: string): Storage {
        validateTextEdits(this.length, [{ from, to, insert }]);
        if (this.value.slice(from, to) === insert) return this;
        return new FlatString(this.value.slice(0, from) + insert + this.value.slice(to));
    }
    slice(from: number, to: number): string { range(this.length, from, to); return this.value.slice(from, to); }
    text(): string { return this.value; }
    lineAt(offset: number): number { range(this.length, offset); return lowerBound(this.lines(), offset); }
    offsetAt(line: number): number {
        if (!Number.isSafeInteger(line) || line < 0 || line >= this.lineCount) throw new RangeError("Invalid line.");
        return line === 0 ? 0 : this.lines()[line - 1]! + 1;
    }
    inspect(nodes: Set<object>, buffers: Set<object>): void { nodes.add(this); buffers.add(this); }
}
export const candidates = Object.freeze({ flat: FlatString, chunk: ChunkTree, piece: PieceTree });
export type Candidate = keyof typeof candidates;

export function retained(stores: readonly Storage[]) {
    const nodes = new Set<object>(), buffers = new Set<object>();
    const selected = stores.filter(store => store instanceof PieceTree);
    const selectedStats = PieceTree.retained(selected);
    for (const store of stores) if (!(store instanceof PieceTree)) (store as ChunkTree | FlatString).inspect(nodes, buffers);
    let textUnits = 0, lineEntries = 0;
    for (const buffer of buffers) {
        if (buffer instanceof FlatString) { textUnits += buffer.length; lineEntries += buffer.lineCount - 1; }
        else { const backing = buffer as Backing; textUnits += backing.text.length; lineEntries += backing.lines.length; }
    }
    return { versions: stores.length, nodes: nodes.size + selectedStats.nodes, backingBuffers: buffers.size + selectedStats.backingBuffers,
        backingTextUnits: textUnits + selectedStats.backingTextUnits, lineEntries: lineEntries + selectedStats.lineEntries, gapEntries: selectedStats.gapEntries };
}
