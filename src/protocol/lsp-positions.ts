import type { TextBuffer } from "../core/text-buffer.ts";
import { ProjectChangeCursor } from "../core/buffer-change.ts";

export type LspPosition = Readonly<{ line: number; character: number }>;
export type LspRange = Readonly<{ start: LspPosition; end: LspPosition }>;
export type LspTextChange = Readonly<{ range: LspRange; text: string }>;
export type LspCooperate = () => Promise<void>;
const chunkUnits = 16384;
const uint = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff;
function lowerBound(values: Uint32Array, key: number): number {
    let low = 0, high = values.length; while (low < high) { const middle = (low + high) >>> 1; if (values[middle]! < key) low = middle + 1; else high = middle; } return low;
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

/** Reuses the buffer's LF index and retains only additional bare-CR positions. Source text is unchanged. */
export class LspLineIndex {
    readonly buffer: TextBuffer;
    private readonly bare: Uint32Array;
    private constructor(buffer: TextBuffer, bare: Uint32Array) { this.buffer = buffer; this.bare = bare; Object.freeze(this); }
    static async create(buffer: TextBuffer, cooperate: LspCooperate): Promise<LspLineIndex> {
        if (!uint(buffer.length)) throw new RangeError("Document exceeds LSP position limits.");
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
        if (!uint(offset) || offset > this.buffer.length || interior(this.buffer, offset)) throw new RangeError("Offset is outside text or inside a CRLF pair.");
        const line = this.buffer.lineAt(offset), cr = lowerBound(this.bare, offset), start = Math.max(this.buffer.offsetAt(line), cr ? this.bare[cr - 1]! + 1 : 0);
        return Object.freeze({ line: line + cr, character: offset - start });
    }
    offsetAt(position: LspPosition): number {
        if (!position || !uint(position.line) || !uint(position.character)) throw new RangeError("Invalid UTF-16 LSP position.");
        if (position.line >= this.lineCount) return this.buffer.length;
        const from = this.start(position.line); let to = this.buffer.length;
        if (position.line + 1 < this.lineCount) { const next = this.start(position.line + 1);
            to = next - (next >= 2 && this.buffer.slice(next - 2, next) === "\r\n" ? 2 : 1); }
        return Math.min(from + position.character, to);
    }
    /** A proven shared-edge replacement, expanded only enough to preserve newline/CR classification. */
    async change(after: TextBuffer, cooperate: LspCooperate): Promise<Readonly<{ index: LspLineIndex; changes: readonly LspTextChange[] }>> {
        if (!uint(after.length)) throw new RangeError("Document exceeds LSP position limits.");
        if (after === this.buffer) return Object.freeze({ index: this, changes: Object.freeze([]) });
        const cursor = new ProjectChangeCursor(this.buffer, after); let from = 0, to = 0, end = 0;
        try { for (;;) { const step = cursor.next(); if (step.done) {
                    const span = step.result!; from = Math.max(0, span.from - 1); to = Math.min(this.buffer.length, span.to + 1); end = span.insertTo + to - span.to; break;
                } await cooperate(); } } finally { cursor.dispose(); }
        if (interior(this.buffer, from) || interior(after, from)) from--;
        if (interior(this.buffer, to) || interior(after, end)) { to++; end++; }
        const start = lowerBound(this.bare, from), stop = lowerBound(this.bare, to), replacement = await scan(after, from, end, cooperate);
        const bare = new Uint32Array(start + replacement.length + this.bare.length - stop);
        for (let at = 0; at < start; at += chunkUnits) { bare.set(this.bare.subarray(at, Math.min(start, at + chunkUnits)), at); if (at + chunkUnits < start) await cooperate(); }
        bare.set(replacement, start);
        const shift = after.length - this.buffer.length;
        for (let i = stop; i < this.bare.length; i++) { bare[start + replacement.length + i - stop] = this.bare[i]! + shift; if ((i - stop + 1) % chunkUnits === 0) await cooperate(); }
        const change = Object.freeze({ range: Object.freeze({ start: this.at(from), end: this.at(to) }), text: after.slice(from, end) });
        return Object.freeze({ index: new LspLineIndex(after, bare), changes: Object.freeze([change]) });
    }
}
