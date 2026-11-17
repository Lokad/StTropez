/** First false index in [0, length). Requires a nonnegative safe integer length and a true-prefix predicate. */
export function partitionPoint(length: number, before: (index: number) => boolean): number {
    const wide = length > 0x80000000;
    let low = 0, high = length;
    while (low < high) {
        // The narrow sum cannot overflow uint32; wider virtual domains retain safe arithmetic.
        const middle = wide ? low + Math.floor((high - low) / 2) : (low + high) >>> 1;
        if (before(middle)) low = middle + 1; else high = middle;
    }
    return low;
}
