/** Internal bounded views over privately owned font bytes. No view is exposed by the public API. */
export class FontReader {
    readonly view: DataView;
    readonly data: Uint8Array;
    readonly start: number;
    readonly length: number;
    constructor(data: Uint8Array, start = 0, length = data.length - start) { this.data = data; this.start = start; this.length = length; this.view = new DataView(data.buffer, data.byteOffset + start, length); }
    span(offset: number, length: number): void { if (![offset, length].every(Number.isSafeInteger) || offset < 0 || length < 0 || offset + length > this.length) throw new RangeError("Truncated font data."); }
    u8(offset: number): number { this.span(offset, 1); return this.view.getUint8(offset); }
    i8(offset: number): number { this.span(offset, 1); return this.view.getInt8(offset); }
    u16(offset: number): number { this.span(offset, 2); return this.view.getUint16(offset); }
    i16(offset: number): number { this.span(offset, 2); return this.view.getInt16(offset); }
    u24(offset: number): number { return this.u8(offset) * 65536 + this.u16(offset + 1); }
    u32(offset: number): number { this.span(offset, 4); return this.view.getUint32(offset); }
    i32(offset: number): number { this.span(offset, 4); return this.view.getInt32(offset); }
    sub(offset: number, length: number): FontReader { this.span(offset, length); return new FontReader(this.data, this.start + offset, length); }
    tail(offset: number): FontReader { return this.sub(offset, this.length - offset); }
    tag(offset: number): string { return String.fromCharCode(this.u8(offset), this.u8(offset + 1), this.u8(offset + 2), this.u8(offset + 3)); }
}
export const invalidFont = (message: string): never => { throw new RangeError(`Invalid font: ${message}`); };
export function fontSearch(count: number, end: (index: number) => number, code: number): number {
    let low = 0, high = count; while (low < high) { const mid = Math.floor((low + high) / 2); if (end(mid) < code) low = mid + 1; else high = mid; } return low;
}
