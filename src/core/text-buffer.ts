import { validateTextEdits } from "./changes.ts";
import type { TextEdit } from "./changes.ts";
import { PositionMap } from "./positions.ts";
import { joinTrees } from "./avl.ts";

type Backing = Readonly<{ text: string; lines: Readonly<Float64Array>; gaps: Readonly<Float64Array>; gapBase: number }>;
type Piece = Readonly<{ backing: Backing; from: number; length: number; firstLine: number; breaks: number }>;
type LineMeasure = Readonly<{ prefix: number; suffix: number; longest: number }>;
type Leaf = LineMeasure & Readonly<{ kind: "leaf"; piece: Piece; length: number; breaks: number; height: 1 }>;
type Branch = LineMeasure & Readonly<{ kind: "branch"; left: Node; right: Node; length: number; breaks: number; height: number }>;
type Node = Leaf | Branch;
type Root = Node | null;
type PairRange = Readonly<{ from: number; to: number; otherFrom: number; otherTo: number }>;
export type BufferChange = Readonly<{ buffer: TextBuffer; mapping: PositionMap; changedUnits: number }>;
export type BufferRetention = Readonly<{ versions: number; nodes: number; backingBuffers: number; backingTextUnits: number; lineEntries: number; gapEntries: number }>;
export type BufferReadMetrics = Readonly<{ textExports: number; sliceUnits: number }>;
const counters = new WeakMap<TextBuffer, { textExports: number; sliceUnits: number }>();

