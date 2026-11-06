export const highSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
export const lowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;
/** Internal bounded window reader. A clipped trailing high surrogate stays a raw code unit. */
export function utf16CodePointAt(text: string, index: number): number {
    const first = text.charCodeAt(index);
    if (!highSurrogate(first) || index + 1 >= text.length) return first;
    const second = text.charCodeAt(index + 1); return lowSurrogate(second) ? 0x10000 + (first - 0xd800) * 1024 + second - 0xdc00 : first;
}
