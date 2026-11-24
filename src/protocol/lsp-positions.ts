import { emptyList } from "../core/empty-list.ts";
import { isLspUint } from "./wire.ts";
import type { TextBuffer } from "../core/text-buffer.ts";
import { BufferChangeCursor } from "../core/buffer-change.ts";
import { partitionPoint } from "../core/bound-search.ts";
import type { TextEdit } from "../core/changes.ts";

export type LspPosition = Readonly<{ line: number; character: number }>;
export type LspRange = Readonly<{ start: LspPosition; end: LspPosition }>;
export type LspTextChange = Readonly<{ range: LspRange; text: string }>;
export type LspCooperate = () => Promise<void>;
/** Share a time slice across scan checkpoints, even when the supplied clock stands still. */
export function cooperateDuringScan(check: () => void, pause: () => Promise<void>, now: () => number = Date.now): LspCooperate {
    let started = now(), checkpoints = 0;
    return async () => {
        check();
        if (++checkpoints < 32 && now() - started < 4) return;
        await pause();
        check();
        started = now(); checkpoints = 0;
    };
}
export type LspChangeHint = Readonly<{ before: TextBuffer; edits: readonly TextEdit[] }>;
type Span = { from: number; to: number; insertFrom: number; insertTo: number };
const chunkUnits = 16384;
function lowerBound(values: Uint32Array, key: number): number {
    return partitionPoint(values.length, index => values[index]! < key);
}
function interior(buffer: TextBuffer, offset: number): boolean {
    return offset > 0 && offset < buffer.length && buffer.slice(offset - 1, offset + 1) === "\r\n";
}
async function scan(buffer: TextBuffer, from: number, to: number, cooperate: LspCooperate): Promise<Uint32Array> {
    const bare: number[] = [];
    for (let at = from; at < to;) {
        const end = Math.min(to, at + chunkUnits), text = buffer.slice(at, Math.min(buffer.length, end + 1));
        for (let i = 0; i < end - at; i++) if (text.charCodeAt(i) === 13 && text.charCodeAt(i + 1) !== 10) bare.push(at + i);
        at = end; if (at < to) await cooperate();
    }
    return Uint32Array.from(bare);
}
async function replacement(before: TextBuffer, after: TextBuffer, cooperate: LspCooperate) {
    const cursor = new BufferChangeCursor(before, after); let from = 0, to = 0, end = 0;
    try { for (;;) { const step = cursor.next(); if (step.status === "ready") {
                const span = step.result!; from = Math.max(0, span.from - 1); to = Math.min(before.length, span.to + 1); end = span.insertTo + to - span.to; break;
            } await cooperate(); } } finally { cursor.dispose(); }
    if (interior(before, from) || interior(after, from)) from--;
    if (interior(before, to) || interior(after, end)) { to++; end++; }
    return { from, to, insertFrom: from, insertTo: end };
}
async function spans(before: TextBuffer, after: TextBuffer, cooperate: LspCooperate, hint?: LspChangeHint): Promise<readonly Span[]> {
    const changes = hint?.before === before ? hint.edits : undefined;
    if (changes) {
        const result: Span[] = []; let delta = 0, oldEnd = 0, newEnd = 0, work = 0;
        const shared = async (to: number, otherTo: number) => {
            if (to - oldEnd !== otherTo - newEnd) return false;
            let count = 0;
            for (const length of before.sharedEdge(after, "start", { from: oldEnd, to, otherFrom: newEnd, otherTo })) {
                count = length; if (++work % 64 === 0) await cooperate();
            }
            if (count === to - oldEnd) return true;
            // Batch storage may repack short unchanged fragments. Compare only a bounded
            // remainder; unrelated or heavily fragmented large gaps retain the hull fallback.
            return to - oldEnd - count <= 64 && before.slice(oldEnd + count, to) === after.slice(newEnd + count, otherTo);
        };
        let valid = true;
        for (const change of changes) {
            if (!Number.isSafeInteger(change.from) || !Number.isSafeInteger(change.to) || change.from < oldEnd
                || change.to < change.from || change.to > before.length || typeof change.insert !== "string") { valid = false; break; }
            const insertFrom = change.from + delta, insertTo = insertFrom + change.insert.length;
            if (insertTo > after.length) { valid = false; break; }
            if (!await shared(change.from, insertFrom)) { valid = false; break; }
            // Merge close ranges before expansion, so boundary reads cannot cross another edit.
            const prior = result.at(-1);
            if (prior && change.from - prior.to <= 4) { prior.to = change.to; prior.insertTo = insertTo; }
            else result.push({ from: change.from, to: change.to, insertFrom, insertTo });
            oldEnd = change.to; newEnd = insertTo; delta = insertTo - change.to;
            if (++work % 64 === 0) await cooperate();
        }
        if (valid && await shared(before.length, after.length)) {
            for (const span of result) {
                if (span.from > 0) { span.from--; span.insertFrom--; }
                if (span.to < before.length) { span.to++; span.insertTo++; }
                if (interior(before, span.from) || interior(after, span.insertFrom)) { span.from--; span.insertFrom--; }
                if (interior(before, span.to) || interior(after, span.insertTo)) { span.to++; span.insertTo++; }
                if (++work % 64 === 0) await cooperate();
            }
            return result;
        }
    }
    return [await replacement(before, after, cooperate)];
}
function textChange(before: LspLineIndex, after: TextBuffer, span: Span): LspTextChange {
    return Object.freeze({ range: Object.freeze({ start: before.at(span.from), end: before.at(span.to) }), text: after.slice(span.insertFrom, span.insertTo) });
}
async function wireChanges(before: LspLineIndex, after: TextBuffer, planned: readonly Span[], cooperate: LspCooperate): Promise<readonly LspTextChange[]> {
    const changes: LspTextChange[] = [];
    for (let i = planned.length - 1; i >= 0; i--) {
        changes.push(textChange(before, after, planned[i]!)); if (changes.length % 64 === 0) await cooperate();
    }
    return Object.freeze(changes);
}
/** Build the wire delta from its actual sent base without rebuilding an already prepared index. */
export async function lspTextChanges(before: LspLineIndex, after: TextBuffer, cooperate: LspCooperate, hint?: LspChangeHint): Promise<readonly LspTextChange[]> {
    if (after === before.buffer) return emptyList;
    return wireChanges(before, after, await spans(before.buffer, after, cooperate, hint), cooperate);
}