function lowerBound(values: ArrayLike<number>, target: number): number {
    let low = 0, high = values.length;
    while (low < high) { const middle = (low + high) >>> 1; if (values[middle]! < target) low = middle + 1; else high = middle; }
    return low;
}
function piece(backing: Backing, from: number, length: number): Leaf {
    const firstLine = lowerBound(backing.lines, from), breaks = lowerBound(backing.lines, from + length) - firstLine;
    const prefix = breaks ? backing.lines[firstLine]! - from : length;
    const suffix = breaks ? from + length - backing.lines[firstLine + breaks - 1]! - 1 : length;
    let longest = Math.max(prefix, suffix), left = backing.gapBase + firstLine, right = left + Math.max(0, breaks - 1);
    while (left < right) {
        if (left % 2) longest = Math.max(longest, backing.gaps[left++]!);
        if (right % 2) longest = Math.max(longest, backing.gaps[--right]!);
        left = Math.floor(left / 2); right = Math.floor(right / 2);
    }
    return Object.freeze({ kind: "leaf", piece: Object.freeze({ backing, from, length, firstLine, breaks }), length, breaks, height: 1, prefix, suffix, longest });
}
function backing(text: string): Backing {
    const offsets: number[] = [];
    for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) offsets.push(index);
    const lines = new Float64Array(offsets);
    let gapBase = lines.length > 1 ? 1 : 0; while (gapBase < lines.length - 1) gapBase *= 2;
    const gaps = new Float64Array(gapBase * 2);
    for (let index = 0; index + 1 < lines.length; index++) gaps[gapBase + index] = lines[index + 1]! - lines[index]! - 1;
    for (let index = gapBase - 1; index > 0; index--) gaps[index] = Math.max(gaps[index * 2]!, gaps[index * 2 + 1]!);
    // Owned indexes never escape the private root or change after construction. As in
    // other immutable numeric indexes, float64 preserves numeric range without freezing every array entry.
    return Object.freeze({ text, lines, gaps, gapBase });
}
function original(text: string): Root { return text.length ? piece(backing(text), 0, text.length) : null; }
function branch(left: Node, right: Node): Branch {
    return Object.freeze({ kind: "branch", left, right, length: left.length + right.length,
        breaks: left.breaks + right.breaks, height: 1 + Math.max(left.height, right.height),
        prefix: left.breaks ? left.prefix : left.length + right.prefix,
        suffix: right.breaks ? right.suffix : right.length + left.suffix,
        longest: Math.max(left.longest, right.longest, left.suffix + right.prefix) });
}
function join(left: Root, right: Root): Root {
    return joinTrees(left, right, branch);
}
function split(root: Root, offset: number): readonly [Root, Root] {
    if (!root) return [null, null];
    if (offset === 0) return [null, root]; if (offset === root.length) return [root, null];
    if (root.kind === "leaf") {
        const value = root.piece;
        return [piece(value.backing, value.from, offset), piece(value.backing, value.from + offset, value.length - offset)];
    }
    if (offset < root.left.length) {
        const [left, middle] = split(root.left, offset); return [left, join(middle, root.right)];
    }
    const [middle, right] = split(root.right, offset - root.left.length); return [join(root.left, middle), right];
}
function validateRange(length: number, from: number, to = from): void {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > length) throw new RangeError("Invalid UTF-16 range.");
}
/** Walk owned nodes rather than comparing strings. Unshared text ends the proof. */
function* sharedEdge(a: Root, b: Root, side: "start" | "end", range: PairRange): Generator<number> {
    type Span = { node: Node; from: number; to: number };
    const left: Span[] = a && range.from < range.to ? [{ node: a, from: range.from, to: range.to }] : [];
    const right: Span[] = b && range.otherFrom < range.otherTo ? [{ node: b, from: range.otherFrom, to: range.otherTo }] : [];
    const descend = (stack: Span[]) => {
        const span = stack.pop()!; if (span.node.kind !== "branch") throw new Error("Expected a shared-edge branch.");
        const { left: first, right: second } = span.node, split = first.length;
        const before = span.from < split ? { node: first, from: span.from, to: Math.min(span.to, split) } : undefined;
        const after = span.to > split ? { node: second, from: Math.max(0, span.from - split), to: span.to - split } : undefined;
        for (const child of side === "start" ? [after, before] : [before, after]) if (child) stack.push(child);
    };
    const consume = (stack: Span[], length: number) => {
        const span = stack.at(-1)!;
        if (side === "start") span.from += length; else span.to -= length;
        if (span.from === span.to) stack.pop();
    };
    let matched = 0;
    while (left.length && right.length) {
        const x = left.at(-1)!, y = right.at(-1)!, length = Math.min(x.to - x.from, y.to - y.from);
        const xf = side === "start" ? x.from : x.to - length, yf = side === "start" ? y.from : y.to - length;
        const same = x.node === y.node && xf === yf || x.node.kind === "leaf" && y.node.kind === "leaf"
            && x.node.piece.backing === y.node.piece.backing && x.node.piece.from + xf === y.node.piece.from + yf;
        if (same) { matched += length; consume(left, length); consume(right, length); yield matched; }
        else if (x.node.kind === "leaf" && y.node.kind === "leaf") return;
        else if (x.node.kind === "branch" && (y.node.kind === "leaf" || x.node.height >= y.node.height)) descend(left);
        else descend(right);
    }
}
function* pieces(root: Root, from = 0, to = root?.length ?? 0): Generator<Pick<Piece, "backing" | "from" | "length">> {
    if (!root || from === to) return;
    const stack: Node[] = []; let node: Node | undefined = root, remaining = to - from;
    while (node) {
        while (node.kind === "branch") {
            if (from >= node.left.length) { from -= node.left.length; node = node.right; }
            else { stack.push(node.right); node = node.left; }
        }
        const value = node.piece, length = Math.min(remaining, value.length - from);
        yield from === 0 && length === value.length ? value : { backing: value.backing, from: value.from + from, length };
        remaining -= length; if (!remaining) return;
        node = stack.pop(); from = 0;
    }
}
function* ranges(root: Root, from: number, to: number): Generator<string> {
    if (!root || from === to) return;
    if (root.kind === "leaf") { yield root.piece.backing.text.slice(root.piece.from + from, root.piece.from + to); return; }
    for (const value of pieces(root, from, to)) yield value.backing.text.slice(value.from, value.from + value.length);
}

