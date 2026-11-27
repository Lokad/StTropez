import { invalidState, invalidRange, isIndex, isNonNegativeInteger, isOffsetRange } from "./bounds.ts";
import { changedTextEdits } from "./changes.ts";
import type { TextEdit } from "./changes.ts";
import { PositionMap } from "./positions.ts";
import { lineContentEnd } from "./newlines.ts";
import { joinTrees } from "./avl.ts";
import { partitionPoint } from "./bound-search.ts";

type LineIndex = Readonly<Uint32Array | Float64Array>;
type Backing = Readonly<{ text: string; lines: LineIndex; gaps: LineIndex }>;
type LineMeasure = Readonly<{ prefix: number; suffix: number; longest: number }>;
type Leaf = LineMeasure & Readonly<{
    kind: "leaf"; backing: Backing; from: number; length: number; firstLine: number; breaks: number; height: 1;
}>;
type Branch = LineMeasure & Readonly<{ kind: "branch"; left: Node; right: Node; length: number; breaks: number; height: number }>;
type Node = Leaf | Branch;
type Root = Node | null;
type PairRange = Readonly<{ from: number; to: number; otherFrom: number; otherTo: number }>;
export type BufferChange = Readonly<{ buffer: TextBuffer; mapping: PositionMap; changedUnits: number }>;
export type BufferRetention = Readonly<{ versions: number; nodes: number; backingBuffers: number; backingTextUnits: number; lineEntries: number; gapEntries: number }>;
const smallPieceUnits = 64;