/** Reuses the buffer's LF index and retains only additional bare-CR positions. Source text is unchanged. */
export class LspLineIndex {
    readonly buffer: TextBuffer;
    private readonly bare: Uint32Array;
    private constructor(buffer: TextBuffer, bare: Uint32Array) { this.buffer = buffer; this.bare = bare; Object.freeze(this); }
    static async create(buffer: TextBuffer, cooperate: LspCooperate): Promise<LspLineIndex> {
        if (!isLspUint(buffer.length)) throw new RangeError("Document exceeds LSP position limits.");
        return new LspLineIndex(buffer, await scan(buffer, 0, buffer.length, cooperate));
    }
    get lineCount(): number { return this.buffer.lineCount + this.bare.length; }
    private start(line: number): number {
        if (line === 0) return 0;
        const lf = this.buffer.lineCount - 1; let low = Math.max(0, line - this.bare.length), high = Math.min(line, lf);
        // Select the line-th delimiter in the two sorted indexes without building another LF array.
        while (low <= high) {
            const left = (low + high) >>> 1, right = line - left;
            const a = left ? this.buffer.offsetAt(left) : -Infinity, b = right ? this.bare[right - 1]! + 1 : -Infinity;
            const nextA = left < lf ? this.buffer.offsetAt(left + 1) : Infinity, nextB = right < this.bare.length ? this.bare[right]! + 1 : Infinity;
            if (a > nextB) high = left - 1; else if (b > nextA) low = left + 1; else return Math.max(a, b);
        }
        throw new RangeError("Invalid LSP line.");
    }
    at(offset: number): LspPosition {
        if (!isLspUint(offset) || offset > this.buffer.length || interior(this.buffer, offset)) throw new RangeError("Offset is outside text or inside a CRLF pair.");
        const line = this.buffer.lineAt(offset), cr = lowerBound(this.bare, offset), start = Math.max(this.buffer.offsetAt(line), cr ? this.bare[cr - 1]! + 1 : 0);
        return Object.freeze({ line: line + cr, character: offset - start });
    }
    offsetAt(position: LspPosition): number {
        if (!position || !isLspUint(position.line) || !isLspUint(position.character)) throw new RangeError("Invalid UTF-16 LSP position.");
        if (position.line >= this.lineCount) return this.buffer.length;
        const from = this.start(position.line); let to = this.buffer.length;
        if (position.line + 1 < this.lineCount) { const next = this.start(position.line + 1);
            to = next - (next >= 2 && this.buffer.slice(next - 2, next) === "\r\n" ? 2 : 1); }
        return Math.min(from + position.character, to);
    }
    /** Proven batch ranges or shared-edge fallback, expanded to preserve newline/CR classification. */
    async change(after: TextBuffer, cooperate: LspCooperate, hint?: LspChangeHint): Promise<Readonly<{ index: LspLineIndex; changes: readonly LspTextChange[] }>> {
        if (!isLspUint(after.length)) throw new RangeError("Document exceeds LSP position limits.");
        if (after === this.buffer) return Object.freeze({ index: this, changes: emptyList });
        const planned = await spans(this.buffer, after, cooperate, hint), regions = []; let length = this.bare.length;
        for (const span of planned) {
            const start = lowerBound(this.bare, span.from), stop = lowerBound(this.bare, span.to), added = await scan(after, span.insertFrom, span.insertTo, cooperate);
            regions.push({ span, start, stop, added }); length += added.length - (stop - start);
            if (regions.length % 64 === 0) await cooperate();
        }
        const bare = new Uint32Array(length); let old = 0, output = 0, shift = 0, work = 0;
        const copy = async (end: number) => { while (old < end) { bare[output++] = this.bare[old++]! + shift; if (++work % chunkUnits === 0) await cooperate(); } };
        let copied = 0;
        for (const { span, start, stop, added } of regions) {
            await copy(start); bare.set(added, output); output += added.length; old = stop; shift = span.insertTo - span.to;
            if (++copied % 64 === 0) await cooperate();
        }
        await copy(this.bare.length);
        return Object.freeze({ index: new LspLineIndex(after, bare), changes: await wireChanges(this, after, planned, cooperate) });
    }
}