/** Consume sorted original-coordinate ranges once, retaining untouched subtrees as whole nodes. */
function batch(root: Root, edits: readonly TextEdit[]): Root {
    const capacity = 65_536, additions: Backing[] = []; let strings: string[] = [], stringUnits = 0;
    const flushStrings = () => { if (strings.length) additions.push(backing(strings.length === 1 ? strings[0]! : strings.join(""))); strings = []; stringUnits = 0; };
    for (const edit of edits) {
        if (!edit.insert.length) continue;
        if (stringUnits + edit.insert.length > capacity) flushStrings();
        if (edit.insert.length > capacity) additions.push(backing(edit.insert));
        else { strings.push(edit.insert); stringUnits += edit.insert.length; }
    }
    flushStrings();
    const pending: Node[] = [], forest: Node[] = [];
    let node: Node | undefined = root ?? undefined, position = 0, leafOffset = 0, insertionOffset = 0, insertionBacking = 0;
    const appendTree = (value: Node) => {
        while (forest.length && forest.at(-1)!.height <= value.height) value = join(forest.pop()!, value)!;
        forest.push(value);
    };
    const parts: string[] = []; let fragments = 0, fragmentUnits = 0;
    let firstBacking: Backing | undefined, firstFrom = 0, firstLength = 0, firstNode: Leaf | undefined;
    const flushFragments = () => {
        if (fragments === 1) appendTree(firstNode ?? piece(firstBacking!, firstFrom, firstLength));
        else if (fragments) appendTree(original(parts.join(""))!);
        parts.length = 0; fragments = 0; fragmentUnits = 0; firstBacking = undefined; firstNode = undefined;
    };
    const appendPiece = (value: Backing, from: number, length: number, reuse?: Leaf) => {
        if (length > 64) { flushFragments(); appendTree(reuse ?? piece(value, from, length)); return; }
        if (fragmentUnits + length > capacity) flushFragments();
        if (!fragments) { firstBacking = value; firstFrom = from; firstLength = length; firstNode = reuse; }
        else {
            if (fragments === 1) parts.push(firstBacking!.text.slice(firstFrom, firstFrom + firstLength));
            parts.push(value.text.slice(from, from + length));
        }
        fragments++; fragmentUnits += length;
    };
    const consume = (until: number, keep: boolean) => {
        while (position < until && node) {
            if (node.kind === "branch") {
                if (node.length <= until - position) { if (keep) { flushFragments(); appendTree(node); } position += node.length; node = pending.pop(); }
                else { pending.push(node.right); node = node.left; }
            } else {
                const length = Math.min(until - position, node.length - leafOffset), value = node.piece;
                if (keep) appendPiece(value.backing, value.from + leafOffset, length, leafOffset === 0 && length === node.length ? node : undefined);
                position += length; leafOffset += length;
                if (leafOffset === node.length) { leafOffset = 0; node = pending.pop(); }
            }
        }
    };
    for (const edit of edits) {
        consume(edit.from, true); consume(edit.to, false);
        if (edit.insert.length) {
            const value = additions[insertionBacking]!; appendPiece(value, insertionOffset, edit.insert.length); insertionOffset += edit.insert.length;
            if (insertionOffset === value.text.length) { insertionOffset = 0; insertionBacking++; }
        }
    }
    consume(root?.length ?? 0, true);
    flushFragments();
    let result: Root = null;
    for (let index = forest.length - 1; index >= 0; index--) result = join(forest[index]!, result);
    return result;
}