function lowerBound(values: ArrayLike<number>, target: number): number {
    return partitionPoint(values.length, index => values[index]! < target);
}
/** Only internal maxima need storage. A leaf spans two consecutive newline offsets. */
function gapAt({ lines, gaps }: Backing, index: number): number {
    const line = index - gaps.length;
    return line < 0 ? gaps[index]! : lines[line + 1]! - lines[line]! - 1;
}
function piece(backing: Backing, from: number, length: number): Leaf {
    const firstLine = lowerBound(backing.lines, from), breaks = lowerBound(backing.lines, from + length) - firstLine;
    const prefix = breaks ? backing.lines[firstLine]! - from : length;
    const suffix = breaks ? from + length - backing.lines[firstLine + breaks - 1]! - 1 : length;
    let longest = Math.max(prefix, suffix);
    let left = backing.gaps.length + firstLine;
    let right = left + breaks - 1;
    while (left < right) {
        if (left % 2) longest = Math.max(longest, gapAt(backing, left++));
        if (right % 2) longest = Math.max(longest, gapAt(backing, --right));
        left = Math.floor(left / 2); right = Math.floor(right / 2);
    }
    return { kind: "leaf", backing, from, length, firstLine, breaks, height: 1, prefix, suffix, longest };
}
function backing(text: string): Backing {
    let count = 0;
    for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count++;
    // Offsets and gaps are bounded by this backing's length, not the whole tree's length.
    // Keep a wider fallback rather than assuming an engine-specific string length limit.
    const Index = text.length <= 0xffff_ffff ? Uint32Array : Float64Array, lines = new Index(count);
    let line = 0;
    for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) lines[line++] = index;
    const gaps = new Index(Math.max(0, count - 1));
    const value = { text, lines, gaps };
    for (let index = gaps.length - 1; index > 0; index--) {
        gaps[index] = Math.max(gapAt(value, index * 2), gapAt(value, index * 2 + 1));
    }
    return value;
}
function original(text: string): Root { return text.length ? piece(backing(text), 0, text.length) : null; }
function branch(left: Node, right: Node): Branch {
    return { kind: "branch", left, right, length: left.length + right.length,
        breaks: left.breaks + right.breaks, height: 1 + Math.max(left.height, right.height),
        prefix: left.breaks ? left.prefix : left.length + right.prefix,
        suffix: right.breaks ? right.suffix : right.length + left.suffix,
        longest: Math.max(left.longest, right.longest, left.suffix + right.prefix) };
}
function join(left: Root, right: Root): Root {
    return joinTrees(left, right, branch);
}
function split(root: Root, offset: number): readonly [Root, Root] {
    if (!root) return [null, null];
    if (offset === 0) return [null, root]; if (offset === root.length) return [root, null];
    if (root.kind === "leaf") {
        return [piece(root.backing, root.from, offset), piece(root.backing, root.from + offset, root.length - offset)];
    }
    if (offset < root.left.length) {
        const [left, middle] = split(root.left, offset); return [left, join(middle, root.right)];
    }
    const [middle, right] = split(root.right, offset - root.left.length); return [join(root.left, middle), right];
}
function leafText(leaf: Leaf | null): string {
    return leaf ? leaf.backing.text.slice(leaf.from, leaf.from + leaf.length) : "";
}
/** Pack only the edited seam; immutable large ranges and all other subtrees stay shared. */
function joinEdit(left: Root, insert: string, right: Root): Root {
    if (insert.length <= smallPieceUnits) {
        let before = left, after = right;
        while (before?.kind === "branch") before = before.right;
        while (after?.kind === "branch") after = after.left;
        const prefix = before && before.length <= smallPieceUnits ? before : null;
        const suffix = after && after.length <= smallPieceUnits ? after : null;
        // Do not copy a singleton surviving deletion. At most two existing small pieces join the insertion.
        if (Number(!!prefix) + Number(!!insert.length) + Number(!!suffix) > 1) {
            insert = leafText(prefix) + insert + leafText(suffix);
            if (prefix) [left] = split(left, left!.length - prefix.length);
            if (suffix) [, right] = split(right, suffix.length);
        }
    }
    return join(join(left, original(insert)), right);
}
function validateRange(length: number, from: number, to = from): void {
    if (!isOffsetRange(from, to, length)) invalidRange("UTF-16 range");
}
/** Walk owned nodes rather than comparing strings. Unshared text ends the proof. */
function* sharedEdge(a: Root, b: Root, side: "start" | "end", range: PairRange): Generator<number> {
    type Span = { node: Node; from: number; to: number };
    const left: Span[] = a && range.from < range.to ? [{ node: a, from: range.from, to: range.to }] : [];
    const right: Span[] = b && range.otherFrom < range.otherTo ? [{ node: b, from: range.otherFrom, to: range.otherTo }] : [];
    const descend = (stack: Span[]) => {
        const span = stack.pop()!; if (span.node.kind !== "branch") invalidState("tree branch");
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
            && x.node.backing === y.node.backing && x.node.from + xf === y.node.from + yf;
        if (same) { matched += length; consume(left, length); consume(right, length); }
        else if (x.node.kind === "leaf" && y.node.kind === "leaf") { yield matched; return; }
        else if (x.node.kind === "branch" && (y.node.kind === "leaf" || x.node.height >= y.node.height)) descend(left);
        else descend(right);
        yield matched;
    }
}
function* pieces(root: Root, from = 0, to = root?.length ?? 0): Generator<Pick<Leaf, "backing" | "from" | "length">> {
    if (!root || from === to) return;
    const stack: Node[] = []; let node: Node | undefined = root, remaining = to - from;
    while (node) {
        while (node.kind === "branch") {
            if (from >= node.left.length) { from -= node.left.length; node = node.right; }
            else { stack.push(node.right); node = node.left; }
        }
        const length = Math.min(remaining, node.length - from);
        yield from === 0 && length === node.length ? node : { backing: node.backing, from: node.from + from, length };
        remaining -= length; if (!remaining) return;
        node = stack.pop(); from = 0;
    }
}
function* ranges(root: Root, from: number, to: number): Generator<string> {
    if (!root || from === to) return;
    if (root.kind === "leaf") { yield root.backing.text.slice(root.from + from, root.from + to); return; }
    for (const value of pieces(root, from, to)) yield value.backing.text.slice(value.from, value.from + value.length);
}
function rangeText(root: Root, from: number, to: number): string {
    if (!root || from === to) return "";
    if (root.kind === "leaf") return root.backing.text.slice(root.from + from, root.from + to);
    return [...ranges(root, from, to)].join("");
}

