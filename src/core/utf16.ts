export const highSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
export const lowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;
/** Whether a raw offset separates a valid surrogate pair; string edges never split one. */
export const splitsSurrogatePair = (text: string, offset: number): boolean => highSurrogate(text.charCodeAt(offset - 1)) && lowSurrogate(text.charCodeAt(offset));

/** A forwarded range or a caret in replacement text must keep these two-unit sequences together. */
export function splitsTextPair(source: { length: number; slice(from: number, to: number): string }, offset: number): boolean {
    if (offset <= 0 || offset >= source.length) return false;
    const pair = source.slice(offset - 1, offset + 1);
    return splitsTextPairAt(pair, 1);
}

export function splitsTextPairAt(text: string, offset: number): boolean {
    const left = text.charCodeAt(offset - 1), right = text.charCodeAt(offset);
    return left === 13 && right === 10 || highSurrogate(left) && lowSurrogate(right);
}

/** Clip only the display boundary. The caller's original range can contain arbitrary UTF-16. */
export function textExcerpt(
    source: { length: number; slice(from: number, to: number): string },
    limit: number,
    marker = "",
    from = 0,
    to = source.length,
): string {
    const sample = source.slice(from, Math.min(to, from + limit + 1));
    if (sample.length <= limit) return sample;
    const end = splitsTextPairAt(sample, limit) ? limit - 1 : limit;
    return sample.slice(0, end) + marker;
}

/** Read at most 256 units toward a validated bound, plus one in-range surrogate peek.
 * Raw range edges stay clipped. readUnits includes an unsuccessful peek as well. */
export function readUtf16Window(source: { slice(from: number, to: number): string }, start: number, bound: number, direction: -1 | 1 = 1): Readonly<{ from: number; to: number; text: string; readUnits: number }> {
    let from = direction < 0 ? Math.max(bound, start - 256) : start, to = direction < 0 ? start : Math.min(bound, start + 256);
    let text = source.slice(from, to), readUnits = text.length;
    if (direction > 0 && to < bound && highSurrogate(text.charCodeAt(text.length - 1))) {
        const next = source.slice(to, to + 1); readUnits++;
        if (lowSurrogate(next.charCodeAt(0))) { text += next; to++; }
    } else if (direction < 0 && from > bound && lowSurrogate(text.charCodeAt(0))) {
        const previous = source.slice(from - 1, from); readUnits++;
        if (highSurrogate(previous.charCodeAt(0))) { text = previous + text; from--; }
    }
    return { from, to, text, readUnits };
}