/** Immutable persistent piece tree. Lines are LF-indexed; raw UTF-16, including CRLF, is preserved. */
export class TextBuffer {
    readonly #root: Root;
    private constructor(root: Root) { this.#root = root; counters.set(this, { textExports: 0, sliceUnits: 0 }); Object.freeze(this); }
    static from(text: string): TextBuffer {
        if (typeof text !== "string") throw new TypeError("Text must be a string.");
        return new TextBuffer(original(text));
    }
    get length(): number { return this.#root?.length ?? 0; }
    get lineCount(): number { return 1 + (this.#root?.breaks ?? 0); }
    /** Longest LF-delimited line in raw UTF-16 units. No document export or line scan. */
    get longestLineLength(): number { return this.#root?.longest ?? 0; }
    slice(from: number, to: number): string {
        validateRange(this.length, from, to); counters.get(this)!.sliceUnits += to - from;
        return [...ranges(this.#root, from, to)].join("");
    }
    chunks(from = 0, to = this.length): Iterable<string> { validateRange(this.length, from, to); return ranges(this.#root, from, to); }
    /** Explicit whole-text export. Document/viewport subscribers should use ranges and line indexes. */
    text(): string { counters.get(this)!.textExports++; return [...ranges(this.#root, 0, this.length)].join(""); }
    replace(from: number, to: number, insert: string): TextBuffer { return this.apply([{ from, to, insert }]).buffer; }
    apply(edits: readonly TextEdit[]): BufferChange {
        validateTextEdits(this.length, edits);
        const effective = edits.filter(edit => edit.to - edit.from !== edit.insert.length || this.slice(edit.from, edit.to) !== edit.insert);
        const mapping = new PositionMap(this.length, effective);
        if (!effective.length) return Object.freeze({ buffer: this, mapping, changedUnits: 0 });
        let root: Root;
        if (effective.length === 1) {
            const edit = effective[0]!, [left, rest] = split(this.#root, edit.from), [, right] = split(rest, edit.to - edit.from);
            root = join(join(left, original(edit.insert)), right);
        } else root = batch(this.#root, effective);
        const buffer = new TextBuffer(root);
        if (effective.length > 1 && buffer.equals(this)) return Object.freeze({ buffer: this, mapping: new PositionMap(this.length, []), changedUnits: 0 });
        return Object.freeze({ buffer, mapping, changedUnits: effective.reduce((sum, edit) => sum + edit.to - edit.from + edit.insert.length, 0) });
    }
    lineAt(offset: number): number {
        validateRange(this.length, offset); let node = this.#root, count = 0;
        while (node?.kind === "branch") {
            if (offset < node.left.length) node = node.left;
            else { offset -= node.left.length; count += node.left.breaks; node = node.right; }
        }
        return node ? count + lowerBound(node.piece.backing.lines, node.piece.from + offset) - node.piece.firstLine : count;
    }
    offsetAt(line: number): number {
        if (!Number.isSafeInteger(line) || line < 0 || line >= this.lineCount) throw new RangeError("Invalid line.");
        if (line === 0) return 0;
        let node = this.#root!, offset = 0;
        while (node.kind === "branch") {
            if (line <= node.left.breaks) node = node.left;
            else { line -= node.left.breaks; offset += node.left.length; node = node.right; }
        }
        return offset + node.piece.backing.lines[node.piece.firstLine + line - 1]! - node.piece.from + 1;
    }
    /** Cumulative equal edge lengths proved only by immutable node/backing identity.
     * Each advance visits bounded tree paths; unrelated but equal text may prove no span.
     * Ranges use raw UTF-16. Iteration retains captures until it ends or is closed.
     */
    sharedEdge(other: TextBuffer, side: "start" | "end", range: PairRange = { from: 0, to: this.length, otherFrom: 0, otherTo: other.length }): Iterable<number> {
        if (side !== "start" && side !== "end") throw new RangeError("Invalid shared edge.");
        validateRange(this.length, range.from, range.to); validateRange(other.length, range.otherFrom, range.otherTo);
        return sharedEdge(this.#root, other.#root, side, { ...range });
    }
    /** Exact equality skips shared backing ranges; differing unrelated buffers can require a linear comparison. */
    equals(other: TextBuffer): boolean {
        if (this.#root === other.#root) return true;
        if (this.length !== other.length || this.lineCount !== other.lineCount) return false;
        const a = pieces(this.#root), b = pieces(other.#root);
        let left = a.next(), right = b.next(), leftOffset = 0, rightOffset = 0;
        while (!left.done && !right.done) {
            const length = Math.min(left.value.length - leftOffset, right.value.length - rightOffset);
            const leftFrom = left.value.from + leftOffset, rightFrom = right.value.from + rightOffset;
            if ((left.value.backing !== right.value.backing || leftFrom !== rightFrom)
                && left.value.backing.text.slice(leftFrom, leftFrom + length) !== right.value.backing.text.slice(rightFrom, rightFrom + length)) return false;
            leftOffset += length; rightOffset += length;
            if (leftOffset === left.value.length) { left = a.next(); leftOffset = 0; }
            if (rightOffset === right.value.length) { right = b.next(); rightOffset = 0; }
        }
        return left.done === right.done;
    }
    /** Constant-work counters for routine telemetry. Full retention diagnostics traverse the tree. */
    readMetrics(): BufferReadMetrics { return Object.freeze({ ...counters.get(this)! }); }
    diagnostics(): Readonly<{ length: number; lineCount: number; height: number; textExports: number; sliceUnits: number; retention: BufferRetention }> {
        return Object.freeze({ length: this.length, lineCount: this.lineCount, height: this.#root?.height ?? 0,
            ...counters.get(this)!, retention: TextBuffer.retained([this]) });
    }
    /** Counts structural sharing without exposing roots, deleted text or backing buffers. */
    static retained(versions: readonly TextBuffer[]): BufferRetention {
        const nodes = new Set<Node>(), buffers = new Set<Backing>();
        const visit = (node: Root): void => {
            if (!node || nodes.has(node)) return;
            nodes.add(node);
            if (node.kind === "leaf") { buffers.add(node.piece.backing); return; }
            if (Math.abs(node.left.height - node.right.height) > 1 || node.height !== 1 + Math.max(node.left.height, node.right.height)
                || node.length !== node.left.length + node.right.length || node.breaks !== node.left.breaks + node.right.breaks
                || node.prefix !== (node.left.breaks ? node.left.prefix : node.left.length + node.right.prefix)
                || node.suffix !== (node.right.breaks ? node.right.suffix : node.right.length + node.left.suffix)
                || node.longest !== Math.max(node.left.longest, node.right.longest, node.left.suffix + node.right.prefix)) throw new Error("Inconsistent text tree.");
            visit(node.left); visit(node.right);
        };
        versions.forEach(version => visit(version.#root));
        let backingTextUnits = 0, lineEntries = 0, gapEntries = 0;
        buffers.forEach(buffer => { backingTextUnits += buffer.text.length; lineEntries += buffer.lines.length; gapEntries += buffer.gaps.length; });
        return Object.freeze({ versions: versions.length, nodes: nodes.size, backingBuffers: buffers.size, backingTextUnits, lineEntries, gapEntries });
    }
}