/** Consume sorted original-coordinate ranges once, retaining untouched subtrees as whole nodes. */
function batch(root: Root, edits: readonly TextEdit[]): Root {
    const capacity = 65_536;
    const pending: Node[] = [], forest: Node[] = [];
    let node: Node | undefined = root ?? undefined, position = 0, leafOffset = 0;
    const appendTree = (value: Node) => {
        while (forest.length && forest.at(-1)!.height <= value.height) value = join(forest.pop()!, value)!;
        forest.push(value);
    };

    // Isolated insertions share a backing, even with retained subtrees between them.
    const inserts: string[] = [], output: (Node | number)[] = [];
    let insertedUnits = 0;
    const flushInserts = () => {
        const value = backing(inserts.join(""));
        let from = 0;
        for (const item of output) {
            if (typeof item === "number") {
                appendTree(piece(value, from, item - from));
                from = item;
            } else appendTree(item);
        }
        inserts.length = 0;
        output.length = 0;
        insertedUnits = 0;
    };
    const emit = (value: Node | string) => {
        if (typeof value === "string") {
            if (insertedUnits && insertedUnits + value.length > capacity) flushInserts();
            inserts.push(value);
            insertedUnits += value.length;
            output.push(insertedUnits);
        } else if (insertedUnits) output.push(value);
        else appendTree(value);
    };

    // Adjacent short fragments form their own backing. A lone source fragment stays shared.
    const parts: string[] = [];
    let units = 0, singleSource: Leaf | undefined;
    const endRun = (next?: string | Node) => {
        if (units) emit(parts.length === 1 ? singleSource ?? parts[0]! : original(parts.join(""))!);
        parts.length = 0;
        units = 0;
        singleSource = undefined;
        if (next) emit(next);
    };
    const retainedLeaf = (source: Leaf, from: number, length: number) =>
        length === source.length ? source : piece(source.backing, from, length);
    const appendText = (text: string, source?: Leaf, offset = 0) => {
        if (units + text.length > capacity) endRun();
        if (!units && source) {
            singleSource = retainedLeaf(source, offset, text.length);
        }
        parts.push(text);
        units += text.length;
    };
    const keepLeaf = (leaf: Leaf, offset: number, length: number) => {
        const from = leaf.from + offset;
        if (length > smallPieceUnits) {
            endRun(retainedLeaf(leaf, from, length));
        } else appendText(leaf.backing.text.slice(from, from + length), leaf, from);
    };
    const consume = (until: number, keep: boolean) => {
        while (position < until && node) {
            if (node.kind === "branch") {
                if (node.length <= until - position) {
                    if (keep) endRun(node);
                    position += node.length;
                    node = pending.pop();
                } else {
                    pending.push(node.right);
                    node = node.left;
                }
            } else {
                const length = Math.min(until - position, node.length - leafOffset);
                if (keep) keepLeaf(node, leafOffset, length);
                position += length;
                leafOffset += length;
                if (leafOffset === node.length) {
                    leafOffset = 0;
                    node = pending.pop();
                }
            }
        }
    };
    for (const edit of edits) {
        consume(edit.from, true);
        consume(edit.to, false);
        if (edit.insert.length > smallPieceUnits) endRun(edit.insert);
        else if (edit.insert.length) appendText(edit.insert);
    }
    consume(root?.length ?? 0, true);
    endRun();
    if (insertedUnits) flushInserts();
    let result: Root = null;
    while (forest.length) result = join(forest.pop()!, result);
    return result;
}

export type BufferPosition = Readonly<{ line: number; column: number }>;
export type BufferLine = Readonly<{ from: number; to: number; text: string }>;

/** Immutable persistent piece tree. Lines are LF-indexed; raw UTF-16, including CRLF, is preserved. */
export class TextBuffer {
    readonly #root: Root;
    private constructor(root: Root) { this.#root = root; Object.freeze(this); }
    static from(text: string): TextBuffer {
        return new TextBuffer(original(text));
    }
    get length(): number { return this.#root?.length ?? 0; }
    get lineCount(): number { return 1 + (this.#root?.breaks ?? 0); }
    /** Longest LF-delimited line in raw UTF-16 units. No document export or line scan. */
    get longestLineLength(): number { return this.#root?.longest ?? 0; }
    slice(from: number, to: number): string {
        validateRange(this.length, from, to);
        return rangeText(this.#root, from, to);
    }
    chunks(from = 0, to = this.length): Iterable<string> { validateRange(this.length, from, to); return ranges(this.#root, from, to); }
    /** Explicit whole-text export. Document/viewport subscribers should use ranges and line indexes. */
    text(): string { return rangeText(this.#root, 0, this.length); }
    replace(from: number, to: number, insert: string): TextBuffer { return this.apply([{ from, to, insert }]).buffer; }
    apply(edits: readonly TextEdit[]): BufferChange {
        const effective = changedTextEdits(this, edits);
        const mapping = new PositionMap(this.length, effective);
        let buffer: TextBuffer = this;
        if (effective.length === 1) {
            const edit = effective[0]!;
            const [left, rest] = split(this.#root, edit.from);
            const [, right] = split(rest, edit.to - edit.from);
            buffer = new TextBuffer(joinEdit(left, edit.insert, right));
        } else if (effective.length > 1) {
            buffer = new TextBuffer(batch(this.#root, effective));
            if (buffer.equals(this)) return this.apply([]);
        }
        return Object.freeze({ buffer, mapping, changedUnits: effective.reduce((sum, edit) => sum + edit.to - edit.from + edit.insert.length, 0) });
    }
    lineAt(offset: number): number {
        validateRange(this.length, offset); let node = this.#root, count = 0;
        while (node?.kind === "branch") {
            if (offset < node.left.length) node = node.left;
            else { offset -= node.left.length; count += node.left.breaks; node = node.right; }
        }
        return node ? count + lowerBound(node.backing.lines, node.from + offset) - node.firstLine : count;
    }
    line(index: number): BufferLine {
        const from = this.offsetAt(index), to = lineContentEnd(this, index), buffer = this;
        return Object.freeze({ from, to, get text() { return buffer.slice(from, to); } });
    }
    positionAt(offset: number): BufferPosition {
        const line = this.lineAt(offset), start = this.offsetAt(line);
        return Object.freeze({ line, column: Math.min(offset, lineContentEnd(this, line)) - start });
    }
    offsetAt(position: number | BufferPosition): number {
        if (typeof position !== "number") {
            if (!position || !Number.isSafeInteger(position.line) || !isNonNegativeInteger(position.column))
                invalidRange("line or column");
            const start = this.offsetAt(position.line);
            return Math.min(start + position.column, lineContentEnd(this, position.line));
        }
        let line = position;
        if (!isIndex(line, this.lineCount)) invalidRange("line");
        if (line === 0) return 0;
        let node = this.#root!, offset = 0;
        while (node.kind === "branch") {
            if (line <= node.left.breaks) node = node.left;
            else { line -= node.left.breaks; offset += node.left.length; node = node.right; }
        }
        return offset + node.backing.lines[node.firstLine + line - 1]! - node.from + 1;
    }
    /** Cumulative equal edge lengths proved only by immutable node/backing identity.
     * Each yield charges one node-pair decision: a proof, branch descent or unproved leaf.
     * Lengths are nondecreasing, including repeated zeroes; equal text may prove no span.
     * Ranges use raw UTF-16. Iteration retains captures until it ends or is closed.
     */
    sharedEdge(other: TextBuffer, side: "start" | "end", range: PairRange = { from: 0, to: this.length, otherFrom: 0, otherTo: other.length }): Iterable<number> {
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
    diagnostics(): Readonly<{ length: number; lineCount: number; height: number; retention: BufferRetention }> {
        return Object.freeze({ length: this.length, lineCount: this.lineCount, height: this.#root?.height ?? 0,
            retention: TextBuffer.retained([this]) });
    }
    /** Counts structural sharing without exposing roots, deleted text or backing buffers. */
    static retained(versions: readonly TextBuffer[]): BufferRetention {
        const nodes = new Set<Node>(), buffers = new Set<Backing>();
        const visit = (node: Root): void => {
            if (!node || nodes.has(node)) return;
            nodes.add(node);
            if (node.kind === "leaf") { buffers.add(node.backing); return; }
            if (Math.abs(node.left.height - node.right.height) > 1 || node.height !== 1 + Math.max(node.left.height, node.right.height)
                || node.length !== node.left.length + node.right.length || node.breaks !== node.left.breaks + node.right.breaks
                || node.prefix !== (node.left.breaks ? node.left.prefix : node.left.length + node.right.prefix)
                || node.suffix !== (node.right.breaks ? node.right.suffix : node.right.length + node.left.suffix)
                || node.longest !== Math.max(node.left.longest, node.right.longest, node.left.suffix + node.right.prefix)) invalidState("tree measurements");
            visit(node.left); visit(node.right);
        };
        versions.forEach(version => visit(version.#root));
        let backingTextUnits = 0, lineEntries = 0, gapEntries = 0;
        buffers.forEach(buffer => { backingTextUnits += buffer.text.length; lineEntries += buffer.lines.length; gapEntries += buffer.gaps.length; });
        return Object.freeze({ versions: versions.length, nodes: nodes.size, backingBuffers: buffers.size, backingTextUnits, lineEntries, gapEntries });
    }
}
